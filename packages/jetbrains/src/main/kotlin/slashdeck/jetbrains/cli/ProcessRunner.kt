package slashdeck.jetbrains.cli

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.coroutines.cancellation.CancellationException

/** How an external process ended. */
sealed interface ProcessOutcome {
    data class Exited(val exitCode: Int, val stdout: String, val stderr: String) : ProcessOutcome

    /** Killed (with its child processes) after [timeoutMs]. */
    data class TimedOut(val timeoutMs: Long, val stderr: String) : ProcessOutcome

    /** The executable could not be started (missing, not executable...). */
    data class FailedToStart(val message: String) : ProcessOutcome
}

data class ProcessSpec(
    val command: List<String>,
    /** The complete environment of the process (not added to the IDE's). */
    val environment: Map<String, String>,
    val workingDirectory: File? = null,
    /** Written to stdin, which is then closed; null closes stdin at once. */
    val stdin: String? = null,
    val timeoutMs: Long,
)

/**
 * Runs a process off the calling thread, with a timeout, and kills it together with its child
 * processes (the CLI starts `claude`) when the coroutine is cancelled or the timeout expires.
 * Output is decoded as UTF-8, which is what Node writes to pipes.
 */
open class ProcessRunner {
    open suspend fun run(spec: ProcessSpec): ProcessOutcome = withContext(Dispatchers.IO) {
        val builder = ProcessBuilder(spec.command)
        spec.workingDirectory?.let { builder.directory(it) }
        builder.environment().apply {
            clear()
            putAll(spec.environment)
        }
        val process = try {
            builder.start()
        } catch (e: IOException) {
            return@withContext ProcessOutcome.FailedToStart(e.message ?: e.toString())
        }
        val stdout = ByteArrayOutputStream()
        val stderr = ByteArrayOutputStream()
        val readers = listOf(
            pump(process.inputStream, stdout, "slashdeck-stdout"),
            pump(process.errorStream, stderr, "slashdeck-stderr"),
        )
        try {
            try {
                process.outputStream.use { out -> spec.stdin?.let { out.write(it.toByteArray(Charsets.UTF_8)) } }
            } catch (_: IOException) {
                // The process exited without reading stdin: its exit code says why.
            }
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(spec.timeoutMs)
            while (!process.waitFor(POLL_MS, TimeUnit.MILLISECONDS)) {
                currentCoroutineContext().ensureActive()
                if (System.nanoTime() > deadline) {
                    killTree(process)
                    readers.forEach { it.join(READER_JOIN_MS) }
                    return@withContext ProcessOutcome.TimedOut(spec.timeoutMs, text(stderr))
                }
            }
            readers.forEach { it.join(READER_JOIN_MS) }
            ProcessOutcome.Exited(process.exitValue(), text(stdout), text(stderr))
        } catch (e: CancellationException) {
            killTree(process)
            throw e
        } catch (e: InterruptedException) {
            killTree(process)
            throw CancellationException("interrupted").apply { initCause(e) }
        }
    }

    private fun pump(input: InputStream, target: ByteArrayOutputStream, name: String): Thread =
        thread(name = name, isDaemon = true) {
            try {
                input.use { it.copyTo(target) }
            } catch (_: IOException) {
                // Stream closed because the process was killed.
            }
        }

    private fun text(buffer: ByteArrayOutputStream): String =
        synchronized(buffer) { buffer.toString(Charsets.UTF_8) }

    companion object {
        private const val POLL_MS = 50L
        private const val READER_JOIN_MS = 2_000L

        /** Kills the process and every process it started. */
        fun killTree(process: Process) {
            try {
                process.toHandle().descendants().forEach { it.destroyForcibly() }
            } catch (_: Exception) {
                // Not permitted or already gone.
            }
            process.destroyForcibly()
        }
    }
}

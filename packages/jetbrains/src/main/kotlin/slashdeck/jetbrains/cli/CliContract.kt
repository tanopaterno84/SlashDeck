package slashdeck.jetbrains.cli

import slashdeck.jetbrains.model.CliOutputException

/** Exit codes of the `slashdeck` CLI (packages/core/src/cli.ts, CLAUDE.md "packages/core"). */
object CliExit {
    const val OK = 0
    const val ERROR = 1
    const val USAGE = 2
    const val NO_CACHE = 3
    const val NOT_IN_CATALOG = 4
}

enum class FailureKind {
    /** Exit 1: the CLI failed (unreadable state file, workspace not a folder...). */
    ERROR,

    /** Exit 2: the plugin called the CLI wrongly (or an edit was rejected). */
    USAGE,

    /** The CLI did not finish in time and was stopped. */
    TIMEOUT,

    /** Node could not be started. */
    START_FAILED,

    /** Exit 0 but stdout is not the expected JSON. */
    BAD_OUTPUT,

    /** Any other exit code: Node crashed, or the process was killed. */
    UNEXPECTED_EXIT,
}

sealed interface CliResult<out T> {
    data class Success<T>(val value: T) : CliResult<T>

    /** Exit 3: no cache for the workspace yet (run `scan`). */
    data class NoCache(val message: String) : CliResult<Nothing>

    /** Exit 4: the command is not in the cached catalog. */
    data class NotInCatalog(val message: String) : CliResult<Nothing>

    data class Failure(val kind: FailureKind, val message: String) : CliResult<Nothing>
}

object CliContract {
    private const val PREFIX = "slashdeck: "
    private const val MAX_MESSAGE_CHARS = 600

    /**
     * Maps a finished CLI process to a result. On success stdout holds the JSON; on failure
     * stdout is empty and the reason is on stderr.
     */
    fun <T> interpret(outcome: ProcessOutcome, parse: (String) -> T): CliResult<T> = when (outcome) {
        is ProcessOutcome.FailedToStart -> CliResult.Failure(FailureKind.START_FAILED, outcome.message)
        is ProcessOutcome.TimedOut -> CliResult.Failure(
            FailureKind.TIMEOUT,
            "no answer within ${outcome.timeoutMs / 1000} s",
        )
        is ProcessOutcome.Exited -> {
            val reason = reason(outcome.stderr)
            when (outcome.exitCode) {
                CliExit.OK -> try {
                    CliResult.Success(parse(outcome.stdout))
                } catch (e: CliOutputException) {
                    CliResult.Failure(FailureKind.BAD_OUTPUT, e.message ?: "unexpected output")
                }
                CliExit.ERROR -> CliResult.Failure(FailureKind.ERROR, reason)
                CliExit.USAGE -> CliResult.Failure(FailureKind.USAGE, reason)
                CliExit.NO_CACHE -> CliResult.NoCache(reason)
                CliExit.NOT_IN_CATALOG -> CliResult.NotInCatalog(reason)
                else -> CliResult.Failure(
                    FailureKind.UNEXPECTED_EXIT,
                    "exit code ${outcome.exitCode}" + if (reason.isEmpty()) "" else ": $reason",
                )
            }
        }
    }

    /** The first lines of stderr, without the "slashdeck: " prefix and without the usage text. */
    fun reason(stderr: String): String {
        val lines = stderr.lineSequence()
            .map { it.trim() }
            .takeWhile { !it.startsWith("Usage:") }
            .filter { it.isNotEmpty() }
            .map { it.removePrefix(PREFIX) }
            .toList()
        val text = lines.joinToString(" ")
        return if (text.length <= MAX_MESSAGE_CHARS) text else text.take(MAX_MESSAGE_CHARS - 3) + "..."
    }
}

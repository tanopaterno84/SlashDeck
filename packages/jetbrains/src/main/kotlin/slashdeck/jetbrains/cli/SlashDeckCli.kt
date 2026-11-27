package slashdeck.jetbrains.cli

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import slashdeck.jetbrains.model.ResolvedView
import slashdeck.jetbrains.model.ViewParser
import slashdeck.jetbrains.model.WriteResult
import java.io.File

/**
 * The `slashdeck` CLI bundled with the plugin, run as `node slashdeck.mjs <command> --json`.
 * Every call is a separate process; the plugin keeps no state of its own.
 */
class SlashDeckCli(
    private val nodePath: String,
    private val script: File,
    private val environment: Map<String, String>,
    private val runner: ProcessRunner = ProcessRunner(),
    /** Claude Code executable from the settings; null lets the CLI look on the PATH. */
    private val claudePath: String? = null,
    private val timeouts: Timeouts = Timeouts(),
) {
    data class Timeouts(
        /** `scan --cached` and the writes only read and write small JSON files. */
        val quickMs: Long = 30_000,
        /** `scan` starts Claude Code, which the core itself gives 15 s. */
        val scanMs: Long = 90_000,
    )

    /** The resolved view of the last cache, without calling Claude Code. */
    suspend fun scanCached(workspace: String): CliResult<ResolvedView> =
        call(listOf("scan", "--cached"), workspace, timeouts.quickMs, parse = ViewParser::parseView)

    /** Scans (starts Claude Code), updates the cache, returns the resolved view. */
    suspend fun scan(workspace: String): CliResult<ResolvedView> {
        val claude = claudePath?.trim().orEmpty()
        val extra = if (claude.isEmpty()) emptyList() else listOf("--claude-path", claude)
        return call(listOf("scan") + extra, workspace, timeouts.scanMs, parse = ViewParser::parseView)
    }

    suspend fun pin(workspace: String, command: String) = write("pin", workspace, command)

    suspend fun unpin(workspace: String, command: String) = write("unpin", workspace, command)

    suspend fun reset(workspace: String, command: String) = write("reset", workspace, command)

    /** Sets the user's description; null removes the user's own value. */
    suspend fun editDescription(workspace: String, command: String, value: String?) =
        write("edit", workspace, command, stdin = JsonObject(mapOf("description" to jsonText(value))).toString())

    /** Sets the user's "when to use" text; null removes the user's own value. */
    suspend fun editWhenToUse(workspace: String, command: String, value: String?) =
        write(
            "edit",
            workspace,
            command,
            stdin = JsonObject(mapOf("guide" to JsonObject(mapOf("whenToUse" to jsonText(value))))).toString(),
        )

    private fun jsonText(value: String?) = if (value == null) JsonNull else JsonPrimitive(value)

    private suspend fun write(
        action: String,
        workspace: String,
        command: String,
        stdin: String? = null,
    ): CliResult<WriteResult> =
        call(listOf(action, command), workspace, timeouts.quickMs, stdin, ViewParser::parseWriteResult)

    /** The full command line, for tests and logs. */
    fun commandLine(args: List<String>, workspace: String): List<String> =
        listOf(nodePath, script.path) + args + listOf("--json", "--quiet", "--workspace", workspace)

    private suspend fun <T> call(
        args: List<String>,
        workspace: String,
        timeoutMs: Long,
        stdin: String? = null,
        parse: (String) -> T,
    ): CliResult<T> {
        val outcome = runner.run(
            ProcessSpec(
                command = commandLine(args, workspace),
                environment = environment,
                workingDirectory = File(workspace).takeIf { it.isDirectory },
                stdin = stdin,
                timeoutMs = timeoutMs,
            ),
        )
        return CliContract.interpret(outcome, parse)
    }
}

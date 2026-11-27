package slashdeck.jetbrains.cli

import java.io.File

/** Where the Node.js executable was found. */
enum class NodeSource { SETTINGS, IDE, PATH }

sealed interface NodeLookup {
    data class Found(val path: String, val source: NodeSource) : NodeLookup

    /** The path set in the SlashDeck settings is not a file. It is not silently replaced. */
    data class SettingsPathInvalid(val path: String) : NodeLookup

    /** Nothing set, no usable IDE interpreter, and no `node` on the PATH. */
    data object NotFound : NodeLookup
}

data class NodeVersion(val major: Int, val minor: Int, val patch: Int) {
    override fun toString(): String = "$major.$minor.$patch"
}

/** The outcome of checking Node: what the tool window shows before anything else. */
sealed interface NodeStatus {
    data class Ready(val path: String, val version: NodeVersion, val source: NodeSource) : NodeStatus

    data class Missing(val lookup: NodeLookup) : NodeStatus

    data class TooOld(val path: String, val version: NodeVersion, val source: NodeSource) : NodeStatus

    /** The executable exists but `node --version` failed or printed something unexpected. */
    data class Unusable(val path: String, val source: NodeSource, val reason: String) : NodeStatus
}

/**
 * Finds Node.js, in this order:
 * 1. the path in the SlashDeck settings;
 * 2. the Node.js interpreter configured in the IDE (only with the JavaScript plugin, only a
 *    local interpreter, and only if enabled in the settings);
 * 3. `node` on the PATH.
 */
object NodeLocator {
    /** The bundled CLI is built for Node 20 (packages/core/build.mjs, `target: node20`). */
    const val MIN_MAJOR = 20

    fun locate(
        settingsPath: String?,
        ideInterpreterPath: String?,
        pathEnv: String?,
        isWindows: Boolean,
        isFile: (String) -> Boolean = { File(it).isFile },
    ): NodeLookup {
        val configured = settingsPath?.trim()?.removeSurrounding("\"").orEmpty()
        if (configured.isNotEmpty()) {
            return if (isFile(configured)) NodeLookup.Found(configured, NodeSource.SETTINGS)
            else NodeLookup.SettingsPathInvalid(configured)
        }
        val ide = ideInterpreterPath?.trim().orEmpty()
        if (ide.isNotEmpty() && isFile(ide)) return NodeLookup.Found(ide, NodeSource.IDE)
        return findOnPath(pathEnv, isWindows, isFile)?.let { NodeLookup.Found(it, NodeSource.PATH) }
            ?: NodeLookup.NotFound
    }

    fun findOnPath(pathEnv: String?, isWindows: Boolean, isFile: (String) -> Boolean): String? {
        val separator = if (isWindows) ';' else ':'
        val name = if (isWindows) "node.exe" else "node"
        return (pathEnv ?: "").split(separator)
            .map { it.trim().removeSurrounding("\"") }
            .filter { it.isNotEmpty() }
            .map { dir -> joinPath(dir, name, isWindows) }
            .firstOrNull(isFile)
    }

    private fun joinPath(dir: String, name: String, isWindows: Boolean): String {
        val sep = if (isWindows) '\\' else '/'
        return if (dir.endsWith('/') || dir.endsWith('\\')) dir + name else dir + sep + name
    }

    private val VERSION = Regex("""^v?(\d+)\.(\d+)\.(\d+)""")

    /** Parses the output of `node --version` ("v24.15.0"). */
    fun parseVersion(output: String): NodeVersion? {
        val match = VERSION.find(output.trim()) ?: return null
        val (major, minor, patch) = match.destructured
        return NodeVersion(major.toInt(), minor.toInt(), patch.toInt())
    }

    /** Runs `node --version` and decides whether this Node can run the CLI. */
    suspend fun check(found: NodeLookup.Found, runner: ProcessRunner, environment: Map<String, String>): NodeStatus {
        val outcome = runner.run(
            ProcessSpec(
                command = listOf(found.path, "--version"),
                environment = environment,
                timeoutMs = VERSION_TIMEOUT_MS,
            ),
        )
        return statusOf(found, outcome)
    }

    fun statusOf(found: NodeLookup.Found, outcome: ProcessOutcome): NodeStatus = when (outcome) {
        is ProcessOutcome.FailedToStart -> NodeStatus.Unusable(found.path, found.source, outcome.message)
        is ProcessOutcome.TimedOut -> NodeStatus.Unusable(found.path, found.source, "no answer to --version")
        is ProcessOutcome.Exited -> {
            val version = if (outcome.exitCode == 0) parseVersion(outcome.stdout) else null
            when {
                version == null -> NodeStatus.Unusable(
                    found.path,
                    found.source,
                    "--version printed \"${outcome.stdout.trim().take(80)}\" (exit code ${outcome.exitCode})",
                )
                version.major < MIN_MAJOR -> NodeStatus.TooOld(found.path, version, found.source)
                else -> NodeStatus.Ready(found.path, version, found.source)
            }
        }
    }

    private const val VERSION_TIMEOUT_MS = 10_000L
}

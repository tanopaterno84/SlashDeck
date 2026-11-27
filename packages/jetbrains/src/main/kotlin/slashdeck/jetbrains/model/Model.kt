package slashdeck.jetbrains.model

/**
 * The resolved view printed by `slashdeck scan --json` / `scan --cached` (CLAUDE.md, "Vista
 * risolta"), and the uniform result of the write commands. Plain data: every rule that
 * produces these values lives in the core.
 */
data class ScanWarning(val code: String, val message: String)

data class Guide(
    val whenToUse: String? = null,
    val example: String? = null,
    val related: List<String>? = null,
)

data class CommandEntry(
    /** With the leading "/", namespace included (`/gxrr:wiki`). */
    val name: String,
    /** builtin | custom-user | custom-project | skill-user | skill-synced | skill-project | plugin | unknown */
    val kind: String,
    val plugin: String? = null,
    val sourcePath: String? = null,
    val hash: String = "",
    /** Stable category ID (`project`, `plugin:<name>`, `context`...), never a label. */
    val category: String,
    val description: String? = null,
    val argumentHint: String? = null,
    val guide: Guide? = null,
    /** Field → origin; guide fields use dotted keys (`guide.whenToUse`). */
    val origins: Map<String, String> = emptyMap(),
    val pinned: Boolean = false,
    val isNew: Boolean = false,
    val firstSeenAt: String? = null,
) {
    /** The user has edited at least one text of the command ("Reset my edits" applies). */
    val hasUserEdits: Boolean get() = origins.values.any { it == ORIGIN_USER_EDIT }

    /** The command declares arguments: "Run" types it without pressing Enter. */
    val takesArguments: Boolean get() = !argumentHint.isNullOrBlank()

    companion object {
        const val ORIGIN_USER_EDIT = "user-edit"
    }
}

data class ResolvedView(
    val schemaVersion: Int,
    val claudeCodeVersion: String?,
    /** `cli`, or `files` when Claude Code did not answer (fallback: no built-in commands). */
    val source: String,
    val workspace: String,
    val workspaceId: String,
    val scannedAt: String,
    val warnings: List<ScanWarning>,
    /** Category IDs present in [commands], in display order, as computed by the core. */
    val categoryOrder: List<String>,
    /** In the order of the JSON object. */
    val commands: List<CommandEntry>,
) {
    val isFallback: Boolean get() = source == SOURCE_FILES

    fun command(name: String): CommandEntry? = commands.firstOrNull { it.name == name }

    /** The same view with one entry replaced by the one a write returned. */
    fun withEntry(entry: CommandEntry): ResolvedView =
        copy(commands = commands.map { if (it.name == entry.name) entry else it })

    companion object {
        const val SOURCE_FILES = "files"
    }
}

/** `{ action, command, workspaceId, changed, scope, entry }`, printed by pin, unpin, edit, reset. */
data class WriteResult(
    val action: String,
    val command: String?,
    val workspaceId: String?,
    val changed: Boolean,
    val scope: String,
    val entry: CommandEntry?,
)

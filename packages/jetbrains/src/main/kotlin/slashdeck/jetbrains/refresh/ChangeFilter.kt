package slashdeck.jetbrains.refresh

/** What a file change asks for. */
enum class ChangeEffect {
    /** A command or skill may have been added, changed or removed: `scan`. */
    SCAN,

    /** Only the team override changed: `scan --cached` is enough (no Claude Code). */
    RELOAD,
}

/**
 * Decides which file changes refresh the list. Only files that define commands count:
 * any `.md` file under `<project>/.claude/commands/`, `<project>/.claude/skills/<name>/SKILL.md`, the folders
 * that hold them (added, removed or renamed), and `<project>/.claude/slashdeck.json`.
 *
 * Nothing else is watched, and in particular nothing a scan can cause: starting `claude`
 * rewrites bookkeeping files (dot-files and dot-folders, manifests) under the user's Claude
 * folder, which is not watched at all, and any path with a segment starting with "." below
 * `.claude/` is ignored. A scan therefore can never trigger the next one.
 */
object ChangeFilter {
    private const val TEAM_OVERRIDE = "slashdeck.json"
    private const val COMMANDS = "commands"
    private const val SKILLS = "skills"
    private const val SKILL_FILE = "SKILL.md"

    fun classify(projectDir: String, path: String, isDirectory: Boolean, ignoreCase: Boolean): ChangeEffect? {
        val base = normalize(projectDir).trimEnd('/') + "/.claude"
        val file = normalize(path).trimEnd('/')
        if (file.equals(base, ignoreCase)) return if (isDirectory) ChangeEffect.SCAN else null
        if (!file.startsWith("$base/", ignoreCase)) return null
        val segments = file.substring(base.length + 1).split('/')
        if (segments.any { it.isEmpty() || it.startsWith(".") }) return null

        val top = segments.first()
        if (segments.size == 1 && top.equals(TEAM_OVERRIDE, ignoreCase) && !isDirectory) return ChangeEffect.RELOAD
        val inCommands = top.equals(COMMANDS, ignoreCase)
        val inSkills = top.equals(SKILLS, ignoreCase)
        if (!inCommands && !inSkills) return null
        if (isDirectory) return ChangeEffect.SCAN
        val name = segments.last()
        return when {
            segments.size == 1 -> null
            inCommands && name.endsWith(".md", ignoreCase = true) -> ChangeEffect.SCAN
            inSkills && name.equals(SKILL_FILE, ignoreCase = true) -> ChangeEffect.SCAN
            else -> null
        }
    }

    private fun normalize(path: String) = path.replace('\\', '/')
}

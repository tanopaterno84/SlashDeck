package slashdeck.jetbrains.terminal

/**
 * Whether a shell command line starts an interactive Claude Code session. Same rules as the
 * VS Code extension (packages/vscode/src/terminals.ts): `claude`, `claude -c`,
 * `claude "fix the build"`, `& "C:\...\claude.exe" --resume`, `cd app && claude`,
 * `npx @anthropic-ai/claude-code`. Not: `claude -p ...`, `claude mcp list`, `claude --version`,
 * `echo x | claude` (piped: print mode).
 */
object ClaudeCommandLine {
    /** `claude <subcommand>` runs a management command, not a session. */
    private val SUBCOMMANDS = setOf(
        "auth", "config", "doctor", "install", "login", "logout", "mcp", "migrate-installer",
        "plugin", "plugins", "setup-token", "update", "upgrade",
    )

    /** Options that make `claude` print something and exit instead of starting a session. */
    private val NON_INTERACTIVE_OPTIONS = setOf("-p", "--print", "-v", "--version", "-h", "--help")

    private val RUNNERS = setOf("npx", "bunx", "pnpx")
    private val RUNNER_SUBCOMMANDS = setOf("dlx", "exec", "x")
    private val PACKAGE_MANAGERS = setOf("pnpm", "yarn", "npm", "bun")
    private val CLAUDE_PACKAGE = Regex("""^@anthropic-ai/claude-code(@.*)?$""")

    /** Prefixes that run the following command: PowerShell's `&`, `env`, `exec`... */
    private val PREFIXES = setOf("&", "exec", "command", "env", "time", "nohup", "noglob", "builtin")
    private val ENV_ASSIGNMENT = Regex("""^[A-Za-z_][A-Za-z0-9_]*=""")

    data class Segment(val tokens: List<String>, val piped: Boolean)

    /** Splits a command line into the segments of a `;`, `&&`, `||` chain; quotes are honoured. */
    fun split(commandLine: String): List<Segment> {
        val segments = mutableListOf<Segment>()
        var tokens = mutableListOf<String>()
        var piped = false
        val current = StringBuilder()
        var inToken = false
        var quote: Char? = null

        fun endToken() {
            if (inToken) tokens.add(current.toString())
            current.setLength(0)
            inToken = false
        }

        fun endSegment() {
            endToken()
            if (tokens.isNotEmpty()) segments.add(Segment(tokens, piped))
            tokens = mutableListOf()
            piped = false
        }

        var i = 0
        while (i < commandLine.length) {
            val c = commandLine[i]
            val next = commandLine.getOrNull(i + 1)
            when {
                quote != null -> if (c == quote) quote = null else current.append(c)
                c == '"' || c == '\'' -> {
                    quote = c
                    inToken = true
                }
                c == ';' || c == '\n' || c == '\r' -> endSegment()
                (c == '&' && next == '&') || (c == '|' && next == '|') -> {
                    endSegment()
                    i++
                }
                c == '|' -> {
                    endToken()
                    piped = true
                }
                c.isWhitespace() -> endToken()
                else -> {
                    current.append(c)
                    inToken = true
                }
            }
            i++
        }
        endSegment()
        return segments
    }

    private fun programName(token: String): String =
        token.split('\\', '/').last().lowercase().replace(Regex("""\.(exe|cmd|bat|ps1)$"""), "")

    /** Arguments given to `claude` by a segment, or null when the segment does not run it. */
    private fun claudeArguments(tokens: List<String>): List<String>? {
        var i = 0
        while (i < tokens.size && (tokens[i] in PREFIXES || ENV_ASSIGNMENT.containsMatchIn(tokens[i]))) i++
        val program = tokens.getOrNull(i) ?: return null
        val name = programName(program)
        if (name == "claude") return tokens.drop(i + 1)

        var rest = tokens.drop(i + 1)
        if (name in PACKAGE_MANAGERS) {
            if (rest.firstOrNull() !in RUNNER_SUBCOMMANDS) return null
            rest = rest.drop(1)
        } else if (name !in RUNNERS) {
            return null
        }
        val pkg = rest.indexOfFirst { CLAUDE_PACKAGE.matches(it) }
        return if (pkg == -1) null else rest.drop(pkg + 1)
    }

    fun isInteractiveClaude(commandLine: String): Boolean {
        val last = split(commandLine).lastOrNull() ?: return false
        if (last.piped) return false
        val args = claudeArguments(last.tokens) ?: return false
        if (args.any { it in NON_INTERACTIVE_OPTIONS || it.startsWith("--print=") }) return false
        val first = args.firstOrNull() ?: return true
        return first.startsWith("-") || first.lowercase() !in SUBCOMMANDS
    }
}

/** What "Run" types: with arguments, the name and a space, without Enter. */
data class RunPlan(val text: String, val submit: Boolean) {
    companion object {
        fun of(name: String, argumentHint: String?): RunPlan =
            if (argumentHint.isNullOrBlank()) RunPlan(name, submit = true) else RunPlan("$name ", submit = false)
    }
}

package slashdeck.jetbrains.terminal

import com.intellij.openapi.diagnostic.ControlFlowException
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.project.Project

/** A terminal tab in which an interactive `claude` session is running now. */
interface ClaudeTerminal {
    /** Tab title, shown when the user has to choose between several. */
    val title: String

    /** The tab currently selected in the Terminal tool window. */
    val isSelected: Boolean

    /** Checked again just before typing: Claude Code may have exited meanwhile. */
    fun isStillRunningClaude(): Boolean

    /** Types [text] into the session; with [submit], presses Enter afterwards. Call on the EDT. */
    suspend fun type(text: String, submit: Boolean)

    /** Shows the Terminal tool window with this tab selected and focused. */
    fun focus()
}

/**
 * Finds the terminals running Claude Code. Implemented only in slashdeck-terminal.xml, which is
 * loaded when the Terminal plugin is present: without it, there is no "Run".
 */
interface ClaudeTerminalProvider {
    /** Call on the EDT. Never creates a terminal. */
    fun claudeTerminals(project: Project): List<ClaudeTerminal>

    companion object {
        val EP_NAME = ExtensionPointName.create<ClaudeTerminalProvider>("slashdeck.placeholder.claudeTerminalProvider")

        private val LOG = logger<ClaudeTerminalProvider>()

        /** Terminals running Claude Code; empty when the terminal integration is unavailable. */
        fun find(project: Project): List<ClaudeTerminal> =
            EP_NAME.extensionList.flatMap { provider ->
                try {
                    provider.claudeTerminals(project)
                } catch (e: LinkageError) {
                    // The experimental terminal API changed in this IDE version: no "Run".
                    LOG.warn("terminal integration unavailable", e)
                    emptyList()
                } catch (e: RuntimeException) {
                    if (e is ControlFlowException) throw e
                    LOG.warn("terminal integration failed", e)
                    emptyList()
                }
            }

        /** The terminal to send to: the selected one, else the only one; null when the user must choose. */
        fun pick(candidates: List<ClaudeTerminal>): ClaudeTerminal? =
            candidates.firstOrNull { it.isSelected } ?: candidates.singleOrNull()
    }
}

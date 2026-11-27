package slashdeck.jetbrains.terminal

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTab
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTabsManager
import com.intellij.terminal.frontend.view.TerminalView
import com.intellij.terminal.frontend.view.TerminalViewSessionState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalCommandBlock
import org.jetbrains.plugins.terminal.view.shellIntegration.TerminalOutputStatus

/**
 * Detection of Claude Code in the tabs of the reworked terminal (the default since 2025.2),
 * through its shell integration API (experimental, since 2025.3). A tab counts as a Claude
 * terminal only when all of these hold:
 * - its session is running;
 * - its shell integration is active (Bash, Zsh or PowerShell with "Shell integration" on);
 * - the shell reports that a command is executing, and the active command block is that
 *   command, not finished yet;
 * - the command line of that block starts an interactive `claude` ([ClaudeCommandLine]).
 * Tab titles are never used: a false positive would send "/init" to a plain shell.
 *
 * Tabs of the Classic terminal engine are not listed by this API, so they never count.
 */
class ReworkedTerminalProvider : ClaudeTerminalProvider {
    override fun claudeTerminals(project: Project): List<ClaudeTerminal> {
        // Never instantiate the terminal service (or the tool window) just to look:
        // no terminal tab open means no Claude terminal.
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TERMINAL_TOOL_WINDOW_ID) ?: return emptyList()
        val contents = toolWindow.contentManagerIfCreated ?: return emptyList()
        if (contents.contentCount == 0) return emptyList()
        return TerminalToolWindowTabsManager.getInstance(project).tabs
            .filter { runningClaudeCommand(it.view) != null }
            .map { ReworkedClaudeTerminal(project, it) }
    }

    private class ReworkedClaudeTerminal(
        private val project: Project,
        private val tab: TerminalToolWindowTab,
    ) : ClaudeTerminal {
        override val title: String get() = tab.content.displayName ?: tab.content.tabName ?: ""

        override val isSelected: Boolean get() = tab.content.manager?.selectedContent == tab.content

        override fun isStillRunningClaude(): Boolean =
            TerminalToolWindowTabsManager.getInstance(project).tabs.any { it === tab } &&
                runningClaudeCommand(tab.view) != null

        override suspend fun type(text: String, submit: Boolean) {
            val view = tab.view
            view.sendText(text)
            if (!submit) return
            // A separate Enter, after a pause, so that Claude Code reads it as a key press and
            // not as part of pasted text (same as the VS Code extension).
            delay(SUBMIT_DELAY_MS)
            if (isStillRunningClaude()) view.sendText("\r")
        }

        override fun focus() {
            val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TERMINAL_TOOL_WINDOW_ID) ?: return
            toolWindow.activate({ tab.content.manager?.setSelectedContent(tab.content, true) }, true)
        }
    }

    companion object {
        /** `TerminalToolWindowFactory.TOOL_WINDOW_ID`. */
        const val TERMINAL_TOOL_WINDOW_ID = "Terminal"
        private const val SUBMIT_DELAY_MS = 150L

        /** The command line of the interactive `claude` running in [view], or null. */
        @OptIn(ExperimentalCoroutinesApi::class)
        fun runningClaudeCommand(view: TerminalView): String? {
            if (view.sessionState.value != TerminalViewSessionState.Running) return null
            val deferred = view.shellIntegrationDeferred
            if (!deferred.isCompleted || deferred.isCancelled) return null
            val integration = try {
                deferred.getCompleted()
            } catch (_: Exception) {
                return null // shell integration failed to start
            }
            if (integration.outputStatus.value != TerminalOutputStatus.ExecutingCommand) return null
            val block = integration.blocksModel.activeBlock as? TerminalCommandBlock ?: return null
            if (block.exitCode != null) return null
            val command = block.executedCommand ?: return null
            return command.takeIf { ClaudeCommandLine.isInteractiveClaude(it) }
        }
    }
}

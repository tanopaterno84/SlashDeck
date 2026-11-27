package slashdeck.jetbrains.toolwindow

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.vfs.LocalFileSystem
import slashdeck.jetbrains.SlashDeckBundle.message
import slashdeck.jetbrains.model.CommandEntry
import slashdeck.jetbrains.service.SlashDeckProjectService
import slashdeck.jetbrains.settings.SlashDeckConfigurable
import slashdeck.jetbrains.terminal.ClaudeTerminal
import slashdeck.jetbrains.terminal.ClaudeTerminalProvider
import slashdeck.jetbrains.terminal.RunPlan
import java.awt.datatransfer.StringSelection
import java.io.File
import java.util.function.Supplier
import javax.swing.Icon

/** The command selected in the SlashDeck tree. */
val SELECTED_COMMAND: DataKey<CommandEntry> = DataKey.create("slashdeck.selectedCommand")

/** Base of the actions on the selected command. All run on the EDT (terminal API, Swing). */
abstract class CommandAction(text: Supplier<String>, icon: Icon? = null) :
    DumbAwareAction(text, icon) {
    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val entry = e.getData(SELECTED_COMMAND)
        val project = e.project
        e.presentation.isEnabledAndVisible = entry != null && project != null && isAvailable(project, entry)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val entry = e.getData(SELECTED_COMMAND) ?: return
        val project = e.project ?: return
        perform(project, SlashDeckProjectService.getInstance(project), entry)
    }

    open fun isAvailable(project: Project, entry: CommandEntry): Boolean = true

    abstract fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry)
}

object CommandOps {
    fun copy(service: SlashDeckProjectService, entry: CommandEntry, notice: String = message("notice.copied", entry.name)) {
        CopyPasteManager.getInstance().setContents(StringSelection(entry.name))
        service.notify(notice)
    }

    /**
     * Types the command into a terminal where Claude Code runs. Never creates a terminal (it
     * would be a new Claude Code session); without one the command is copied instead.
     */
    fun run(project: Project, service: SlashDeckProjectService, entry: CommandEntry) {
        val terminals = ClaudeTerminalProvider.find(project)
        if (terminals.isEmpty()) {
            copy(service, entry, message("notice.noTerminalCopied", entry.name))
            return
        }
        val chosen = ClaudeTerminalProvider.pick(terminals)
        if (chosen != null) {
            sendTo(service, chosen, entry)
            return
        }
        val step = object : BaseListPopupStep<ClaudeTerminal>(message("run.chooseTerminal"), terminals) {
            // A terminal title is set by the shell: never let a label read it as HTML.
            override fun getTextFor(value: ClaudeTerminal): String =
                value.title.let { if (it.startsWith("<")) " $it" else it }

            override fun onChosen(selectedValue: ClaudeTerminal, finalChoice: Boolean): PopupStep<*>? {
                sendTo(service, selectedValue, entry)
                return FINAL_CHOICE
            }
        }
        JBPopupFactory.getInstance().createListPopup(step).showInFocusCenter()
    }

    private fun sendTo(service: SlashDeckProjectService, terminal: ClaudeTerminal, entry: CommandEntry) {
        val plan = RunPlan.of(entry.name, entry.argumentHint)
        service.launchOnEdt {
            // Claude Code may have exited while the user was choosing.
            if (!terminal.isStillRunningClaude()) {
                copy(service, entry, message("notice.noTerminalCopied", entry.name))
                return@launchOnEdt
            }
            terminal.focus()
            terminal.type(plan.text, plan.submit)
            if (!plan.submit) service.notify(message("notice.takesArguments", entry.name))
        }
    }

    fun openSource(project: Project, service: SlashDeckProjectService, entry: CommandEntry) {
        val path = entry.sourcePath ?: return
        val file = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(File(path))
        if (file == null) {
            service.notify(message("notice.sourceMissing", path), isError = true)
            return
        }
        OpenFileDescriptor(project, file).navigate(true)
    }

    fun editDescription(project: Project, service: SlashDeckProjectService, entry: CommandEntry) {
        val value = EditTextDialog.ask(project, message("edit.description.title", entry.name), entry.description) ?: return
        if (value.newValue != (entry.description)) service.editDescription(entry, value.newValue)
    }

    fun editWhenToUse(project: Project, service: SlashDeckProjectService, entry: CommandEntry) {
        val current = entry.guide?.whenToUse
        val value = EditTextDialog.ask(project, message("edit.whenToUse.title", entry.name), current) ?: return
        if (value.newValue != current) service.editWhenToUse(entry, value.newValue)
    }
}

class CopyCommandAction : CommandAction({ message("action.copy") }, AllIcons.Actions.Copy) {
    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) =
        CommandOps.copy(service, entry)
}

/** Shown only while a terminal running Claude Code is detected. */
class RunCommandAction : CommandAction({ message("action.run") }, AllIcons.Actions.Execute) {
    override fun isAvailable(project: Project, entry: CommandEntry) = ClaudeTerminalProvider.find(project).isNotEmpty()

    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) =
        CommandOps.run(project, service, entry)
}

class OpenSourceAction : CommandAction({ message("action.openSource") }, AllIcons.Actions.EditSource) {
    override fun isAvailable(project: Project, entry: CommandEntry) = entry.sourcePath != null

    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) =
        CommandOps.openSource(project, service, entry)
}

class PinAction : CommandAction({ message("action.pin") }, AllIcons.Nodes.Favorite) {
    override fun isAvailable(project: Project, entry: CommandEntry) = !entry.pinned

    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) = service.pin(entry)
}

class UnpinAction : CommandAction({ message("action.unpin") }, AllIcons.Actions.Cancel) {
    override fun isAvailable(project: Project, entry: CommandEntry) = entry.pinned

    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) = service.unpin(entry)
}

class EditDescriptionAction : CommandAction({ message("action.editDescription") }, AllIcons.Actions.Edit) {
    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) =
        CommandOps.editDescription(project, service, entry)
}

class EditWhenToUseAction : CommandAction({ message("action.editWhenToUse") }) {
    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) =
        CommandOps.editWhenToUse(project, service, entry)
}

class ResetEditsAction : CommandAction({ message("action.resetEdits") }, AllIcons.Actions.Rollback) {
    override fun isAvailable(project: Project, entry: CommandEntry) = entry.hasUserEdits

    override fun perform(project: Project, service: SlashDeckProjectService, entry: CommandEntry) =
        service.resetEdits(entry)
}

class RefreshAction : DumbAwareAction({ message("action.refresh") }, AllIcons.Actions.Refresh) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        SlashDeckProjectService.getInstance(project).refresh()
    }
}

class OpenSettingsAction : DumbAwareAction({ message("action.settings") }, AllIcons.General.Settings) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        ShowSettingsUtil.getInstance().showSettingsDialog(e.project, SlashDeckConfigurable::class.java)
    }
}

/** The actions of one command: context menu, double click and Enter. Copy comes first. */
fun commandActionGroup(): DefaultActionGroup = DefaultActionGroup(
    CopyCommandAction(),
    RunCommandAction(),
    Separator.getInstance(),
    OpenSourceAction(),
    Separator.getInstance(),
    PinAction(),
    UnpinAction(),
    Separator.getInstance(),
    EditDescriptionAction(),
    EditWhenToUseAction(),
    ResetEditsAction(),
)

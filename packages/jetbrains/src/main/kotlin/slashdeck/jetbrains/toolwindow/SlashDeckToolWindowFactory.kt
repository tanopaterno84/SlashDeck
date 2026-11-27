package slashdeck.jetbrains.toolwindow

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ex.ToolWindowManagerListener
import com.intellij.ui.content.ContentFactory
import slashdeck.jetbrains.service.SlashDeckProjectService

/**
 * Creates the tool window content. The platform calls this only when the tool window is first
 * shown: before that SlashDeck starts no process and reads no file.
 */
class SlashDeckToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val service = SlashDeckProjectService.getInstance(project)
        val panel = SlashDeckPanel(project, service)
        val content = ContentFactory.getInstance().createContent(panel, null, false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)

        project.messageBus.connect(toolWindow.disposable).subscribe(
            ToolWindowManagerListener.TOPIC,
            object : ToolWindowManagerListener {
                override fun toolWindowShown(shown: ToolWindow) {
                    if (shown.id == toolWindow.id) service.toolWindowShown()
                }
            },
        )
        service.start()
    }
}

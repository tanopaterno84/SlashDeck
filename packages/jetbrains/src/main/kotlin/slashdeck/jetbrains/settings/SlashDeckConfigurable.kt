package slashdeck.jetbrains.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import slashdeck.jetbrains.SlashDeckBundle.message
import slashdeck.jetbrains.service.SlashDeckProjectService

/** Settings | Tools | SlashDeck. */
class SlashDeckConfigurable : BoundConfigurable(message("settings.title")) {
    override fun createPanel(): DialogPanel {
        val settings = SlashDeckSettings.getInstance().state
        return panel {
            row(message("settings.nodePath")) {
                textFieldWithBrowseButton(
                    FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle(message("settings.nodePath.browse")),
                ).bindText({ settings.nodePath.orEmpty() }, { settings.nodePath = it.trim().ifEmpty { null } })
                    .align(AlignX.FILL)
                    .comment(message("settings.nodePath.comment"))
            }
            row {
                checkBox(message("settings.useIdeNode"))
                    .bindSelected({ settings.useIdeNodeInterpreter }, { settings.useIdeNodeInterpreter = it })
                    .comment(message("settings.useIdeNode.comment"))
            }
            row(message("settings.claudePath")) {
                textFieldWithBrowseButton(
                    FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle(message("settings.claudePath.browse")),
                ).bindText({ settings.claudePath.orEmpty() }, { settings.claudePath = it.trim().ifEmpty { null } })
                    .align(AlignX.FILL)
                    .comment(message("settings.claudePath.comment"))
            }
        }
    }

    override fun apply() {
        super.apply()
        for (project in ProjectManager.getInstance().openProjects) {
            SlashDeckProjectService.ifCreated(project)?.settingsChanged()
        }
    }
}

package slashdeck.jetbrains.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.dsl.builder.Align
import com.intellij.ui.dsl.builder.panel
import slashdeck.jetbrains.SlashDeckBundle.message
import javax.swing.JComponent

/** Asks for a text the user writes about a command. Empty removes the user's own value. */
class EditTextDialog private constructor(project: Project, title: String, initial: String?) : DialogWrapper(project) {
    private val area = JBTextArea(initial.orEmpty(), 6, 60).apply {
        lineWrap = true
        wrapStyleWord = true
    }

    init {
        this.title = title
        init()
    }

    override fun createCenterPanel(): JComponent = panel {
        row { comment(message("edit.hint")) }
        row { cell(JBScrollPane(area)).align(Align.FILL) }.resizableRow()
    }

    override fun getPreferredFocusedComponent(): JComponent = area

    /** The text entered; [newValue] is null when the field was emptied. */
    data class Answer(val newValue: String?)

    companion object {
        /** Null when cancelled. */
        fun ask(project: Project, title: String, initial: String?): Answer? {
            val dialog = EditTextDialog(project, title, initial)
            if (!dialog.showAndGet()) return null
            return Answer(dialog.area.text.trim().ifEmpty { null })
        }
    }
}

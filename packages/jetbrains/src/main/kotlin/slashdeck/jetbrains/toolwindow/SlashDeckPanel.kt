package slashdeck.jetbrains.toolwindow

import com.intellij.icons.AllIcons
import com.intellij.ide.DataManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.ide.CommonActionsManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.CommonShortcuts
import com.intellij.openapi.actionSystem.DataSink
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.actionSystem.UiDataProvider
import com.intellij.openapi.application.EDT
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.JBColor
import com.intellij.ui.OnePixelSplitter
import com.intellij.ui.PopupHandler
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.SearchTextField
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.HTMLEditorKitBuilder
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.util.ui.tree.TreeUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import slashdeck.jetbrains.SlashDeckBundle
import slashdeck.jetbrains.SlashDeckBundle.message
import slashdeck.jetbrains.cli.NodeLookup
import slashdeck.jetbrains.cli.NodeLocator
import slashdeck.jetbrains.cli.NodeStatus
import slashdeck.jetbrains.model.CommandEntry
import slashdeck.jetbrains.model.ResolvedView
import slashdeck.jetbrains.service.Notice
import slashdeck.jetbrains.service.SlashDeckProjectService
import slashdeck.jetbrains.service.UiState
import slashdeck.jetbrains.settings.SlashDeckConfigurable
import slashdeck.jetbrains.ui.CommandTree
import slashdeck.jetbrains.ui.DetailsHtml
import slashdeck.jetbrains.ui.GroupNode
import slashdeck.jetbrains.ui.Labels
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.FlowLayout
import java.awt.Point
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JEditorPane
import javax.swing.JPanel
import javax.swing.JTree
import javax.swing.ToolTipManager
import javax.swing.event.DocumentEvent
import javax.swing.event.TreeExpansionEvent
import javax.swing.event.TreeExpansionListener
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel

/** A command row of the tree; [groupId] tells the two rows of a pinned command apart. */
private data class CommandItem(val entry: CommandEntry, val groupId: String)

/**
 * The SlashDeck tool window: a filter, notes about the state of the list, the tree of commands
 * and the details of the selected one. States (checking Node, Node missing, loading, errors)
 * are shown inside the tool window; never a modal dialog or a notification.
 */
class SlashDeckPanel(
    private val project: Project,
    private val service: SlashDeckProjectService,
) : SimpleToolWindowPanel(true, true), UiDataProvider, Disposable {
    private val labels: Labels = SlashDeckBundle.labels
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.EDT)

    private val filter = SearchTextField(false).apply {
        textEditor.emptyText.text = message("filter.placeholder")
    }
    private val notes = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = false
    }
    private val treeModel = DefaultTreeModel(DefaultMutableTreeNode())
    private val tree = Tree(treeModel)
    private val details = JEditorPane().apply {
        editorKit = HTMLEditorKitBuilder().withWordWrapViewFactory().build()
        isEditable = false
        putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, true)
        font = UIUtil.getLabelFont()
        border = JBUI.Borders.empty(6, 8)
    }
    private val status = JBLabel().apply {
        border = JBUI.Borders.empty(2, 8)
        foreground = UIUtil.getContextHelpForeground()
    }

    private val cards = CardLayout()
    private val body = JPanel(cards)
    private val messagePanel = JPanel(BorderLayout())

    /** Expansion chosen by the user, per group ID; absent = the group's default. */
    private val userExpanded = mutableMapOf<String, Boolean>()
    private var rebuilding = false
    private var lastState: UiState? = null
    private var renderedView: ResolvedView? = null
    private var lastNoticeId = 0L
    private var noticeText: String? = null
    private var noticeIsError = false

    init {
        tree.isRootVisible = false
        tree.showsRootHandles = true
        tree.selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        tree.cellRenderer = Renderer()
        ToolTipManager.sharedInstance().registerComponent(tree)
        tree.addTreeSelectionListener { showDetails() }
        tree.addTreeExpansionListener(
            object : TreeExpansionListener {
                override fun treeExpanded(event: TreeExpansionEvent) = remember(event, true)

                override fun treeCollapsed(event: TreeExpansionEvent) = remember(event, false)
            },
        )
        tree.addMouseListener(
            object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 2 && e.button == MouseEvent.BUTTON1 && selectedEntry() != null) {
                        showActionsPopup()
                        e.consume()
                    }
                }
            },
        )
        tree.addKeyListener(
            object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER && selectedEntry() != null) {
                        showActionsPopup()
                        e.consume()
                    }
                }
            },
        )
        PopupHandler.installPopupMenu(tree, commandActionGroup(), "SlashDeckTreePopup")
        CopyCommandAction().registerCustomShortcutSet(CommonShortcuts.getCopy(), tree)

        filter.addDocumentListener(
            object : DocumentAdapter() {
                override fun textChanged(e: DocumentEvent) {
                    lastState?.view?.let { rebuildTree(it) }
                }
            },
        )

        val treeArea = JPanel(BorderLayout()).apply {
            add(ScrollPaneFactory.createScrollPane(tree, true), BorderLayout.CENTER)
        }
        val splitter = OnePixelSplitter(true, 0.65f).apply {
            firstComponent = treeArea
            secondComponent = ScrollPaneFactory.createScrollPane(details, true)
        }
        val treeCard = JPanel(BorderLayout()).apply {
            add(
                JPanel(BorderLayout()).apply {
                    add(filter, BorderLayout.NORTH)
                    add(notes, BorderLayout.CENTER)
                    border = JBUI.Borders.empty(2)
                },
                BorderLayout.NORTH,
            )
            add(splitter, BorderLayout.CENTER)
        }
        body.add(treeCard, CARD_TREE)
        body.add(messagePanel, CARD_MESSAGE)

        val content = JPanel(BorderLayout()).apply {
            add(body, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }
        setContent(content)
        toolbar = createToolbar()
        showDetails()

        scope.launch {
            service.state.collect { render(it) }
        }
    }

    private fun createToolbar(): JPanel {
        val expander = DefaultTreeExpander(tree)
        val actions = CommonActionsManager.getInstance()
        val group = DefaultActionGroup(
            RefreshAction(),
            Separator.getInstance(),
            CopyCommandAction(),
            RunCommandAction(),
            Separator.getInstance(),
            actions.createExpandAllAction(expander, tree),
            actions.createCollapseAllAction(expander, tree),
            Separator.getInstance(),
            OpenSettingsAction(),
        )
        val toolbar = ActionManager.getInstance().createActionToolbar("SlashDeckToolbar", group, true)
        toolbar.targetComponent = this
        return JPanel(BorderLayout()).apply { add(toolbar.component, BorderLayout.CENTER) }
    }

    override fun uiDataSnapshot(sink: DataSink) {
        super.uiDataSnapshot(sink)
        sink[SELECTED_COMMAND] = selectedEntry()
    }

    private fun selectedEntry(): CommandEntry? =
        ((tree.selectionPath?.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? CommandItem)?.entry

    // -- Rendering of the state ---------------------------------------------------------------

    private fun render(state: UiState) {
        lastState = state
        val node = state.node
        when {
            state.fatalError != null -> showMessage(state.fatalError, AllIcons.General.Error, retry = false)
            node == null -> showMessage(message("state.checkingNode"), null, retry = false, settings = false)
            node !is NodeStatus.Ready -> showMessage(nodeProblem(node), AllIcons.General.Warning, retry = true)
            state.view == null && state.refreshError != null && !state.refreshing ->
                showMessage(message("state.loadFailed", state.refreshError), AllIcons.General.Error, retry = true)
            state.view == null -> showMessage(message("state.loading"), null, retry = false, settings = false)
            else -> {
                renderNotes(state, state.view)
                // Only a new view rebuilds the tree: refresh flags and notices leave it alone.
                if (state.view !== renderedView) rebuildTree(state.view)
                cards.show(body, CARD_TREE)
            }
        }
        state.notice?.let { acceptNotice(it) }
        updateStatus(state)
    }

    private fun acceptNotice(notice: Notice) {
        if (notice.id == lastNoticeId) return
        lastNoticeId = notice.id
        noticeText = notice.text
        noticeIsError = notice.isError
        scope.launch {
            delay(NOTICE_MS)
            if (lastNoticeId == notice.id) {
                noticeText = null
                lastState?.let { updateStatus(it) }
            }
        }
    }

    /** The line under the tree: the result of the last action, else "Refreshing...". */
    private fun updateStatus(state: UiState) {
        val notice = noticeText
        when {
            notice != null -> {
                status.text = notice
                status.foreground = if (noticeIsError) JBColor.RED else UIUtil.getContextHelpForeground()
            }
            state.refreshing && state.view != null -> {
                status.text = message("status.refreshing")
                status.foreground = UIUtil.getContextHelpForeground()
            }
            else -> status.text = ""
        }
    }

    private fun nodeProblem(status: NodeStatus): String = when (status) {
        is NodeStatus.Missing -> when (val lookup = status.lookup) {
            is NodeLookup.SettingsPathInvalid -> message("node.settingsPathInvalid", lookup.path)
            else -> message("node.notFound", NodeLocator.MIN_MAJOR)
        }
        is NodeStatus.TooOld -> message("node.tooOld", NodeLocator.MIN_MAJOR, status.path, status.version.toString())
        is NodeStatus.Unusable -> message("node.unusable", status.path, status.reason)
        is NodeStatus.Ready -> ""
    }

    private fun showMessage(text: String, icon: Icon?, retry: Boolean, settings: Boolean = true) {
        messagePanel.removeAll()
        val column = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(12)
        }
        column.add(wrappedText(text, icon))
        val buttons = JPanel(FlowLayout(FlowLayout.LEFT, 0, 8)).apply { isOpaque = false }
        if (retry) {
            buttons.add(JButton(message("button.tryAgain")).apply { addActionListener { service.refresh() } })
        }
        if (settings) {
            buttons.add(
                JButton(message("button.openSettings")).apply {
                    addActionListener { ShowSettingsUtil.getInstance().showSettingsDialog(project, SlashDeckConfigurable::class.java) }
                },
            )
        }
        if (buttons.componentCount > 0) column.add(buttons)
        messagePanel.add(column, BorderLayout.NORTH)
        messagePanel.revalidate()
        messagePanel.repaint()
        cards.show(body, CARD_MESSAGE)
    }

    private fun renderNotes(state: UiState, view: ResolvedView) {
        notes.removeAll()
        if (view.isFallback) {
            notes.add(wrappedText(message("note.fallback"), AllIcons.General.Warning))
            if (view.warnings.any { it.code == "cli-not-found" }) {
                notes.add(wrappedText(message("note.claudeNotFound"), AllIcons.General.Information))
            }
        }
        if (state.refreshError != null && !state.refreshing) {
            notes.add(wrappedText(message("note.refreshFailed", state.refreshError), AllIcons.General.Warning))
        }
        notes.revalidate()
        notes.repaint()
    }

    /** Plain text, never HTML: a JTextArea does not interpret markup. */
    private fun wrappedText(text: String, icon: Icon?): JPanel = JPanel(BorderLayout(JBUI.scale(6), 0)).apply {
        isOpaque = false
        border = JBUI.Borders.empty(4, 4)
        if (icon != null) add(JBLabel(icon).apply { verticalAlignment = JBLabel.TOP }, BorderLayout.WEST)
        add(
            JBTextArea(text).apply {
                isEditable = false
                lineWrap = true
                wrapStyleWord = true
                isOpaque = false
                border = null
                font = UIUtil.getLabelFont()
            },
            BorderLayout.CENTER,
        )
    }

    // -- Tree ---------------------------------------------------------------------------------

    private fun rebuildTree(view: ResolvedView) {
        renderedView = view
        val filtering = CommandTree.filterWords(filter.text).isNotEmpty()
        val groups = CommandTree.build(view, filter.text, labels)
        val selected = (tree.selectionPath?.lastPathComponent as? DefaultMutableTreeNode)?.userObject
        val root = DefaultMutableTreeNode()
        for (group in groups) {
            val groupNode = DefaultMutableTreeNode(group)
            group.commands.forEach { groupNode.add(DefaultMutableTreeNode(CommandItem(it, group.id), false)) }
            root.add(groupNode)
        }
        rebuilding = true
        try {
            treeModel.setRoot(root)
            for (i in 0 until root.childCount) {
                val child = root.getChildAt(i) as DefaultMutableTreeNode
                val group = child.userObject as GroupNode
                val expand = if (filtering) true else userExpanded[group.id] ?: group.expandedByDefault
                if (expand) tree.expandPath(TreePath(child.path))
            }
            reselect(root, selected)
        } finally {
            rebuilding = false
        }
        tree.emptyText.text = if (view.commands.isEmpty()) message("tree.empty") else message("tree.noMatch")
        showDetails()
    }

    private fun reselect(root: DefaultMutableTreeNode, previous: Any?) {
        val wanted = previous as? CommandItem ?: return
        val match = TreeUtil.treeNodeTraverser(root).filter(DefaultMutableTreeNode::class.java).find {
            val item = it.userObject as? CommandItem
            item != null && item.groupId == wanted.groupId && item.entry.name == wanted.entry.name
        } ?: return
        TreeUtil.selectPath(tree, TreePath(match.path), false)
    }

    private fun remember(event: TreeExpansionEvent, expanded: Boolean) {
        if (rebuilding || CommandTree.filterWords(filter.text).isNotEmpty()) return
        val group = (event.path.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? GroupNode ?: return
        userExpanded[group.id] = expanded
    }

    private fun showDetails() {
        val entry = selectedEntry()
        details.text = if (entry == null) {
            "<html><body><i>${DetailsHtml.escape(message("details.selectCommand"))}</i></body></html>"
        } else {
            DetailsHtml.render(entry, labels)
        }
        details.caretPosition = 0
    }

    private fun showActionsPopup() {
        val path = tree.selectionPath ?: return
        val bounds = tree.getPathBounds(path) ?: return
        val entry = selectedEntry() ?: return
        val popup = JBPopupFactory.getInstance().createActionGroupPopup(
            entry.name,
            commandActionGroup(),
            DataManager.getInstance().getDataContext(tree),
            JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
            true,
            ActionPlaces.POPUP,
        )
        popup.show(RelativePoint(tree, Point(bounds.x, bounds.y + bounds.height)))
    }

    private inner class Renderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree,
            value: Any?,
            selected: Boolean,
            expanded: Boolean,
            leaf: Boolean,
            row: Int,
            hasFocus: Boolean,
        ) {
            when (val item = (value as? DefaultMutableTreeNode)?.userObject) {
                is GroupNode -> {
                    icon = if (item.categoryId == null) AllIcons.Nodes.Favorite else AllIcons.Nodes.Folder
                    append(item.label, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    val count = item.commands.size
                    append(
                        "  " + if (item.builtin) message("group.builtinCount", count) else count.toString(),
                        SimpleTextAttributes.GRAYED_ATTRIBUTES,
                    )
                }
                is CommandItem -> {
                    val entry = item.entry
                    icon = kindIcon(entry.kind)
                    append(entry.name, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                    if (entry.isNew) append("  " + message("badge.new"), NEW_ATTRIBUTES)
                    entry.argumentHint?.trim()?.takeIf { it.isNotEmpty() }?.let {
                        append("  " + oneLine(it, 40), SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES)
                    }
                    entry.description?.trim()?.takeIf { it.isNotEmpty() }?.let {
                        append("  " + oneLine(it, 120), SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    }
                    toolTipText = DetailsHtml.tooltip(entry, labels)
                }
            }
        }
    }

    override fun dispose() {
        scope.cancel()
    }

    companion object {
        private const val CARD_TREE = "tree"
        private const val CARD_MESSAGE = "message"
        private const val NOTICE_MS = 6_000L

        private val NEW_ATTRIBUTES = SimpleTextAttributes(
            SimpleTextAttributes.STYLE_BOLD,
            JBColor(0x2E7D32, 0x7BC67E),
        )

        private fun oneLine(text: String, max: Int): String {
            val flat = text.replace(Regex("""\s+"""), " ")
            return if (flat.length <= max) flat else flat.take(max - 1) + "…"
        }

        fun kindIcon(kind: String): Icon = when (kind) {
            "custom-project", "skill-project" -> AllIcons.Nodes.Module
            "plugin" -> AllIcons.Nodes.Plugin
            "custom-user", "skill-user" -> AllIcons.General.User
            "skill-synced" -> AllIcons.Actions.Download
            "builtin" -> AllIcons.Nodes.Console
            else -> AllIcons.General.QuestionDialog
        }
    }
}

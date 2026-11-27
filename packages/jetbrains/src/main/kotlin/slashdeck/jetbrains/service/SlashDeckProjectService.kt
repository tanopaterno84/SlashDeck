package slashdeck.jetbrains.service

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.readAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.components.serviceIfCreated
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCopyEvent
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.util.EnvironmentUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import slashdeck.jetbrains.SlashDeckBundle.message
import slashdeck.jetbrains.cli.CliResult
import slashdeck.jetbrains.cli.FailureKind
import slashdeck.jetbrains.cli.NodeLocator
import slashdeck.jetbrains.cli.NodeLookup
import slashdeck.jetbrains.cli.NodeStatus
import slashdeck.jetbrains.cli.ProcessRunner
import slashdeck.jetbrains.cli.SlashDeckCli
import slashdeck.jetbrains.model.CommandEntry
import slashdeck.jetbrains.model.ResolvedView
import slashdeck.jetbrains.model.WriteResult
import slashdeck.jetbrains.node.IdeNodeInterpreterProvider
import slashdeck.jetbrains.refresh.Cancellable
import slashdeck.jetbrains.refresh.ChangeEffect
import slashdeck.jetbrains.refresh.ChangeFilter
import slashdeck.jetbrains.refresh.RefreshHost
import slashdeck.jetbrains.refresh.RefreshScheduler
import slashdeck.jetbrains.settings.SlashDeckSettings
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** What the tool window shows; every field is set by [SlashDeckProjectService]. */
data class UiState(
    /** Null until Node has been checked. */
    val node: NodeStatus? = null,
    /** The plugin cannot work at all (bundled CLI missing). */
    val fatalError: String? = null,
    val view: ResolvedView? = null,
    /** `scan --cached` has answered (with or without a cache). */
    val cacheChecked: Boolean = false,
    val refreshing: Boolean = false,
    /** Why the last scan failed; null after a successful one. */
    val refreshError: String? = null,
    /** Result of the last action (copy, run, pin...), shown under the tree. */
    val notice: Notice? = null,
)

data class Notice(val text: String, val isError: Boolean, val id: Long = System.nanoTime())

/**
 * Talks to the bundled CLI for one project and holds what the tool window shows. Discovery,
 * cache and state all belong to the core: this class only decides when to call it.
 *
 * Nothing runs until the tool window is first shown ([start]). Every process runs in [cs]
 * (cancelled when the project closes, which kills the processes) and off the UI thread.
 */
@Service(Service.Level.PROJECT)
class SlashDeckProjectService(private val project: Project, private val cs: CoroutineScope) : Disposable {
    private val stateFlow = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = stateFlow.asStateFlow()

    private val runner = ProcessRunner()
    private val started = AtomicBoolean(false)
    private val initMutex = Mutex()

    /** Serialises the calls that produce a view, so an older view never replaces a newer one. */
    private val viewMutex = Mutex()

    @Volatile
    private var cli: SlashDeckCli? = null
    private var lastWarnings = ""

    /** The folder whose commands are listed: the project's base folder. */
    val workspace: String = project.basePath ?: System.getProperty("user.home")

    private val scheduler = RefreshScheduler(
        object : RefreshHost {
            override fun now() = System.currentTimeMillis()

            override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
                val job = cs.launch {
                    delay(delayMs)
                    action()
                }
                return Cancellable { job.cancel() }
            }

            override fun startScan() {
                cs.launch(Dispatchers.IO) { runScan() }
            }

            override fun startReload() {
                cs.launch(Dispatchers.IO) { reload() }
            }
        },
    )

    /** Called when the tool window content is created. Idempotent. */
    fun start() {
        if (!started.compareAndSet(false, true)) return
        watchProjectFiles()
        cs.launch(Dispatchers.IO) { initialize(manual = false) }
    }

    /** "Try again" after a Node problem, or the settings changed: check Node again and scan. */
    fun settingsChanged() {
        if (!started.get()) return
        cs.launch(Dispatchers.IO) { initialize(manual = true) }
    }

    fun refresh() {
        if (cli == null) settingsChanged() else scheduler.manualRefresh()
    }

    fun toolWindowShown() {
        if (started.get()) scheduler.toolWindowShown()
    }

    private suspend fun initialize(manual: Boolean) = initMutex.withLock {
        if (!prepareCli()) return@withLock
        reload()
        if (manual) scheduler.manualRefresh() else scheduler.requestAutomaticScan()
    }

    /** Finds the bundled CLI and a usable Node; false (with the reason in the state) otherwise. */
    private suspend fun prepareCli(): Boolean {
        val script = bundledCli()
        if (script == null || !script.isFile) {
            cli = null
            stateFlow.update { it.copy(fatalError = message("error.cliMissing", script?.path ?: PLUGIN_ID)) }
            return false
        }
        val settings = SlashDeckSettings.getInstance().state
        val environment = EnvironmentUtil.getEnvironmentMap()
        val ideNode = if (settings.useIdeNodeInterpreter) IdeNodeInterpreterProvider.find(project) else null
        val pathEnv = environment.entries.firstOrNull { it.key.equals("PATH", ignoreCase = true) }?.value
        val lookup = NodeLocator.locate(settings.nodePath, ideNode, pathEnv, SystemInfo.isWindows)
        val status = if (lookup is NodeLookup.Found) NodeLocator.check(lookup, runner, environment) else NodeStatus.Missing(lookup)
        LOG.info("Node.js: $status")
        stateFlow.update { it.copy(node = status, fatalError = null) }
        if (status !is NodeStatus.Ready) {
            cli = null
            return false
        }
        cli = SlashDeckCli(status.path, script, environment, runner, settings.claudePath)
        return true
    }

    /** `scan --cached`: the saved list, at once, without starting Claude Code. */
    private suspend fun reload() = viewMutex.withLock {
        val cli = cli ?: return@withLock
        when (val result = cli.scanCached(workspace)) {
            is CliResult.Success -> {
                logWarnings(result.value)
                stateFlow.update { it.copy(view = result.value, cacheChecked = true) }
            }
            // No cache yet: the scan that follows fills the list.
            is CliResult.NoCache -> stateFlow.update { it.copy(cacheChecked = true) }
            is CliResult.NotInCatalog -> stateFlow.update { it.copy(cacheChecked = true) }
            is CliResult.Failure -> {
                LOG.warn("scan --cached failed (${result.kind}): ${result.message}")
                stateFlow.update { it.copy(cacheChecked = true) }
            }
        }
    }

    private suspend fun runScan() {
        try {
            viewMutex.withLock {
                val cli = cli ?: return@withLock
                stateFlow.update { it.copy(refreshing = true) }
                val started = System.currentTimeMillis()
                when (val result = cli.scan(workspace)) {
                    is CliResult.Success -> {
                        val view = result.value
                        LOG.info(
                            "scanned $workspace: ${view.commands.size} commands, source ${view.source}, " +
                                "${System.currentTimeMillis() - started} ms",
                        )
                        logWarnings(view)
                        stateFlow.update { it.copy(view = view, cacheChecked = true, refreshError = null) }
                    }
                    else -> {
                        val reason = describe(result)
                        LOG.warn("scan of $workspace failed: $reason")
                        stateFlow.update { it.copy(refreshError = reason) }
                    }
                }
            }
        } finally {
            stateFlow.update { it.copy(refreshing = false) }
            scheduler.scanFinished()
        }
    }

    // -- Writes -------------------------------------------------------------------------------

    fun pin(entry: CommandEntry) = write { it.pin(workspace, entry.name) }

    fun unpin(entry: CommandEntry) = write { it.unpin(workspace, entry.name) }

    fun resetEdits(entry: CommandEntry) = write { it.reset(workspace, entry.name) }

    fun editDescription(entry: CommandEntry, value: String?) = write { it.editDescription(workspace, entry.name, value) }

    fun editWhenToUse(entry: CommandEntry, value: String?) = write { it.editWhenToUse(workspace, entry.name, value) }

    /** Runs a write of the CLI, shows its entry at once, then reloads the view. */
    private fun write(op: suspend (SlashDeckCli) -> CliResult<WriteResult>) {
        cs.launch(Dispatchers.IO) {
            val cli = cli ?: return@launch
            when (val result = op(cli)) {
                is CliResult.Success -> {
                    result.value.entry?.let { entry -> stateFlow.update { it.copy(view = it.view?.withEntry(entry)) } }
                    reload()
                }
                is CliResult.NoCache, is CliResult.NotInCatalog -> notify(message("write.notInCatalog"), isError = true)
                is CliResult.Failure -> {
                    LOG.warn("write failed (${result.kind}): ${result.message}")
                    notify(message("write.failed", result.message), isError = true)
                }
            }
        }
    }

    fun notify(text: String, isError: Boolean = false) {
        stateFlow.update { it.copy(notice = Notice(text, isError)) }
    }

    fun launchOnEdt(block: suspend CoroutineScope.() -> Unit) {
        cs.launch(Dispatchers.EDT, block = block)
    }

    // -- Files --------------------------------------------------------------------------------

    /**
     * Refreshes on changes of the project's command, skill and team override files only (see
     * [ChangeFilter]). Nothing under the user's Claude folder is watched: starting `claude`
     * rewrites files there, and a scan must never trigger the next one. The scheduler also
     * keeps a minimum interval between automatic scans, as a safety net.
     */
    private fun watchProjectFiles() {
        val ignoreCase = !SystemInfo.isFileSystemCaseSensitive
        project.messageBus.connect(this).subscribe(
            VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                override fun after(events: List<VFileEvent>) {
                    var effect: ChangeEffect? = null
                    for (event in events) {
                        for ((path, isDirectory) in changedPaths(event)) {
                            when (ChangeFilter.classify(workspace, path, isDirectory, ignoreCase)) {
                                ChangeEffect.SCAN -> effect = ChangeEffect.SCAN
                                ChangeEffect.RELOAD -> if (effect == null) effect = ChangeEffect.RELOAD
                                null -> {}
                            }
                        }
                    }
                    effect?.let { scheduler.fileChanged(it) }
                }
            },
        )
        // The VFS reports external changes only in folders it has loaded: load the two folders
        // that define commands, in the background.
        cs.launch(Dispatchers.IO) {
            val fs = LocalFileSystem.getInstance()
            for (folder in listOf("commands", "skills")) {
                val dir = fs.refreshAndFindFileByPath(FileUtil.toSystemIndependentName("$workspace/.claude/$folder")) ?: continue
                readAction { VfsUtilCore.processFilesRecursively(dir) { true } }
            }
            fs.refreshAndFindFileByPath(FileUtil.toSystemIndependentName("$workspace/.claude/slashdeck.json"))
        }
    }

    private fun changedPaths(event: VFileEvent): List<Pair<String, Boolean>> = when (event) {
        is VFileContentChangeEvent -> listOf(event.path to false)
        is VFileCreateEvent -> listOf(event.path to event.isDirectory)
        is VFileDeleteEvent -> listOf(event.path to event.file.isDirectory)
        is VFileCopyEvent -> listOf(event.path to event.file.isDirectory)
        is VFileMoveEvent -> listOf(event.oldPath to event.file.isDirectory, event.newPath to event.file.isDirectory)
        is VFilePropertyChangeEvent ->
            if (event.isRename) listOf(event.oldPath to event.file.isDirectory, event.newPath to event.file.isDirectory)
            else emptyList()
        else -> emptyList()
    }

    // -- Helpers ------------------------------------------------------------------------------

    /** Warnings go to the log only, and only when they change: never a notification. */
    private fun logWarnings(view: ResolvedView) {
        val text = view.warnings.joinToString("\n") { "[${it.code}] ${it.message}" }
        if (text == lastWarnings) return
        lastWarnings = text
        view.warnings.forEach { LOG.info("warning [${it.code}] ${it.message}") }
    }

    private fun describe(result: CliResult<*>): String = when (result) {
        is CliResult.Success -> ""
        is CliResult.NoCache -> result.message
        is CliResult.NotInCatalog -> result.message
        is CliResult.Failure -> when (result.kind) {
            FailureKind.TIMEOUT -> message("error.timeout")
            else -> result.message
        }
    }

    override fun dispose() {
        scheduler.dispose()
    }

    companion object {
        const val PLUGIN_ID = "slashdeck.placeholder"
        private val LOG = logger<SlashDeckProjectService>()

        fun getInstance(project: Project): SlashDeckProjectService = project.service()

        fun ifCreated(project: Project): SlashDeckProjectService? = project.serviceIfCreated()

        /**
         * `<plugin folder>/cli/slashdeck.mjs`, put there by the Gradle build (prepareSandbox): the
         * plugin's classes are in `<plugin folder>/lib/<jar>`. The system property `slashdeck.cli`
         * overrides it (tests and development).
         */
        fun bundledCli(): File? {
            System.getProperty("slashdeck.cli")?.takeIf { it.isNotBlank() }?.let { return File(it) }
            val jar = PathManager.getJarPathForClass(SlashDeckProjectService::class.java) ?: return null
            return File(jar).parentFile?.parentFile?.resolve("cli")?.resolve("slashdeck.mjs")
        }
    }
}

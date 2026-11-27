package slashdeck.jetbrains.refresh

/** What the scheduler needs from its owner; a fake clock and timer in the tests. */
interface RefreshHost {
    fun now(): Long

    /** Runs [action] after [delayMs], unless the returned handle is cancelled first. */
    fun schedule(delayMs: Long, action: () -> Unit): Cancellable

    /** Starts `scan` asynchronously; the host calls [RefreshScheduler.scanFinished] at the end. */
    fun startScan()

    /** Starts `scan --cached` asynchronously (cheap: never starts Claude Code). */
    fun startReload()
}

fun interface Cancellable {
    fun cancel()
}

/**
 * Decides when to scan. Every automatic trigger (file changes, the tool window shown again,
 * the first opening) goes through [requestAutomaticScan], which enforces:
 * - scans never overlap: a request during a scan is remembered once and served afterwards;
 * - **at least [minAutoIntervalMs] between the starts of two automatic scans**, whatever asks
 *   for them: a hard limit, so that no mistake can produce a continuous loop of scans;
 * - bursts of file changes are debounced ([debounceMs]).
 * A manual refresh always starts at once (or right after the running scan).
 */
class RefreshScheduler(
    private val host: RefreshHost,
    val debounceMs: Long = 1_500,
    val minAutoIntervalMs: Long = 60_000,
    /** "After a while": the tool window shown again refreshes a list older than this. */
    val staleAfterMs: Long = 5 * 60_000,
) {
    private var running = false
    private var pendingManual = false
    private var pendingAuto = false
    private var lastScanStart: Long? = null
    private var lastScanEnd: Long? = null
    private var autoTimer: Cancellable? = null
    private var scanDebounce: Cancellable? = null
    private var reloadDebounce: Cancellable? = null
    private var disposed = false

    @get:Synchronized
    val isScanning: Boolean get() = running

    /** A file that defines commands changed (see [ChangeFilter]). */
    @Synchronized
    fun fileChanged(effect: ChangeEffect) {
        if (disposed) return
        when (effect) {
            ChangeEffect.SCAN -> {
                // The scan resolves the view too: a pending reload is not needed any more.
                reloadDebounce?.cancel()
                reloadDebounce = null
                scanDebounce?.cancel()
                scanDebounce = host.schedule(debounceMs) {
                    synchronized(this) { scanDebounce = null }
                    requestAutomaticScan()
                }
            }
            ChangeEffect.RELOAD -> {
                if (scanDebounce != null) return
                reloadDebounce?.cancel()
                reloadDebounce = host.schedule(debounceMs) {
                    synchronized(this) { reloadDebounce = null }
                    if (!disposed) host.startReload()
                }
            }
        }
    }

    /** The tool window became visible: refresh if the list is old, within the limits. */
    @Synchronized
    fun toolWindowShown() {
        if (disposed || running) return
        val last = lastScanEnd ?: lastScanStart ?: return // never scanned: the first opening does it
        if (host.now() - last >= staleAfterMs) requestAutomaticScan()
    }

    /** Any automatic scan. Starts now, or as soon as the minimum interval allows. */
    @Synchronized
    fun requestAutomaticScan() {
        if (disposed) return
        if (running) {
            pendingAuto = true
            return
        }
        if (autoTimer != null) return // already planned
        val earliest = lastScanStart?.plus(minAutoIntervalMs) ?: Long.MIN_VALUE
        val now = host.now()
        if (now >= earliest) {
            start()
        } else {
            autoTimer = host.schedule(earliest - now) {
                synchronized(this) { autoTimer = null }
                requestAutomaticScan()
            }
        }
    }

    /** The Refresh button: always immediate, or right after the running scan. */
    @Synchronized
    fun manualRefresh() {
        if (disposed) return
        scanDebounce?.cancel()
        scanDebounce = null
        autoTimer?.cancel()
        autoTimer = null
        if (running) pendingManual = true else start()
    }

    @Synchronized
    fun scanFinished() {
        running = false
        lastScanEnd = host.now()
        if (disposed) return
        when {
            pendingManual -> {
                pendingManual = false
                pendingAuto = false
                start()
            }
            pendingAuto -> {
                pendingAuto = false
                requestAutomaticScan()
            }
        }
    }

    private fun start() {
        running = true
        lastScanStart = host.now()
        pendingAuto = false
        host.startScan()
    }

    @Synchronized
    fun dispose() {
        disposed = true
        listOfNotNull(autoTimer, scanDebounce, reloadDebounce).forEach { it.cancel() }
        autoTimer = null
        scanDebounce = null
        reloadDebounce = null
    }
}

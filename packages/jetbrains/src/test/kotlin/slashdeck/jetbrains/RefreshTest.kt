package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import slashdeck.jetbrains.refresh.Cancellable
import slashdeck.jetbrains.refresh.ChangeEffect
import slashdeck.jetbrains.refresh.ChangeFilter
import slashdeck.jetbrains.refresh.RefreshHost
import slashdeck.jetbrains.refresh.RefreshScheduler

/** A virtual clock and timer; scans take [scanMs] of virtual time. */
private class FakeHost(private val scanMs: Long = 3_000) : RefreshHost {
    var time = 0L
    val scanStarts = mutableListOf<Long>()
    var reloads = 0
    private var nextId = 0
    private val timers = sortedMapOf<Pair<Long, Int>, () -> Unit>(compareBy<Pair<Long, Int>> { it.first }.thenBy { it.second })
    lateinit var scheduler: RefreshScheduler

    override fun now() = time

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val key = (time + delayMs) to nextId++
        timers[key] = action
        return Cancellable { timers.remove(key) }
    }

    override fun startScan() {
        scanStarts += time
        schedule(scanMs) { scheduler.scanFinished() }
    }

    override fun startReload() {
        reloads++
    }

    /** Advances the virtual time to [until], running the timers that fall due. */
    fun advanceTo(until: Long) {
        while (true) {
            val next = timers.keys.firstOrNull() ?: break
            if (next.first > until) break
            val action = timers.remove(next)!!
            time = next.first
            action()
        }
        time = until
    }
}

class RefreshTest {
    private fun setup(): Pair<FakeHost, RefreshScheduler> {
        val host = FakeHost()
        val scheduler = RefreshScheduler(host, debounceMs = 1_500, minAutoIntervalMs = 60_000, staleAfterMs = 300_000)
        host.scheduler = scheduler
        return host to scheduler
    }

    @Test
    fun `repeated file events and visibility changes never exceed one automatic scan per minute`() {
        val (host, scheduler) = setup()
        scheduler.requestAutomaticScan() // first opening
        // Ten minutes of a file event every 2 s (longer than the debounce, so each one asks for
        // a scan) and the tool window shown every second: what a scan that triggers the next
        // one would look like.
        val tenMinutes = 600_000L
        var t = 0L
        while (t < tenMinutes) {
            host.advanceTo(t)
            if (t % 2_000 == 0L) scheduler.fileChanged(ChangeEffect.SCAN)
            scheduler.toolWindowShown()
            t += 1_000
        }
        host.advanceTo(tenMinutes)
        val starts = host.scanStarts
        assertTrue("${starts.size} scans: $starts", starts.size in 9..11)
        starts.zipWithNext().forEach { (a, b) -> assertTrue("scans at $a and $b", b - a >= 60_000) }
    }

    @Test
    fun `visibility alone refreshes only a list older than five minutes, and not more than once`() {
        val (host, scheduler) = setup()
        scheduler.toolWindowShown() // never scanned yet: the first opening does it, not this
        assertEquals(0, host.scanStarts.size)
        scheduler.requestAutomaticScan()
        host.advanceTo(10_000)
        repeat(100) { scheduler.toolWindowShown() }
        host.advanceTo(200_000)
        assertEquals(1, host.scanStarts.size)
        host.advanceTo(400_000)
        repeat(100) { scheduler.toolWindowShown() }
        host.advanceTo(500_000)
        assertEquals(2, host.scanStarts.size)
    }

    @Test
    fun `a burst of file changes is debounced into one scan`() {
        val (host, scheduler) = setup()
        scheduler.requestAutomaticScan()
        host.advanceTo(120_000)
        repeat(50) {
            scheduler.fileChanged(ChangeEffect.SCAN)
            host.advanceTo(host.time + 100)
        }
        host.advanceTo(200_000)
        assertEquals(listOf(0L, 120_000L + 50 * 100 + 1_500 - 100), host.scanStarts)
    }

    @Test
    fun `manual refresh is immediate, and runs once more after a running scan`() {
        val (host, scheduler) = setup()
        scheduler.requestAutomaticScan()
        host.advanceTo(1_000) // the scan is still running (3 s)
        scheduler.manualRefresh()
        scheduler.manualRefresh()
        assertEquals(1, host.scanStarts.size)
        host.advanceTo(3_000)
        assertEquals(listOf(0L, 3_000L), host.scanStarts)
        host.advanceTo(10_000)
        scheduler.manualRefresh() // 7 s after the last start: no minimum interval for a click
        assertEquals(listOf(0L, 3_000L, 10_000L), host.scanStarts)
    }

    @Test
    fun `team override changes only reload, and a pending scan absorbs them`() {
        val (host, scheduler) = setup()
        repeat(5) { scheduler.fileChanged(ChangeEffect.RELOAD) }
        host.advanceTo(2_000)
        assertEquals(1, host.reloads)
        assertEquals(0, host.scanStarts.size)
        scheduler.fileChanged(ChangeEffect.SCAN)
        scheduler.fileChanged(ChangeEffect.RELOAD)
        host.advanceTo(4_000)
        assertEquals(1, host.reloads)
        assertEquals(1, host.scanStarts.size)
    }

    @Test
    fun `nothing runs after dispose`() {
        val (host, scheduler) = setup()
        scheduler.fileChanged(ChangeEffect.SCAN)
        scheduler.dispose()
        scheduler.requestAutomaticScan()
        scheduler.manualRefresh()
        host.advanceTo(100_000)
        assertEquals(0, host.scanStarts.size)
    }

    @Test
    fun `only files that define commands count, never dot-files or the user folder`() {
        fun classify(path: String, dir: Boolean = false) = ChangeFilter.classify("C:/repo", path, dir, ignoreCase = true)
        assertEquals(ChangeEffect.SCAN, classify("C:/repo/.claude/commands/deploy.md"))
        assertEquals(ChangeEffect.SCAN, classify("c:/REPO/.claude/commands/tools/Lint.MD"))
        assertEquals(ChangeEffect.SCAN, classify("C:\\repo\\.claude\\skills\\proj\\SKILL.md"))
        assertEquals(ChangeEffect.SCAN, classify("C:/repo/.claude/skills/proj", dir = true))
        assertEquals(ChangeEffect.SCAN, classify("C:/repo/.claude/commands", dir = true))
        assertEquals(ChangeEffect.RELOAD, classify("C:/repo/.claude/slashdeck.json"))

        assertNull(classify("C:/repo/.claude/skills/proj/notes.md"))
        assertNull(classify("C:/repo/.claude/skills/proj/scripts/x.mjs"))
        assertNull(classify("C:/repo/.claude/commands/readme.txt"))
        assertNull(classify("C:/repo/.claude/settings.local.json"))
        assertNull(classify("C:/repo/.claude/skills/.staging/123/SKILL.md"))
        assertNull(classify("C:/repo/.claude/skills/proj/.in_use", dir = true))
        assertNull(classify("C:/repo/.claude/commands/.last-complete-round"))
        assertNull(classify("C:/repo/.claude/skills/synced/.cache/manifest.json"))
        assertNull(classify("C:/repo/src/.claude/commands/x.md"))
        assertNull(classify("C:/Users/me/.claude/skills/synced/a/manifest.json"))
        assertNull(classify("C:/Users/me/.claude/commands/x.md"))
        assertNull(classify("C:/repository/.claude/commands/x.md"))
        // Case-sensitive file systems.
        assertNull(ChangeFilter.classify("/repo", "/REPO/.claude/commands/x.md", false, ignoreCase = false))
    }
}

package slashdeck.jetbrains

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import slashdeck.jetbrains.cli.CliResult
import slashdeck.jetbrains.cli.FailureKind
import slashdeck.jetbrains.cli.NodeLocator
import slashdeck.jetbrains.cli.NodeLookup
import slashdeck.jetbrains.cli.NodeStatus
import slashdeck.jetbrains.cli.ProcessOutcome
import slashdeck.jetbrains.cli.ProcessRunner
import slashdeck.jetbrains.cli.ProcessSpec
import slashdeck.jetbrains.cli.SlashDeckCli
import slashdeck.jetbrains.model.ResolvedView
import slashdeck.jetbrains.ui.CommandTree
import java.io.File
import java.nio.file.Files
import kotlin.coroutines.cancellation.CancellationException

/**
 * Runs the real bundled CLI (packages/core/dist/slashdeck.mjs) with Node, to prove that the
 * Kotlin side and the CLI agree on the contract. Claude Code is never started: the CLI gets a
 * fake `claude` (a Node script) or a path that does not exist. Cache, state, home and Claude
 * folders are temporary.
 */
class CliIntegrationTest {
    private val isWindows = System.getProperty("os.name").startsWith("Windows")
    private val runner = ProcessRunner()
    private lateinit var temp: File
    private lateinit var workspace: File
    private lateinit var node: String
    private lateinit var env: Map<String, String>

    private val fixtures = File(TestSupport.property("slashdeck.fixtures"))
    private val script = File(TestSupport.property("slashdeck.cli"))

    @Before
    fun setUp() {
        temp = Files.createTempDirectory("slashdeck-jb-test").toFile()
        // A copy, so that nothing can ever write into the fixtures.
        workspace = File(temp, "workspace").also { fixtures.resolve("workspace").copyRecursively(it) }
        val claudeDir = File(temp, "home/.claude").also { fixtures.resolve("home/.claude").copyRecursively(it) }
        val pathEnv = System.getenv().entries.firstOrNull { it.key.equals("PATH", ignoreCase = true) }?.value
        node = when (val found = NodeLocator.locate(null, null, pathEnv, isWindows)) {
            is NodeLookup.Found -> found.path
            else -> throw AssertionError("these tests need node on the PATH")
        }
        env = System.getenv() + mapOf(
            "SLASHDECK_CACHE_DIR" to File(temp, "cache").path,
            "SLASHDECK_CONFIG_DIR" to File(temp, "config").path,
            "CLAUDE_CONFIG_DIR" to claudeDir.path,
            "HOME" to File(temp, "home").path,
            "USERPROFILE" to File(temp, "home").path,
            "SLASHDECK_CLAUDE_PATH" to fakeClaude().path,
        )
    }

    @After
    fun tearDown() {
        temp.deleteRecursively()
    }

    /** An executable that runs fixtures/fake-claude.mjs with this Node. */
    private fun fakeClaude(): File {
        val fake = fixtures.resolve("fake-claude.mjs")
        return if (isWindows) {
            File(temp, "fake-claude.cmd").apply { writeText("@\"$node\" \"${fake.path}\" %*\r\n") }
        } else {
            File(temp, "fake-claude").apply {
                writeText("#!/bin/sh\nexec \"$node\" \"${fake.path}\" \"$@\"\n")
                setExecutable(true)
            }
        }
    }

    private fun cli(environment: Map<String, String> = env, claudePath: String? = null) =
        SlashDeckCli(node, script, environment, runner, claudePath)

    private fun <T> success(result: CliResult<T>): T =
        (result as? CliResult.Success)?.value ?: throw AssertionError("expected success, got $result")

    @Test
    fun `Node from the PATH is recent enough`() = runBlocking {
        val status = NodeLocator.check(NodeLookup.Found(node, slashdeck.jetbrains.cli.NodeSource.PATH), runner, env)
        assertTrue(status.toString(), status is NodeStatus.Ready)
    }

    @Test
    fun `no cache yet exits with 3, then scan fills it`() = runBlocking {
        val cli = cli()
        val none = cli.scanCached(workspace.path)
        assertTrue(none.toString(), none is CliResult.NoCache)

        val view = success(cli.scan(workspace.path))
        assertEquals("cli", view.source)
        assertEquals("9.9.9", view.claudeCodeVersion)
        val names = view.commands.map { it.name }.toSet()
        assertTrue(names.toString(), names.containsAll(listOf("/compact", "/clear", "/deploy-check", "/proj-skill", "/hello")))

        // The order of the categories travels with the view and starts with the project.
        assertEquals("project", view.categoryOrder.first())
        assertEquals(view.commands.map { it.category }.toSet(), view.categoryOrder.toSet())
        assertTrue(view.categoryOrder.indexOf("personal") < view.categoryOrder.indexOf("context"))

        val deploy = view.command("/deploy-check")!!
        assertEquals("custom-project", deploy.kind)
        assertTrue(deploy.sourcePath!!.endsWith("deploy-check.md"))
        assertEquals("Before every release.", deploy.guide?.whenToUse)
        assertEquals("team", deploy.origins["guide.whenToUse"])
        assertEquals("[env]", deploy.argumentHint)

        val cached = success(cli.scanCached(workspace.path))
        assertEquals(view, cached)

        // The tree built from the real output: Favourites absent, project first.
        val groups = CommandTree.build(cached, "", TestSupport.english)
        assertEquals("Project", groups.first().label)
        assertEquals(listOf("/deploy-check", "/proj-skill"), groups.first().commands.map { it.name })
    }

    @Test
    fun `writes print the uniform result and change the resolved view`() = runBlocking {
        val cli = cli()
        success(cli.scan(workspace.path))

        val pin = success(cli.pin(workspace.path, "/deploy-check"))
        assertEquals("pin", pin.action)
        assertEquals("/deploy-check", pin.command)
        assertTrue(pin.changed)
        assertEquals("workspace", pin.scope)
        assertTrue(pin.entry!!.pinned)
        assertFalse(success(cli.pin(workspace.path, "/deploy-check")).changed)

        val edit = success(cli.editDescription(workspace.path, "/compact", "My \"own\" text <b>"))
        assertEquals("My \"own\" text <b>", edit.entry!!.description)
        assertEquals("user-edit", edit.entry.origins["description"])
        val whenToUse = success(cli.editWhenToUse(workspace.path, "/compact", "When it is full"))
        assertEquals("When it is full", whenToUse.entry!!.guide?.whenToUse)

        val view = success(cli.scanCached(workspace.path))
        assertTrue(view.command("/deploy-check")!!.pinned)
        assertTrue(view.command("/compact")!!.hasUserEdits)
        assertEquals("Favourites", CommandTree.build(view, "", TestSupport.english).first().label)

        // null removes the user's own value.
        val cleared = success(cli.editDescription(workspace.path, "/compact", null))
        assertEquals("Free up context", cleared.entry!!.description)

        val reset = success(cli.reset(workspace.path, "/compact"))
        assertEquals("reset", reset.action)
        assertFalse(reset.entry!!.hasUserEdits)

        val unpin = success(cli.unpin(workspace.path, "deploy-check"))
        assertFalse(unpin.entry!!.pinned)

        // Unpin of a command not in the catalog works (cleanup) and has no entry.
        val stale = success(cli.unpin(workspace.path, "/gone"))
        assertEquals("both", stale.scope)
        assertNull(stale.entry)
    }

    @Test
    fun `exit codes 4 and 2 reach the plugin as results`() = runBlocking {
        val cli = cli()
        success(cli.scan(workspace.path))
        val missing = cli.pin(workspace.path, "/not-a-command")
        assertTrue(missing.toString(), missing is CliResult.NotInCatalog)

        val blank = cli.editDescription(workspace.path, "/compact", "   ")
        assertEquals(FailureKind.USAGE, (blank as CliResult.Failure).kind)
    }

    @Test
    fun `exit code 1 when the user state cannot be read`() = runBlocking {
        val cli = cli()
        success(cli.scan(workspace.path))
        File(temp, "config").mkdirs()
        File(temp, "config/state.json").writeText("{ not json")
        val result = cli.pin(workspace.path, "/compact")
        assertEquals(FailureKind.ERROR, (result as CliResult.Failure).kind)
        assertTrue(result.message.isNotBlank())
        // The file was left alone.
        assertEquals("{ not json", File(temp, "config/state.json").readText())
    }

    @Test
    fun `Claude Code missing gives the fallback view`() = runBlocking {
        val missingClaude = File(temp, "no-such-claude" + if (isWindows) ".exe" else "").path
        val view: ResolvedView = success(cli(claudePath = missingClaude).scan(workspace.path))
        assertTrue(view.isFallback)
        assertNull(view.claudeCodeVersion)
        assertTrue(view.warnings.isNotEmpty())
        assertTrue(view.commands.none { it.kind == "builtin" })
        assertEquals("project", view.categoryOrder.first())
        assertTrue(view.command("/deploy-check") != null)
    }

    @Test
    fun `the runner times out and kills the process`() = runBlocking {
        val started = System.nanoTime()
        val outcome = runner.run(
            ProcessSpec(listOf(node, "-e", "setTimeout(() => {}, 60000)"), env, timeoutMs = 500),
        )
        assertTrue(outcome.toString(), outcome is ProcessOutcome.TimedOut)
        assertTrue((System.nanoTime() - started) / 1_000_000 < 10_000)
    }

    @Test
    fun `cancelling the coroutine kills the process`() = runBlocking {
        val marker = File(temp, "still-running")
        val job = async {
            runner.run(
                ProcessSpec(
                    listOf(node, "-e", "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 3000)", marker.path),
                    env,
                    timeoutMs = 60_000,
                ),
            )
        }
        delay(500)
        job.cancel()
        try {
            job.await()
            fail("expected a cancellation")
        } catch (_: CancellationException) {
        }
        delay(4_000)
        assertFalse("the process was not killed", marker.exists())
    }

    @Test
    fun `a missing executable fails to start`() = runBlocking {
        val outcome = runner.run(ProcessSpec(listOf(File(temp, "nope.exe").path), env, timeoutMs = 5_000))
        assertTrue(outcome.toString(), outcome is ProcessOutcome.FailedToStart)
    }
}

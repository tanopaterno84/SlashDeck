package slashdeck.jetbrains

import com.intellij.testFramework.HeavyPlatformTestCase
import com.intellij.testFramework.PlatformTestUtil
import slashdeck.jetbrains.cli.NodeStatus
import slashdeck.jetbrains.node.IdeNodeInterpreterProvider
import slashdeck.jetbrains.node.JavaScriptNodeInterpreterProvider
import slashdeck.jetbrains.service.SlashDeckProjectService
import slashdeck.jetbrains.terminal.ClaudeTerminalProvider
import slashdeck.jetbrains.terminal.ReworkedTerminalProvider
import java.io.File

/**
 * Runs inside a headless WebStorm (the IntelliJ Platform test framework): the plugin
 * descriptors, the optional integrations and the project service, with the real bundled CLI.
 * Claude Code is not started: SLASHDECK_CLAUDE_PATH points to a missing file (build.gradle.kts),
 * so the list comes from the files (fallback mode).
 */
class PluginInIdeTest : HeavyPlatformTestCase() {
    fun testOptionalIntegrationsAreRegistered() {
        val terminals = ClaudeTerminalProvider.EP_NAME.extensionList
        assertEquals(listOf(ReworkedTerminalProvider::class.java), terminals.map { it.javaClass })
        // No terminal tab is open: no Claude terminal, and no exception.
        assertEmpty(ClaudeTerminalProvider.find(project))
        // The terminal API classes are visible to the class loader of the optional part.
        Class.forName(
            "com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTabsManager",
            true,
            ReworkedTerminalProvider::class.java.classLoader,
        )

        val node = IdeNodeInterpreterProvider.EP_NAME.extensionList
        assertEquals(listOf(JavaScriptNodeInterpreterProvider::class.java), node.map { it.javaClass })
        // A path or null, but never an exception.
        IdeNodeInterpreterProvider.find(project)
    }

    fun testTheServiceLoadsTheListWithTheBundledCli() {
        val base = File(project.basePath!!)
        File(System.getProperty("slashdeck.fixtures"), "workspace/.claude").copyRecursively(File(base, ".claude"), overwrite = true)

        // In the tests the plugin's classes come from the build folder, not from an installed
        // plugin, so the CLI is found through the slashdeck.cli property (build.gradle.kts).
        val cli = SlashDeckProjectService.bundledCli()
        assertNotNull("CLI not found", cli)
        assertTrue("CLI missing: $cli", cli!!.isFile)

        val service = SlashDeckProjectService.getInstance(project)
        service.start()
        PlatformTestUtil.waitWithEventsDispatching(
            { "no view: ${service.state.value}" },
            {
                val state = service.state.value
                state.fatalError != null || (state.node != null && state.node !is NodeStatus.Ready) ||
                    (state.view != null && !state.refreshing)
            },
            120,
        )
        val state = service.state.value
        assertNull(state.fatalError)
        assertTrue(state.node.toString(), state.node is NodeStatus.Ready)
        val view = state.view!!
        assertTrue(view.isFallback)
        assertEquals("project", view.categoryOrder.first())
        assertNotNull(view.command("/deploy-check"))
        assertEquals("Before every release.", view.command("/deploy-check")!!.guide?.whenToUse)
        assertEquals(File(project.basePath!!).canonicalFile, File(view.workspace).canonicalFile)
    }
}

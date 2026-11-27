package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import slashdeck.jetbrains.cli.NodeLocator
import slashdeck.jetbrains.cli.NodeLookup
import slashdeck.jetbrains.cli.NodeSource
import slashdeck.jetbrains.cli.NodeStatus
import slashdeck.jetbrains.cli.NodeVersion
import slashdeck.jetbrains.cli.ProcessOutcome

class NodeLocatorTest {
    private val windowsFiles = setOf(
        """C:\Program Files\nodejs\node.exe""",
        """D:\tools\node.exe""",
        """C:\ide\node.exe""",
    )
    private val isWindowsFile: (String) -> Boolean = { it in windowsFiles }
    private val windowsPath = """C:\Windows\system32;"C:\Program Files\nodejs";D:\tools\"""

    @Test
    fun `the settings path wins, and a wrong one is reported instead of replaced`() {
        assertEquals(
            NodeLookup.Found("""D:\tools\node.exe""", NodeSource.SETTINGS),
            NodeLocator.locate(""" "D:\tools\node.exe" """, """C:\ide\node.exe""", windowsPath, true, isWindowsFile),
        )
        assertEquals(
            NodeLookup.SettingsPathInvalid("""E:\missing\node.exe"""),
            NodeLocator.locate("""E:\missing\node.exe""", """C:\ide\node.exe""", windowsPath, true, isWindowsFile),
        )
    }

    @Test
    fun `then the IDE interpreter, when it exists`() {
        assertEquals(
            NodeLookup.Found("""C:\ide\node.exe""", NodeSource.IDE),
            NodeLocator.locate("  ", """C:\ide\node.exe""", windowsPath, true, isWindowsFile),
        )
        assertEquals(
            NodeLookup.Found("""C:\Program Files\nodejs\node.exe""", NodeSource.PATH),
            NodeLocator.locate(null, """C:\gone\node.exe""", windowsPath, true, isWindowsFile),
        )
    }

    @Test
    fun `then node on the PATH, in PATH order`() {
        assertEquals(
            NodeLookup.Found("""C:\Program Files\nodejs\node.exe""", NodeSource.PATH),
            NodeLocator.locate(null, null, windowsPath, true, isWindowsFile),
        )
        assertEquals(
            NodeLookup.Found("""D:\tools\node.exe""", NodeSource.PATH),
            NodeLocator.locate(null, null, """D:\tools;C:\Program Files\nodejs""", true, isWindowsFile),
        )
        val unixFiles = setOf("/usr/local/bin/node")
        assertEquals(
            NodeLookup.Found("/usr/local/bin/node", NodeSource.PATH),
            NodeLocator.locate(null, null, "/usr/bin:/usr/local/bin/", false) { it in unixFiles },
        )
    }

    @Test
    fun `nothing found`() {
        assertEquals(NodeLookup.NotFound, NodeLocator.locate(null, null, """C:\Windows""", true, isWindowsFile))
        assertEquals(NodeLookup.NotFound, NodeLocator.locate(null, null, null, false) { false })
    }

    @Test
    fun `parses node --version`() {
        assertEquals(NodeVersion(24, 15, 0), NodeLocator.parseVersion("v24.15.0\n"))
        assertEquals(NodeVersion(20, 0, 1), NodeLocator.parseVersion("20.0.1"))
        assertNull(NodeLocator.parseVersion("Welcome to Node.js"))
        assertNull(NodeLocator.parseVersion(""))
    }

    @Test
    fun `decides from the version whether Node can run the CLI`() {
        val found = NodeLookup.Found("/n/node", NodeSource.PATH)
        assertEquals(
            NodeStatus.Ready("/n/node", NodeVersion(20, 0, 0), NodeSource.PATH),
            NodeLocator.statusOf(found, ProcessOutcome.Exited(0, "v20.0.0\n", "")),
        )
        assertEquals(
            NodeStatus.TooOld("/n/node", NodeVersion(18, 19, 1), NodeSource.PATH),
            NodeLocator.statusOf(found, ProcessOutcome.Exited(0, "v18.19.1\n", "")),
        )
        assertTrue(NodeLocator.statusOf(found, ProcessOutcome.Exited(0, "hello", "")) is NodeStatus.Unusable)
        assertTrue(NodeLocator.statusOf(found, ProcessOutcome.Exited(1, "v22.0.0", "")) is NodeStatus.Unusable)
        assertTrue(NodeLocator.statusOf(found, ProcessOutcome.FailedToStart("denied")) is NodeStatus.Unusable)
        assertTrue(NodeLocator.statusOf(found, ProcessOutcome.TimedOut(10_000, "")) is NodeStatus.Unusable)
    }
}

package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import slashdeck.jetbrains.terminal.ClaudeCommandLine
import slashdeck.jetbrains.terminal.RunPlan

class ClaudeCommandLineTest {
    @Test
    fun `interactive sessions are recognised`() {
        for (line in listOf(
            "claude",
            "claude -c",
            "claude --resume",
            "claude \"fix the build\"",
            "& \"C:\\Users\\me\\.local\\bin\\claude.exe\" --model opus",
            "cd app && claude",
            "FOO=1 claude",
            "npx @anthropic-ai/claude-code",
            "pnpm dlx @anthropic-ai/claude-code@latest",
            "claude.cmd",
        )) {
            assertTrue(line, ClaudeCommandLine.isInteractiveClaude(line))
        }
    }

    @Test
    fun `other command lines are not`() {
        for (line in listOf(
            "",
            "ls",
            "claude -p \"hello\"",
            "claude --print=x",
            "claude mcp list",
            "claude --version",
            "claude update",
            "echo hi | claude",
            "claude && ls",
            "npm install @anthropic-ai/claude-code",
            "git commit -m claude",
            "claudette",
        )) {
            assertFalse(line, ClaudeCommandLine.isInteractiveClaude(line))
        }
    }

    @Test
    fun `run types commands with arguments without pressing Enter`() {
        assertEquals(RunPlan("/compact", submit = true), RunPlan.of("/compact", null))
        assertEquals(RunPlan("/compact", submit = true), RunPlan.of("/compact", "  "))
        assertEquals(RunPlan("/gxrr:wiki ", submit = false), RunPlan.of("/gxrr:wiki", "<path>"))
    }
}

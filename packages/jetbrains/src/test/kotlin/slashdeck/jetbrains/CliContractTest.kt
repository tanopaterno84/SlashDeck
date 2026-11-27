package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Test
import slashdeck.jetbrains.cli.CliContract
import slashdeck.jetbrains.cli.CliResult
import slashdeck.jetbrains.cli.FailureKind
import slashdeck.jetbrains.cli.ProcessOutcome
import slashdeck.jetbrains.model.CliOutputException

class CliContractTest {
    private fun parse(text: String): String = if (text.startsWith("{")) text.trim() else throw CliOutputException("not json")

    private fun exited(code: Int, stdout: String = "", stderr: String = "") = ProcessOutcome.Exited(code, stdout, stderr)

    @Test
    fun `exit 0 parses stdout`() {
        assertEquals(CliResult.Success("{}"), CliContract.interpret(exited(0, "{}\n"), ::parse))
    }

    @Test
    fun `exit 0 with unexpected output is a failure, not a success`() {
        val result = CliContract.interpret(exited(0, "garbage"), ::parse)
        assertEquals(CliResult.Failure(FailureKind.BAD_OUTPUT, "not json"), result)
    }

    @Test
    fun `each documented exit code maps to its result, with the reason from stderr`() {
        assertEquals(
            CliResult.Failure(FailureKind.ERROR, "state file unreadable"),
            CliContract.interpret(exited(1, stderr = "slashdeck: state file unreadable\n"), ::parse),
        )
        assertEquals(
            CliResult.Failure(FailureKind.USAGE, "unknown command \"x\""),
            CliContract.interpret(exited(2, stderr = "slashdeck: unknown command \"x\"\n\nUsage: slashdeck <command>\n  scan ..."), ::parse),
        )
        assertEquals(
            CliResult.NoCache("no cached catalog for C:/repo: run \"slashdeck scan\" first"),
            CliContract.interpret(exited(3, stderr = "slashdeck: no cached catalog for C:/repo: run \"slashdeck scan\" first\n"), ::parse),
        )
        assertEquals(
            CliResult.NotInCatalog("/nope is not in the cached catalog"),
            CliContract.interpret(exited(4, stderr = "slashdeck: /nope is not in the cached catalog\n"), ::parse),
        )
    }

    @Test
    fun `other exit codes, timeouts and start failures are failures`() {
        assertEquals(
            CliResult.Failure(FailureKind.UNEXPECTED_EXIT, "exit code 137: killed"),
            CliContract.interpret(exited(137, stderr = "killed"), ::parse),
        )
        assertEquals(CliResult.Failure(FailureKind.UNEXPECTED_EXIT, "exit code -1"), CliContract.interpret(exited(-1), ::parse))
        assertEquals(
            CliResult.Failure(FailureKind.TIMEOUT, "no answer within 90 s"),
            CliContract.interpret(ProcessOutcome.TimedOut(90_000, ""), ::parse),
        )
        assertEquals(
            CliResult.Failure(FailureKind.START_FAILED, "CreateProcess error=2"),
            CliContract.interpret(ProcessOutcome.FailedToStart("CreateProcess error=2"), ::parse),
        )
    }

    @Test
    fun `stdout is ignored on failure`() {
        assertEquals(CliResult.Failure(FailureKind.ERROR, "boom"), CliContract.interpret(exited(1, "{}", "boom"), ::parse))
    }

    @Test
    fun `long reasons are cut`() {
        val reason = CliContract.reason("slashdeck: " + "x".repeat(2_000))
        assertEquals(600, reason.length)
    }
}

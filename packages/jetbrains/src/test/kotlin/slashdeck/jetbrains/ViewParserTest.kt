package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import slashdeck.jetbrains.model.CliOutputException
import slashdeck.jetbrains.model.Guide
import slashdeck.jetbrains.model.ViewParser

class ViewParserTest {
    /** Shaped like `slashdeck scan --json` (packages/core, ResolvedView). */
    private val viewJson = """
        {
          "schemaVersion": 1,
          "claudeCodeVersion": "2.1.318",
          "source": "cli",
          "workspace": "C:/repos/project",
          "workspaceId": "0123456789abcdef",
          "scannedAt": "2026-11-27T10:00:00.000Z",
          "warnings": [{ "code": "frontmatter-malformed", "message": "bad yaml" }],
          "categoryOrder": ["project", "plugin:gxrr", "context"],
          "futureField": { "ignored": true },
          "commands": {
            "/compact": {
              "name": "/compact",
              "kind": "builtin",
              "sourcePath": null,
              "hash": "sha256:1",
              "category": "context",
              "description": "Team text",
              "argumentHint": "<instructions>",
              "guide": { "whenToUse": "When full", "example": "/compact keep tests", "related": ["/context"] },
              "origins": { "description": "team", "argumentHint": "cli", "category": "curated", "guide.whenToUse": "user-edit" },
              "pinned": true,
              "isNew": false,
              "firstSeenAt": "2026-11-01T10:00:00.000Z"
            },
            "/gxrr:wiki": {
              "name": "/gxrr:wiki",
              "kind": "plugin",
              "plugin": "gxrr",
              "sourcePath": "C:/Users/me/.claude/plugins/cache/m/gxrr/1/skills/wiki/SKILL.md",
              "hash": "sha256:2",
              "category": "plugin:gxrr",
              "origins": { "category": "derived" },
              "pinned": false,
              "isNew": true,
              "firstSeenAt": null
            },
            "/deploy": {
              "name": "/deploy", "kind": "custom-project", "sourcePath": "C:/repos/project/.claude/commands/deploy.md",
              "hash": "sha256:3", "category": "project", "description": "Deploy", "origins": {},
              "pinned": false, "isNew": false, "firstSeenAt": null
            }
          }
        }
    """.trimIndent()

    @Test
    fun `parses the resolved view`() {
        val view = ViewParser.parseView(viewJson)
        assertEquals("2.1.318", view.claudeCodeVersion)
        assertEquals("cli", view.source)
        assertFalse(view.isFallback)
        assertEquals("0123456789abcdef", view.workspaceId)
        assertEquals(listOf("frontmatter-malformed"), view.warnings.map { it.code })
        assertEquals(listOf("project", "plugin:gxrr", "context"), view.categoryOrder)
        assertEquals(listOf("/compact", "/gxrr:wiki", "/deploy"), view.commands.map { it.name })

        val compact = view.command("/compact")!!
        assertEquals("builtin", compact.kind)
        assertNull(compact.sourcePath)
        assertEquals(Guide("When full", "/compact keep tests", listOf("/context")), compact.guide)
        assertEquals("user-edit", compact.origins["guide.whenToUse"])
        assertTrue(compact.pinned)
        assertTrue(compact.hasUserEdits)
        assertTrue(compact.takesArguments)

        val wiki = view.command("/gxrr:wiki")!!
        assertEquals("gxrr", wiki.plugin)
        assertNull(wiki.description)
        assertNull(wiki.guide)
        assertTrue(wiki.isNew)
        assertNull(wiki.firstSeenAt)
        assertFalse(wiki.hasUserEdits)
        assertFalse(wiki.takesArguments)
    }

    @Test
    fun `a category missing from categoryOrder is shown last, not lost`() {
        val json = viewJson.replace("\"categoryOrder\": [\"project\", \"plugin:gxrr\", \"context\"]", "\"categoryOrder\": [\"context\"]")
        assertEquals(listOf("context", "plugin:gxrr", "project"), ViewParser.parseView(json).categoryOrder)
    }

    @Test
    fun `the fallback view is recognised`() {
        val view = ViewParser.parseView(viewJson.replace("\"source\": \"cli\"", "\"source\": \"files\"").replace("\"2.1.318\"", "null"))
        assertTrue(view.isFallback)
        assertNull(view.claudeCodeVersion)
    }

    @Test
    fun `rejects output that breaks the contract`() {
        assertThrows(CliOutputException::class.java) { ViewParser.parseView("") }
        assertThrows(CliOutputException::class.java) { ViewParser.parseView("not json") }
        assertThrows(CliOutputException::class.java) { ViewParser.parseView("[]") }
        assertThrows(CliOutputException::class.java) { ViewParser.parseView(viewJson.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2")) }
        assertThrows(CliOutputException::class.java) { ViewParser.parseView(viewJson.replace("\"categoryOrder\"", "\"categoryOrderX\"")) }
        assertThrows(CliOutputException::class.java) { ViewParser.parseView(viewJson.replace("\"pinned\": true", "\"pinned\": \"yes\"")) }
        assertThrows(CliOutputException::class.java) { ViewParser.parseView(viewJson.replace("\"kind\": \"plugin\",", "")) }
    }

    @Test
    fun `parses write results, with and without an entry`() {
        val pin = ViewParser.parseWriteResult(
            """
            {
              "action": "pin", "command": "/deploy", "workspaceId": "0123456789abcdef", "changed": true, "scope": "workspace",
              "entry": { "name": "/deploy", "kind": "custom-project", "sourcePath": "C:/x.md", "hash": "sha256:3",
                         "category": "project", "origins": {}, "pinned": true, "isNew": false, "firstSeenAt": null }
            }
            """.trimIndent(),
        )
        assertEquals("pin", pin.action)
        assertEquals("/deploy", pin.command)
        assertTrue(pin.changed)
        assertEquals("workspace", pin.scope)
        assertTrue(pin.entry!!.pinned)

        val unpin = ViewParser.parseWriteResult(
            """{ "action": "unpin", "command": "/gone", "workspaceId": "x", "changed": false, "scope": "both", "entry": null }""",
        )
        assertFalse(unpin.changed)
        assertEquals("both", unpin.scope)
        assertNull(unpin.entry)

        assertThrows(CliOutputException::class.java) {
            ViewParser.parseWriteResult("""{ "action": "pin", "command": null, "workspaceId": null, "scope": "global", "entry": null }""")
        }
    }

    @Test
    fun `withEntry replaces one command`() {
        val view = ViewParser.parseView(viewJson)
        val pinned = view.command("/deploy")!!.copy(pinned = true)
        val updated = view.withEntry(pinned)
        assertTrue(updated.command("/deploy")!!.pinned)
        assertEquals(view.commands.map { it.name }, updated.commands.map { it.name })
    }
}

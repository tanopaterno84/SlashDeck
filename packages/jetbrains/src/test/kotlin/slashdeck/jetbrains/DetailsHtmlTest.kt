package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import slashdeck.jetbrains.TestSupport.english
import slashdeck.jetbrains.TestSupport.entry
import slashdeck.jetbrains.TestSupport.italian
import slashdeck.jetbrains.model.Guide
import slashdeck.jetbrains.ui.DetailsHtml

class DetailsHtmlTest {
    private val hostile = entry("/evil<b>", "project", "custom-project") {
        copy(
            description = "<img src=\"https://tracker.example/p.png\"> <a href='https://x.example'>click</a> & <script>alert(1)</script>",
            argumentHint = "<arg onmouseover=alert(1)>",
            sourcePath = "C:/repo/.claude/commands/<x>.md",
            guide = Guide(whenToUse = "<iframe src=https://x.example>", example = "/evil \"quoted\"", related = listOf("<b>/a</b>")),
            origins = mapOf("description" to "team", "argumentHint" to "cli", "category" to "derived", "guide.whenToUse" to "user-edit"),
        )
    }

    @Test
    fun `untrusted texts cannot inject markup, links or remote content`() {
        for (html in listOf(DetailsHtml.render(hostile, english), DetailsHtml.tooltip(hostile, english))) {
            assertFalse(html, html.contains("<img"))
            assertFalse(html, html.contains("<a "))
            assertFalse(html, html.contains("<script"))
            assertFalse(html, html.contains("<iframe"))
            assertFalse(html, html.contains("<arg"))
            assertFalse(html, html.contains("<x>"))
            assertFalse(html, html.contains("/evil<b>"))
            assertTrue(html, html.contains("&lt;img src=&quot;https://tracker.example/p.png&quot;&gt;"))
        }
    }

    @Test
    fun `escape handles every markup character and keeps line breaks`() {
        assertEquals("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;<br>f", DetailsHtml.escape("a & b <c> \"d\" 'e'\r\nf"))
        assertEquals("abcd...", DetailsHtml.escape("abcdefghij", 7))
    }

    @Test
    fun `shows every field with the origin of its text`() {
        val html = DetailsHtml.render(hostile, english)
        assertTrue(html.contains("(From the team)"))
        assertTrue(html.contains("<b>When to use:</b> &lt;iframe src=https://x.example&gt; <i>(Edited by you)</i>"))
        assertTrue(html.contains("<b>Arguments:</b>"))
        assertTrue(html.contains("<i>(From Claude Code)</i>"))
        assertTrue(html.contains("<b>Example:</b> /evil &quot;quoted&quot; <i>(Origin unknown)</i>"))
        assertTrue(html.contains("<b>Related:</b> &lt;b&gt;/a&lt;/b&gt;"))
        assertTrue(html.contains("<b>Type:</b> Project command"))
        assertTrue(html.contains("<b>Group:</b> Project <i>(Assigned by SlashDeck)</i>"))
        assertTrue(html.contains("<b>Source file:</b> C:/repo/.claude/commands/&lt;x&gt;.md"))
    }

    @Test
    fun `new, pinned and missing description, in Italian`() {
        val plain = entry("/fresh", "context") { copy(isNew = true, pinned = true, firstSeenAt = "2026-11-20T10:00:00.000Z") }
        val html = DetailsHtml.render(plain, italian)
        assertTrue(html.contains("Nessuna descrizione"))
        assertTrue(html.contains("<b>Nuovo:</b> comparso il 2026-11-20"))
        assertTrue(html.contains("Nei tuoi preferiti"))
        assertFalse(html.contains("File sorgente"))
    }
}

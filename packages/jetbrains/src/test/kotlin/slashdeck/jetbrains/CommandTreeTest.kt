package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import slashdeck.jetbrains.TestSupport.english
import slashdeck.jetbrains.TestSupport.entry
import slashdeck.jetbrains.TestSupport.italian
import slashdeck.jetbrains.TestSupport.view
import slashdeck.jetbrains.model.Guide
import slashdeck.jetbrains.ui.CommandTree

class CommandTreeTest {
    private val sample = view(
        entry("/compact", "context") { copy(description = "Free up context", pinned = true) },
        entry("/clear", "session") { copy(description = "Start a new session") },
        entry("/zeta", "project", "custom-project") { copy(description = "Zeta deploy") },
        entry("/deploy", "project", "skill-project") {
            copy(description = "Deploy the app", guide = Guide(whenToUse = "Before every release"))
        },
        entry("/gxrr:wiki", "plugin:gxrr", "plugin") { copy(description = "File a document in the wiki", isNew = true) },
        entry("/team-thing", "team-tools", "custom-project") { copy(description = "Écrire une revue") },
        // The order comes from the core; the plugin never reorders categories.
        order = listOf("project", "plugin:gxrr", "team-tools", "session", "context"),
    )

    @Test
    fun `favourites first, then the categories in the order of the core`() {
        val groups = CommandTree.build(sample, "", english)
        assertEquals(
            listOf("favourites", "category:project", "category:plugin:gxrr", "category:team-tools", "category:session", "category:context"),
            groups.map { it.id },
        )
        assertEquals(listOf("Favourites", "Project", "Plugin: gxrr", "team-tools", "Session", "Context"), groups.map { it.label })
        // A pinned command is in Favourites and in its own category.
        assertEquals(listOf("/compact"), groups[0].commands.map { it.name })
        assertEquals(listOf("/compact"), groups.last().commands.map { it.name })
    }

    @Test
    fun `commands are sorted by name inside a group`() {
        val project = CommandTree.build(sample, "", english).single { it.categoryId == "project" }
        assertEquals(listOf("/deploy", "/zeta"), project.commands.map { it.name })
    }

    @Test
    fun `favourites are absent when nothing is pinned`() {
        val groups = CommandTree.build(view(entry("/clear", "session")), "", english)
        assertEquals(listOf("category:session"), groups.map { it.id })
    }

    @Test
    fun `project and team groups are open, built-in groups closed`() {
        val groups = CommandTree.build(sample, "", english).associateBy { it.id }
        assertTrue(groups.getValue("category:project").expandedByDefault)
        assertTrue(groups.getValue("category:team-tools").expandedByDefault)
        assertTrue(groups.getValue("favourites").expandedByDefault)
        assertTrue(groups.getValue("category:session").builtin)
        assertFalse(groups.getValue("category:session").expandedByDefault)
    }

    @Test
    fun `the filter keeps the commands where every word appears in name, description or when to use`() {
        fun names(filter: String) = CommandTree.build(sample, filter, english).flatMap { g -> g.commands.map { it.name } }.distinct()
        assertEquals(listOf("/deploy", "/zeta"), names("deploy"))
        assertEquals(listOf("/deploy"), names("deploy app"))
        assertEquals(listOf("/deploy"), names("RELEASE"))
        assertEquals(listOf("/gxrr:wiki"), names("/gxrr"))
        assertEquals(listOf("/team-thing"), names("ecrire"))
        assertEquals(emptyList<String>(), names("deploy wiki"))
        // While filtering, built-in groups open too, so that matches are visible.
        assertTrue(CommandTree.build(sample, "context", english).all { it.expandedByDefault })
    }

    @Test
    fun `labels are translated, unknown category IDs are shown as they are`() {
        val groups = CommandTree.build(sample, "", italian)
        assertEquals(listOf("Preferiti", "Progetto", "Plugin: gxrr", "team-tools", "Sessione", "Contesto"), groups.map { it.label })
        assertEquals("Modello e permessi", italian.category("model-permissions"))
        assertEquals("Dal team", italian.origin("team"))
        assertEquals("Origine sconosciuta", italian.origin("something-new"))
        assertEquals("Skill del progetto", italian.kind("skill-project"))
        assertEquals("Other (weird)", english.kind("weird"))
    }
}

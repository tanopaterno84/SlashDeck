package slashdeck.jetbrains

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.MessageFormat
import java.util.Locale

class BundleTest {
    private val english = TestSupport.bundle(Locale.ROOT)
    private val italian = TestSupport.bundle(Locale.ITALIAN)

    @Test
    fun `English and Italian have the same keys`() {
        // Read the files themselves: a ResourceBundle would inherit the missing keys from English.
        assertEquals(ownKeys("messages/SlashDeckBundle.properties"), ownKeys("messages/SlashDeckBundle_it.properties"))
    }

    private fun ownKeys(resource: String): List<String> {
        val properties = java.util.Properties()
        javaClass.classLoader.getResourceAsStream(resource)!!.reader(Charsets.UTF_8).use { properties.load(it) }
        return properties.stringPropertyNames().sorted()
    }

    @Test
    fun `parameters match and apostrophes survive MessageFormat`() {
        val placeholder = Regex("""\{\d}""")
        val singleQuote = Regex("""(?<!')'(?!')""")
        for (key in english.keySet()) {
            val en = english.getString(key)
            val it = italian.getString(key)
            assertEquals(key, placeholder.findAll(en).map { m -> m.value }.toSet(), placeholder.findAll(it).map { m -> m.value }.toSet())
            for (value in listOf(en, it)) {
                if (!placeholder.containsMatchIn(value)) continue
                assertFalse("$key: write an apostrophe as '' in a message with parameters: $value", singleQuote.containsMatchIn(value))
                val formatted = MessageFormat(value).format(arrayOf<Any>("A", "B", "C"))
                assertFalse("$key: $formatted", formatted.contains("{"))
            }
        }
    }

    @Test
    fun `Italian texts keep their accents and apostrophes`() {
        val messages = TestSupport.messages(Locale.ITALIAN)
        assertEquals("Il file sorgente non esiste più: x", messages.get("notice.sourceMissing", "x"))
        assertTrue(messages.get("state.loadFailed", "boom").startsWith("Non è stato possibile caricare l'elenco"))
        assertEquals("Aggiorna l'elenco", messages.get("action.refresh"))
    }
}

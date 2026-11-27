package slashdeck.jetbrains

import slashdeck.jetbrains.model.CommandEntry
import slashdeck.jetbrains.model.ResolvedView
import slashdeck.jetbrains.ui.Labels
import slashdeck.jetbrains.ui.Messages
import java.text.MessageFormat
import java.util.Locale
import java.util.ResourceBundle

/** Helpers shared by the tests. No IDE is started: these are plain JUnit tests. */
object TestSupport {
    const val BUNDLE = "messages.SlashDeckBundle"

    fun bundle(locale: Locale): ResourceBundle =
        ResourceBundle.getBundle(
            BUNDLE,
            locale,
            ResourceBundle.Control.getNoFallbackControl(ResourceBundle.Control.FORMAT_PROPERTIES),
        )

    /** Formats like the platform's BundleBase: MessageFormat only when there are parameters. */
    fun messages(locale: Locale): Messages {
        val bundle = bundle(locale)
        return Messages { key, params ->
            val value = bundle.getString(key)
            if (params.isNotEmpty() && value.contains('{')) MessageFormat(value, locale).format(params) else value
        }
    }

    val english: Labels = Labels(messages(Locale.ROOT))
    val italian: Labels = Labels(messages(Locale.ITALIAN))

    fun entry(name: String, category: String = "other", kind: String = "builtin", block: CommandEntry.() -> CommandEntry = { this }) =
        CommandEntry(
            name = name,
            kind = kind,
            category = category,
            origins = mapOf("description" to "cli", "category" to "derived"),
        ).block()

    fun view(vararg entries: CommandEntry, order: List<String>? = null, source: String = "cli") = ResolvedView(
        schemaVersion = 1,
        claudeCodeVersion = "9.9.9",
        source = source,
        workspace = "C:/repo",
        workspaceId = "0123456789abcdef",
        scannedAt = "2026-11-27T00:00:00.000Z",
        warnings = emptyList(),
        categoryOrder = order ?: entries.map { it.category }.distinct(),
        commands = entries.toList(),
    )

    /** System property set by build.gradle.kts. */
    fun property(name: String): String =
        System.getProperty(name) ?: error("system property $name is not set: run the tests with Gradle")
}

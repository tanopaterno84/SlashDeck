package slashdeck.jetbrains.ui

/** Looks up a translated UI text; [SlashDeckBundle][slashdeck.jetbrains.SlashDeckBundle] in the IDE. */
fun interface Messages {
    fun get(key: String, vararg params: Any): String
}

/**
 * Translated labels of category IDs, origins and command kinds (CLAUDE.md, "Categorie" and
 * "Trasparenza"). Category IDs are stable; unknown ones (added by a team) are shown as they are.
 * Only labels live here: the order of the categories comes from the core (`categoryOrder`).
 */
class Labels(private val messages: Messages) {
    fun text(key: String, vararg params: Any): String = messages.get(key, *params)

    fun category(id: String): String {
        if (id.startsWith(PLUGIN_PREFIX)) return text("category.plugin", id.removePrefix(PLUGIN_PREFIX))
        return if (id in KNOWN_CATEGORIES) text("category.$id") else id
    }

    /** Who wrote a text: shown next to every text, as the transparency rule requires. */
    fun origin(origin: String?): String = when (origin) {
        "cli", "local-metadata", "curated", "derived", "team", "user-edit" -> text("origin.$origin")
        else -> text("origin.unknown")
    }

    fun kind(kind: String): String =
        if (kind in KNOWN_KINDS) text("kind.$kind") else text("kind.other", kind)

    companion object {
        const val PLUGIN_PREFIX = "plugin:"

        /** Category IDs of the built-in commands: collapsed by default, marked "built-in". */
        val BUILTIN_CATEGORY_IDS = setOf("session", "context", "model-permissions", "review-git", "mcp-plugins", "config", "other")

        private val KNOWN_CATEGORIES = setOf("project", "personal", "synced") + BUILTIN_CATEGORY_IDS

        private val KNOWN_KINDS = setOf(
            "builtin", "custom-user", "custom-project", "skill-user", "skill-synced", "skill-project", "plugin", "unknown",
        )
    }
}

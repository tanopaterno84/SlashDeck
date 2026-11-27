package slashdeck.jetbrains.ui

import slashdeck.jetbrains.model.CommandEntry
import slashdeck.jetbrains.model.ResolvedView
import java.text.Normalizer

/** One group of the tree: Favourites (no category) or a category. */
data class GroupNode(
    /** Unique in the tree: `favourites` or `category:<id>`. */
    val id: String,
    /** Null for Favourites. */
    val categoryId: String?,
    val label: String,
    val builtin: Boolean,
    val expandedByDefault: Boolean,
    val commands: List<CommandEntry>,
)

/**
 * The tree of the tool window, from a resolved view: "Favourites" first (absent when nothing
 * pinned matches), then one group per category in the order given by the core
 * (`categoryOrder`). Commands are sorted by name inside each group. No platform classes, so it
 * is tested without an IDE.
 */
object CommandTree {
    const val FAVOURITES_ID = "favourites"

    fun build(view: ResolvedView, filter: String, labels: Labels): List<GroupNode> {
        val words = filterWords(filter)
        val visible = view.commands
            .filter { matches(it, words) }
            .sortedBy { it.name }
        val groups = mutableListOf<GroupNode>()

        val pinned = visible.filter { it.pinned }
        if (pinned.isNotEmpty()) {
            groups += GroupNode(
                id = FAVOURITES_ID,
                categoryId = null,
                label = labels.text("group.favourites"),
                builtin = false,
                expandedByDefault = true,
                commands = pinned,
            )
        }
        val byCategory = visible.groupBy { it.category }
        for (id in view.categoryOrder) {
            val members = byCategory[id] ?: continue
            val builtin = id in Labels.BUILTIN_CATEGORY_IDS
            groups += GroupNode(
                id = "category:$id",
                categoryId = id,
                label = labels.category(id),
                builtin = builtin,
                // The project's and the team's commands are what the view is for: open by default.
                expandedByDefault = !builtin || words.isNotEmpty(),
                commands = members,
            )
        }
        return groups
    }

    /** Lower case, without accents. */
    fun normalize(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFD).replace(Regex("""\p{M}+"""), "").lowercase()

    /** The words of the filter, without a leading "/" (so "/rev" finds "/review"). */
    fun filterWords(filter: String): List<String> =
        normalize(filter).split(Regex("""\s+""")).map { it.trimStart('/') }.filter { it.isNotEmpty() }.distinct()

    /**
     * Every word must appear, as plain text, in the name, the argument hint, the description
     * or the "when to use" text of the command. No ranking, no stemming.
     */
    fun matches(entry: CommandEntry, words: List<String>): Boolean {
        if (words.isEmpty()) return true
        val haystack = normalize(
            listOfNotNull(entry.name, entry.argumentHint, entry.description, entry.guide?.whenToUse).joinToString("\n"),
        )
        return words.all { haystack.contains(it) }
    }
}

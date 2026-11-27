package slashdeck.jetbrains.ui

import slashdeck.jetbrains.model.CommandEntry

/**
 * HTML of the details area and of the tree tooltip.
 *
 * Every text that comes from a command (name, description, argument hint, guide, path) was
 * written by someone else and is untrusted: it is escaped with [escape], so it can never become
 * a tag, a link, an image or any other remote content. Only the fixed markup below is HTML.
 */
object DetailsHtml {
    /** Longest text shown per field. */
    const val MAX_TEXT_CHARS = 2_000
    const val MAX_TOOLTIP_CHARS = 300

    /** Escapes the characters that are markup in HTML; keeps line breaks as `<br>`. */
    fun escape(text: String, max: Int = MAX_TEXT_CHARS): String {
        val cut = if (text.length <= max) text else text.take(max - 3) + "..."
        val out = StringBuilder(cut.length + 16)
        for (c in cut) {
            when (c) {
                '&' -> out.append("&amp;")
                '<' -> out.append("&lt;")
                '>' -> out.append("&gt;")
                '"' -> out.append("&quot;")
                '\'' -> out.append("&#39;")
                '\n' -> out.append("<br>")
                '\r' -> {}
                else -> out.append(c)
            }
        }
        return out.toString()
    }

    fun render(entry: CommandEntry, labels: Labels): String {
        val html = StringBuilder("<html><body>")
        val hint = entry.argumentHint?.trim().orEmpty()
        html.append("<p><b>").append(escape(entry.name, 300)).append("</b>")
        if (hint.isNotEmpty()) html.append(" <code>").append(escape(hint, 300)).append("</code>")
        if (entry.isNew) html.append(" &nbsp;<b>").append(escape(labels.text("details.newBadge"))).append("</b>")
        html.append("</p>")

        val description = entry.description?.trim().orEmpty()
        html.append("<p>")
        if (description.isEmpty()) {
            html.append("<i>").append(escape(labels.text("details.noDescription"))).append("</i>")
        } else {
            html.append(escape(description)).append("<br>").append(origin(entry, "description", labels))
        }
        html.append("</p>")

        val rows = mutableListOf<String>()
        if (hint.isNotEmpty()) rows += row(labels.text("details.arguments"), escape(hint, 300), entry, "argumentHint", labels)
        entry.guide?.whenToUse?.let { rows += row(labels.text("details.whenToUse"), escape(it), entry, "guide.whenToUse", labels) }
        entry.guide?.example?.let { rows += row(labels.text("details.example"), escape(it), entry, "guide.example", labels) }
        entry.guide?.related?.takeIf { it.isNotEmpty() }?.let { related ->
            rows += row(labels.text("details.related"), related.joinToString(", ") { escape(it, 120) }, entry, "guide.related", labels)
        }
        if (rows.isNotEmpty()) html.append("<p>").append(rows.joinToString("<br>")).append("</p>")

        val about = mutableListOf<String>()
        about += "<b>${escape(labels.text("details.type"))}:</b> ${escape(labels.kind(entry.kind))}"
        about += "<b>${escape(labels.text("details.group"))}:</b> ${escape(labels.category(entry.category), 200)} " +
            origin(entry, "category", labels)
        entry.sourcePath?.let { about += "<b>${escape(labels.text("details.sourceFile"))}:</b> ${escape(it, 500)}" }
        if (entry.isNew && entry.firstSeenAt != null) {
            about += "<b>${escape(labels.text("details.new"))}:</b> " +
                escape(labels.text("details.firstSeen", entry.firstSeenAt.take(10)))
        }
        if (entry.pinned) about += "<i>${escape(labels.text("details.pinned"))}</i>"
        html.append("<p>").append(about.joinToString("<br>")).append("</p>")
        return html.append("</body></html>").toString()
    }

    /** Short tooltip of a tree row: name, argument hint and description, escaped. */
    fun tooltip(entry: CommandEntry, labels: Labels): String {
        val hint = entry.argumentHint?.trim().orEmpty()
        val description = entry.description?.trim().orEmpty()
        val text = if (description.isEmpty()) "<i>${escape(labels.text("details.noDescription"))}</i>"
        else escape(description, MAX_TOOLTIP_CHARS)
        return "<html><b>${escape(entry.name, 200)}</b>" +
            (if (hint.isEmpty()) "" else " " + escape(hint, 100)) +
            "<br>$text</html>"
    }

    private fun row(name: String, value: String, entry: CommandEntry, field: String, labels: Labels): String =
        "<b>${escape(name)}:</b> $value ${origin(entry, field, labels)}"

    private fun origin(entry: CommandEntry, field: String, labels: Labels): String =
        "<i>(${escape(labels.origin(entry.origins[field]))})</i>"
}

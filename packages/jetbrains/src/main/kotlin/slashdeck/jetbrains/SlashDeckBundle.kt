package slashdeck.jetbrains

import com.intellij.DynamicBundle
import org.jetbrains.annotations.Nls
import org.jetbrains.annotations.PropertyKey
import slashdeck.jetbrains.ui.Labels
import slashdeck.jetbrains.ui.Messages

private const val BUNDLE = "messages.SlashDeckBundle"

/** UI texts: English by default, Italian in `SlashDeckBundle_it.properties`. */
object SlashDeckBundle : DynamicBundle(SlashDeckBundle::class.java, BUNDLE) {
    @Nls
    fun message(@PropertyKey(resourceBundle = BUNDLE) key: String, vararg params: Any): String =
        getMessage(key, *params)

    val messages: Messages = Messages { key, params -> getMessage(key, *params) }

    val labels: Labels get() = Labels(messages)
}

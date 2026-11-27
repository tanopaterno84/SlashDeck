package slashdeck.jetbrains.settings

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service

/** Application settings. Paths are machine-specific, so they do not roam. */
@Service(Service.Level.APP)
@State(name = "SlashDeckSettings", storages = [Storage("slashdeck.xml", roamingType = RoamingType.DISABLED)])
class SlashDeckSettings : SimplePersistentStateComponent<SlashDeckSettings.Settings>(Settings()) {
    class Settings : BaseState() {
        /** Node.js executable; empty = the IDE's interpreter or `node` on the PATH. */
        var nodePath by string()

        /** Use the Node.js interpreter configured in the IDE (with the JavaScript plugin). */
        var useIdeNodeInterpreter by property(true)

        /** Claude Code executable, passed to the CLI as `--claude-path`; empty = PATH. */
        var claudePath by string()
    }

    companion object {
        fun getInstance(): SlashDeckSettings = service()
    }
}

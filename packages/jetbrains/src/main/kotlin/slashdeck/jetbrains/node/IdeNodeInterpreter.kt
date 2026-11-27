package slashdeck.jetbrains.node

import com.intellij.openapi.diagnostic.ControlFlowException
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.project.Project

/**
 * The Node.js interpreter configured in the IDE (Settings | Languages & Frameworks | Node.js).
 * Implemented only in slashdeck-javascript.xml, loaded when the JavaScript plugin is present;
 * in other IDEs SlashDeck simply looks for `node` on the PATH.
 */
interface IdeNodeInterpreterProvider {
    /** Path of a local Node.js executable, or null (none set, or a remote/WSL interpreter). */
    fun localNodePath(project: Project): String?

    companion object {
        val EP_NAME = ExtensionPointName.create<IdeNodeInterpreterProvider>("slashdeck.placeholder.nodeInterpreterProvider")

        private val LOG = logger<IdeNodeInterpreterProvider>()

        fun find(project: Project): String? =
            EP_NAME.extensionList.firstNotNullOfOrNull { provider ->
                try {
                    provider.localNodePath(project)
                } catch (e: LinkageError) {
                    LOG.warn("Node.js interpreter integration unavailable", e)
                    null
                } catch (e: RuntimeException) {
                    if (e is ControlFlowException) throw e
                    LOG.warn("cannot read the Node.js interpreter of the IDE", e)
                    null
                }
            }
    }
}

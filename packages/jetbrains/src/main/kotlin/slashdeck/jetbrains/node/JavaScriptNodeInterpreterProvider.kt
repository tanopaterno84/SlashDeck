package slashdeck.jetbrains.node

import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.openapi.project.Project

/** Reads the project's Node.js interpreter from the JavaScript plugin (optional dependency). */
class JavaScriptNodeInterpreterProvider : IdeNodeInterpreterProvider {
    override fun localNodePath(project: Project): String? {
        val interpreter = NodeJsInterpreterManager.getInstance(project).interpreter ?: return null
        return NodeJsLocalInterpreter.tryCast(interpreter)?.interpreterSystemDependentPath
    }
}

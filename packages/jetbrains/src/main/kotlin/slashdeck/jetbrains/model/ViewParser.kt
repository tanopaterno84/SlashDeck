package slashdeck.jetbrains.model

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/** The CLI printed something that does not follow its JSON contract. */
class CliOutputException(message: String) : Exception(message)

/**
 * Reads the JSON printed by the CLI. Fields the plugin needs are checked; unknown fields are
 * ignored, so that a newer core can add some without breaking the plugin. Uses only the JSON
 * tree of kotlinx.serialization (bundled with the IDE), no generated serializers.
 */
object ViewParser {
    const val SUPPORTED_SCHEMA_VERSION = 1

    fun parseView(text: String): ResolvedView {
        val root = parseObject(text, "view")
        val schemaVersion = root.int("schemaVersion")
        if (schemaVersion != SUPPORTED_SCHEMA_VERSION) {
            throw CliOutputException("unsupported schemaVersion $schemaVersion")
        }
        val commands = root.obj("commands").entries.map { (key, value) ->
            parseEntry(value.asObject("commands.$key"))
        }
        // The core always prints categoryOrder. Should a category be missing from it all the
        // same, it is shown last rather than lost.
        val order = root.stringList("categoryOrder")
        val missing = commands.map { it.category }.distinct().filter { it !in order }.sorted()
        return ResolvedView(
            schemaVersion = schemaVersion,
            claudeCodeVersion = root.optString("claudeCodeVersion"),
            source = root.string("source"),
            workspace = root.string("workspace"),
            workspaceId = root.string("workspaceId"),
            scannedAt = root.string("scannedAt"),
            warnings = root.array("warnings").mapIndexed { i, w ->
                val o = w.asObject("warnings[$i]")
                ScanWarning(code = o.string("code"), message = o.string("message"))
            },
            categoryOrder = order.distinct() + missing,
            commands = commands,
        )
    }

    fun parseWriteResult(text: String): WriteResult {
        val root = parseObject(text, "write result")
        return WriteResult(
            action = root.string("action"),
            command = root.optString("command"),
            workspaceId = root.optString("workspaceId"),
            changed = root.boolean("changed"),
            scope = root.string("scope"),
            entry = root["entry"]?.takeUnless { it is JsonNull }?.let { parseEntry(it.asObject("entry")) },
        )
    }

    fun parseEntry(o: JsonObject): CommandEntry {
        val guide = o["guide"]?.takeUnless { it is JsonNull }?.asObject("guide")?.let { g ->
            Guide(
                whenToUse = g.optString("whenToUse"),
                example = g.optString("example"),
                related = g["related"]?.takeUnless { it is JsonNull }?.let { g.stringList("related") },
            )
        }
        return CommandEntry(
            name = o.string("name"),
            kind = o.string("kind"),
            plugin = o.optString("plugin"),
            sourcePath = o.optString("sourcePath"),
            hash = o.optString("hash") ?: "",
            category = o.string("category"),
            description = o.optString("description"),
            argumentHint = o.optString("argumentHint"),
            guide = guide,
            origins = o["origins"]?.takeUnless { it is JsonNull }?.asObject("origins")
                ?.entries
                ?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.let { k to it.content } }
                ?.toMap()
                ?: emptyMap(),
            pinned = o.boolean("pinned"),
            isNew = o.boolean("isNew"),
            firstSeenAt = o.optString("firstSeenAt"),
        )
    }

    private fun parseObject(text: String, what: String): JsonObject {
        val element = try {
            Json.parseToJsonElement(text)
        } catch (e: SerializationException) {
            throw CliOutputException("the $what is not valid JSON: ${e.message?.lineSequence()?.firstOrNull()}")
        } catch (e: IllegalArgumentException) {
            throw CliOutputException("the $what is not valid JSON: ${e.message?.lineSequence()?.firstOrNull()}")
        }
        return element.asObject(what)
    }

    private fun JsonElement.asObject(path: String): JsonObject =
        this as? JsonObject ?: throw CliOutputException("$path: expected an object")

    private fun JsonObject.string(key: String): String {
        val value = this[key] as? JsonPrimitive
        if (value == null || !value.isString) throw CliOutputException("$key: expected a string")
        return value.content
    }

    private fun JsonObject.optString(key: String): String? {
        val value = this[key] ?: return null
        if (value is JsonNull) return null
        val primitive = value as? JsonPrimitive
        if (primitive == null || !primitive.isString) throw CliOutputException("$key: expected a string or null")
        return primitive.content
    }

    private fun JsonObject.int(key: String): Int =
        (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
            ?: throw CliOutputException("$key: expected a number")

    private fun JsonObject.boolean(key: String): Boolean =
        (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
            ?: throw CliOutputException("$key: expected true or false")

    private fun JsonObject.obj(key: String): JsonObject =
        this[key] as? JsonObject ?: throw CliOutputException("$key: expected an object")

    private fun JsonObject.array(key: String): JsonArray =
        this[key] as? JsonArray ?: throw CliOutputException("$key: expected an array")

    private fun JsonObject.stringList(key: String): List<String> =
        array(key).mapIndexed { i, e ->
            (e as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw CliOutputException("$key[$i]: expected a string")
        }
}

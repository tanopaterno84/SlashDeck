import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
}

group = "slashdeck.placeholder"
version = "0.1.0"

// The single-file CLI of the core (packages/core, `pnpm -r build`). The plugin ships it and
// runs it with Node: it holds all the discovery, cache and state logic.
val coreCli: File = layout.projectDirectory.file("../core/dist/slashdeck.mjs").asFile
val testFixtures: File = layout.projectDirectory.dir("src/test/fixtures").asFile

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // IntelliJ Platform 2026.1 bundles the Kotlin 2.3 standard library.
        apiVersion.set(KotlinVersion.KOTLIN_2_3)
        languageVersion.set(KotlinVersion.KOTLIN_2_3)
        // Inherit the platform's interface default methods instead of generating stubs that
        // override them (the Plugin Verifier reports those stubs as uses of deprecated API).
        jvmDefault.set(JvmDefaultMode.NO_COMPATIBILITY)
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    intellijPlatform {
        // Build platform: the oldest WebStorm the plugin supports (branch 261 = 2026.1).
        webstorm("2026.1.5.2")
        // Optional integrations, declared as optional <depends> in plugin.xml.
        bundledPlugins("JavaScript", "org.jetbrains.plugins.terminal")
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    // No settings page needs a search index, and the build must not start an IDE.
    buildSearchableOptions = false
    // Kotlin only: no forms and no @NotNull instrumentation needed.
    instrumentCode = false

    pluginConfiguration {
        ideaVersion {
            sinceBuild = "261"
            untilBuild = "263.*"
        }
    }

    pluginVerification {
        ides {
            create(IntelliJPlatformType.WebStorm, "2026.3.0.1")
        }
    }
}

/** Fails the build when the core CLI has not been built, instead of shipping a plugin without it. */
val checkCoreCli = tasks.register("checkCoreCli") {
    val cli = coreCli
    inputs.property("cliPath", cli.absolutePath)
    doLast {
        if (!cli.isFile) {
            throw GradleException(
                "SlashDeck: the core CLI is missing: ${cli.absolutePath}\n" +
                    "Build it first from the repository root with `pnpm install` and `pnpm -r build` " +
                    "(or `pnpm --filter @slashdeck/core build`). The plugin cannot work without it.",
            )
        }
    }
}

tasks {
    prepareSandbox {
        dependsOn(checkCoreCli)
        // <sandbox>/plugins/<plugin>/cli/slashdeck.mjs, next to lib/: found at runtime from the
        // plugin's install folder (SlashDeckProjectService.bundledCli). The zip of buildPlugin has the same layout.
        from(coreCli) {
            into(intellijPlatform.projectName.map { "$it/cli" })
        }
    }

    test {
        dependsOn(checkCoreCli)
        inputs.file(coreCli)
        inputs.dir(testFixtures)
        systemProperty("slashdeck.cli", coreCli.absolutePath)
        systemProperty("slashdeck.fixtures", testFixtures.absolutePath)
        // The tests never touch the user's folders nor start the real Claude Code: cache and
        // state go to the build folder, the Claude folder is a fixture, and Claude Code is a
        // path that does not exist (fallback mode), unless a test passes a fake one.
        val sandbox = layout.buildDirectory.dir("slashdeck-test-env").get().asFile
        environment("SLASHDECK_CACHE_DIR", sandbox.resolve("cache").absolutePath)
        environment("SLASHDECK_CONFIG_DIR", sandbox.resolve("config").absolutePath)
        environment("CLAUDE_CONFIG_DIR", testFixtures.resolve("home/.claude").absolutePath)
        environment("SLASHDECK_CLAUDE_PATH", sandbox.resolve("no-claude/claude.exe").absolutePath)
        doFirst { sandbox.deleteRecursively() }
    }
}

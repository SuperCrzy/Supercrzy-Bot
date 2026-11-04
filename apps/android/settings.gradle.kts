// SUPERCRZY BOT · Android shell
//
// Kept deliberately free of Compose: this module only hosts the existing Vue
// client in a WebView plus the native bridges the browser cannot provide
// (back key, file chooser, downloads, notifications, keep-alive). Every extra
// plugin is another version to keep in sync, and none of it buys UI parity.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "supercrzy-bot-android"
include(":app")

// The core (format, hashing, sealing) is plain Kotlin and builds anywhere with a JDK.
// The recorder is a separate build in recorder/ (it needs the Android SDK and includes this core).
pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}
dependencyResolutionManagement {
    repositories {
        // Only Android and Google packages come from Google's repository.
        google {
            content {
                includeGroupByRegex("androidx\\..*")
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google\\.android.*")
            }
        }
        mavenCentral()
    }
}
rootProject.name = "attest-capture-android"
include(":core")

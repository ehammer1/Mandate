// The core (format, hashing, sealing) is plain Kotlin and builds anywhere with a JDK.
// The recorder needs the Android SDK and is included only when one is present.
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
if (System.getenv("ANDROID_HOME") != null || file("local.properties").exists()) {
    include(":recorder")
}

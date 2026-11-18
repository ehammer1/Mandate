// Android build for the recorder. Needs the Android SDK (ANDROID_HOME or local.properties).
// Includes the plain-Kotlin core from ../core.
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
rootProject.name = "attest-capture-recorder"
include(":core")
project(":core").projectDir = file("../core")

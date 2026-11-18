// Needs the Android SDK. Build from this folder: gradle assembleDebug
plugins {
    id("com.android.library") version "8.7.3"
    kotlin("android") version "2.0.21"
    kotlin("jvm") version "2.0.21" apply false // used by :core
}

android {
    namespace = "attest.capture.android"
    compileSdk = 35
    defaultConfig { minSdk = 28 } // StrongBox and key attestation challenges
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":core"))
    // Versions to confirm on first build.
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.media3:media3-muxer:1.6.0")
    implementation("androidx.media3:media3-common:1.6.0")
}

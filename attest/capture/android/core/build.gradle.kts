plugins {
    kotlin("jvm")
}

// Java 17 bytecode, so the same code runs on Android.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    // Shared vectors live in capture/vectors.
    systemProperty("vectors", rootProject.projectDir.resolve("../vectors").canonicalPath)
    systemProperty("outDir", layout.buildDirectory.dir("vector-out").get().asFile.path)
}

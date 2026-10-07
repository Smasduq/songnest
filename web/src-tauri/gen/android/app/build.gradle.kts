import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    // SongnestPy: embedded CPython + yt-dlp for the on-device backend.
    // (AGP 9.3.1 is above Chaquopy's tested 9.2.x ceiling; bump with care.)
    id("com.chaquo.python") version "17.0.0"
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    // compile/target 36 = latest stable platform (37 is a preview not on
    // the public SDK repo, so CI cannot install it).
    compileSdk = 36
    namespace = "com.songnest.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.songnest.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        ndk {
            // Chaquopy needs explicit ABIs; match Tauri's four Rust targets.
            // armeabi-v7a (this phone) only goes up to Python 3.11.
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

// SongnestPy: Python 3.11 is the newest the 32-bit ABI takes.
chaquopy {
    defaultConfig {
        version = "3.11"
        // Host interpreter for building the device env (Chaquopy needs a
        // host Python of the same major.minor). CI provides 3.11 via
        // SONGNEST_BUILD_PYTHON; local dev boxes set it too when the
        // system Python is some other version. Unset => Chaquopy default.
        val songnestBuildPython = System.getenv("SONGNEST_BUILD_PYTHON")
        if (songnestBuildPython != null) {
            buildPython(songnestBuildPython)
        }
        pip {
            // pinned: yt-dlp's native-optional deps are skipped on device,
            // core (pure Python) is all the bridge needs
            install("yt-dlp==2026.08.19")
        }
    }
}

apply(from = file("tauri.build.gradle.kts"))

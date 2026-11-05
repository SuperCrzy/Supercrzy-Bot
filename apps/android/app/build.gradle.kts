import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// versionName mirrors the repo root package.json so an APK can always be traced
// back to a release. versionCode must increase monotonically: CI passes the run
// number, local builds fall back to 1.
val repoVersion: String = run {
    val pkg = rootProject.file("../../package.json")
    if (pkg.exists()) {
        val props = Properties()
        pkg.inputStream().use { props.load(it) }
        props.getProperty("version", "0.0.0")
    } else {
        "0.0.0"
    }
}
val buildNumber: Int = (System.getenv("ANDROID_VERSION_CODE") ?: "1").toIntOrNull() ?: 1

android {
    namespace = "com.supercrzy.bot"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.supercrzy.bot"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = repoVersion
        // Only arm64 for now: every device we target is arm64 and it halves the APK.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            // Signed with the debug key unless a real keystore is supplied. This
            // keeps `assembleRelease` usable in CI before we have a release key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            // proot and node ship as fake native libs: jniLibs is the only location
            // Android still allows execve from on API 29+.
            jniLibs.srcDir("runtime/jniLibs")
        }
    }

    androidResources {
        // The rootfs is already gzip-compressed; double compression wastes CPU.
        noCompress += "tgz"
    }

    buildFeatures {
        // BuildConfig.DEBUG gates WebView remote debugging; AGP 8 turns it off by default.
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/*.version")
        jniLibs {
            // Extract libs to disk (execve needs a real file, not an APK mmap) and
            // never let the strip step touch our foreign ELF binaries.
            useLegacyPackaging = true
            keepDebugSymbols += "**/libproot.so"
            keepDebugSymbols += "**/libnode.so"
        }
    }
}

dependencies {
    // Deliberately tiny: Activity (ResultLauncher + back dispatcher) and Core (NotificationCompat).
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
}

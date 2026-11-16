plugins {
    id("com.android.application")
    id("com.chaquo.python")
}

android {
    namespace = "org.marsexplorer.evaplanner"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.marsexplorer.evaplanner"
        minSdk = 24
        targetSdk = 35
        versionCode = 3
        versionName = "1.1.1"
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")  // phones, and the emulator the build workflow tests on
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

chaquopy {
    defaultConfig {
        version = "3.10"  // the newest Python that Chaquopy has scipy for
        pip {
            install("-r", "requirements.txt")
        }
    }
    sourceSets {
        getByName("main") {
            srcDir("build/planner")  // filled by bundlePlanner below
        }
    }
}

// The backend, the data it reads and the built frontend, copied in at build time (the repository keeps one copy).
val bundlePlanner by tasks.registering(Sync::class) {
    val web = rootProject.file("../frontend/dist")
    doFirst {
        check(web.resolve("index.html").exists()) { "Build the frontend first: run `npm run build` in frontend." }
    }
    into(layout.buildDirectory.dir("planner"))
    from(rootProject.file("../backend/app")) {
        into("app")
        exclude("__pycache__")
    }
    from(rootProject.file("../backend/data")) {
        into("data")
        include("*.npz", "*.json", "overlays/**", "photos/**")  // not the pipeline's raw downloads in data/cache
    }
    from(web) {
        into("web")
    }
}
// Chaquopy's tasks that read the Python sources (mergeDebugPythonSources, ...) must run after the copy.
tasks.matching { it.name.endsWith("PythonSources") }.configureEach {
    dependsOn(bundlePlanner)
}

package com.supercrzy.bot

import android.content.Context
import android.util.Log
import java.io.File
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/**
 * Owns the on-device agent runtime: extracts the rootfs on first run, boots our
 * Node server inside proot, and health-checks it.
 *
 * The two executables ship as jniLibs (`libproot.so`, `libnode.so`) because
 * Android 10+ blocks execve of files in app-writable storage — the system extracts
 * jniLibs to nativeLibraryDir with the exec bit set, and proot binds `libnode.so`
 * onto /usr/local/bin/node inside the guest so `node dist/app.js` resolves to an
 * executable the OS actually permits. Everything else in the rootfs is data:
 * proot reads and mmaps, nothing else is ever execve'd.
 *
 * All state lives under filesDir/runtime. The database is mounted in from
 * filesDir/data so an app update that replaces the rootfs keeps user data.
 */
object RuntimeHost {

    private const val TAG = "RuntimeHost"
    private const val ASSET_ROOTFS = "runtime/rootfs.tgz"
    private const val ASSET_VERSION = "runtime/rootfs.version"

    data class State(
        val status: Status,
        val url: String? = null,
        val message: String? = null,
    )

    enum class Status { IDLE, EXTRACTING, STARTING, RUNNING, FAILED }

    private val state = AtomicReference(State(Status.IDLE))
    private var process: Process? = null
    private var port: Int = 3000

    @Volatile
    private var startedOnce = false

    fun snapshot(): State = state.get()

    /** True when the stored/default address points at this device. */
    fun isLocal(url: String): Boolean =
        url.contains("127.0.0.1") || url.contains("localhost")

    fun currentUrl(context: Context): String = "http://127.0.0.1:${port()}"

    private fun port(): Int {
        if (!startedOnce) return 3000
        return port
    }

    /**
     * Idempotent. Returns once the runtime answers /api/health (ok = true) or the
     * failure is understood (ok = false, message explains). Callback runs on an
     * arbitrary thread — callers hop to the UI thread.
     */
    @Synchronized
    fun ensureStarted(context: Context, callback: (State) -> Unit) {
        val running = state.get()
        if (running.status == Status.RUNNING && isHealthy(running.url!!)) {
            callback(running)
            return
        }

        Thread {
            try {
                setState(State(Status.EXTRACTING))
                val rootfsDir = ensureExtracted(context)

                setState(State(Status.STARTING))
                val chosenPort = freePort()
                val proc = startProot(context, rootfsDir, chosenPort)
                process = proc
                port = chosenPort

                val deadline = System.currentTimeMillis() + 60_000
                var healthy = false
                while (System.currentTimeMillis() < deadline) {
                    if (proc.exitValueOrNull() != null) break
                    if (isHealthy("http://127.0.0.1:$chosenPort")) { healthy = true; break }
                    Thread.sleep(600)
                }

                startedOnce = true
                if (healthy) {
                    val url = "http://127.0.0.1:$chosenPort"
                    val next = State(Status.RUNNING, url = url)
                    state.set(next)
                    callback(next)
                } else {
                    val tail = proc.takeStderrTail()
                    proc.destroy()
                    val next = State(
                        Status.FAILED,
                        message = if (tail.isBlank()) "runtime exited without output" else tail,
                    )
                    state.set(next)
                    callback(next)
                }
            } catch (error: Exception) {
                Log.e(TAG, "runtime start failed", error)
                val next = State(Status.FAILED, message = error.message ?: error.javaClass.simpleName)
                state.set(next)
                callback(next)
            }
        }.start()
    }

    fun stop() {
        runCatching { process?.destroy() }
        process = null
        state.set(State(Status.IDLE))
    }

    // ---- extraction ---------------------------------------------------------

    private fun ensureExtracted(context: Context): File {
        val runtimeDir = File(context.filesDir, "runtime")
        val marker = File(runtimeDir, "rootfs.version")
        val wanted = context.assets.open(ASSET_VERSION).bufferedReader().readText().trim()

        if (marker.exists() && marker.readText().trim() == wanted &&
            File(runtimeDir, "rootfs/bot/package.json").exists()
        ) {
            return File(runtimeDir, "rootfs")
        }

        // Extract to a sibling then swap, so an interrupted first run never leaves a
        // half-written rootfs that later looks complete.
        val staging = File(runtimeDir, "rootfs.staging")
        staging.deleteRecursively()
        staging.mkdirs()

        val asset = File.createTempFile("rootfs", ".tgz", context.cacheDir)
        context.assets.open(ASSET_ROOTFS).use { input ->
            asset.outputStream().use { input.copyTo(it) }
        }
        val entries = TarExtractor.extractGzip(asset, staging)
        asset.delete()
        require(entries > 0) { "rootfs archive extracted nothing" }

        val final = File(runtimeDir, "rootfs")
        final.deleteRecursively()
        if (!staging.renameTo(final)) {
            // renameTo can fail across mount points; copy as the fallback.
            staging.copyRecursively(final, overwrite = true)
            staging.deleteRecursively()
        }
        marker.parentFile?.mkdirs()
        marker.writeText(wanted)
        return final
    }

    // ---- proot --------------------------------------------------------------

    private fun startProot(context: Context, rootfsDir: File, port: Int): Process {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val proot = File(nativeDir, "libproot.so")
        val node = File(nativeDir, "libnode.so")
        require(proot.exists()) { "libproot.so missing from jniLibs" }
        require(node.exists()) { "libnode.so missing from jniLibs" }

        val dataDir = File(context.filesDir, "data").apply { mkdirs() }
        val tmpDir = File(context.cacheDir, "rootfs-tmp").apply { mkdirs() }

        val command = listOf(
            proot.absolutePath,
            "--kill-on-exit",
            "-0", // pretend to be root: the guest expects uid 0 paths
            "-r", rootfsDir.absolutePath,
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-b", "${dataDir.absolutePath}:/bot/data",
            "-b", "${tmpDir.absolutePath}:/tmp",
            "-b", "${node.absolutePath}:/usr/local/bin/node",
            "-w", "/bot",
            "/usr/local/bin/node",
            "--max-old-space-size=384",
            "/bot/dist/app.js",
        )

        val env = mutableMapOf(
            "HOME" to "/root",
            "PATH" to "/usr/local/bin:/usr/bin:/bin",
            "TERM" to "xterm-256color",
            "LANG" to "C.UTF-8",
            "TMPDIR" to "/tmp",
            "PORT" to port.toString(),
            "HOST" to "127.0.0.1",
            "DB_PATH" to "/bot/data/supercrzy.db",
            "WORKSPACE_DIR" to "/bot/data/workspace",
            "NODE_ENV" to "production",
            // The login flow opens the system browser on desktop; on the phone the
            // callback must come back to our own WebView, so never try to spawn a GUI.
            "SUPERCRZY_NO_OPEN" to "1",
        )
        // Keep the app's own environment out: a desktop shell env (HTTP_PROXY and
        // friends) would otherwise leak into the guest.
        return ProcessBuilder(command).apply { environment().clear(); environment().putAll(env) }
            .directory(context.filesDir)
            .start()
    }

    // ---- helpers ------------------------------------------------------------

    /** Public health probe — used by the legacy-chroot fallback in MainActivity. */
    fun probe(url: String): Boolean = isHealthy(url)

    private fun isHealthy(url: String): Boolean = runCatching {
        URL("$url/api/health").openConnection().let { connection ->
            (connection as java.net.HttpURLConnection).connectTimeout = 1200
            connection.readTimeout = 1200
            connection.responseCode == 200
        }
    }.getOrDefault(false)

    private fun freePort(): Int =
        ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress()).use { it.localPort }

    private fun Process.exitValueOrNull(): Int? =
        runCatching { exitValue() }.getOrNull()

    private fun Process.takeStderrTail(): String =
        runCatching { errorStream.bufferedReader().readText().lineSequence().lastOrNull { it.isNotBlank() } ?: "" }
            .getOrDefault("")

    private fun setState(next: State) {
        state.set(next)
        Log.i(TAG, "runtime: ${next.status} ${next.message.orEmpty().take(160)}")
    }
}

package com.supercrzy.bot

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * File-based command bridge between the agent (running inside proot) and the app's
 * native capabilities (accessibility, WebView).
 *
 * Why files and not a socket: the proot runtime mounts filesDir/data at /bot/data,
 * so both sides see the same directory with zero networking, zero ports and zero
 * permissions. Latency is ~200 ms per action — fine for UI automation.
 *
 * Contract:
 *   request  /bot/data/device/req/<id>.json   {"id","kind","args":{...}}
 *   response /bot/data/device/resp/<id>.json  {"id","ok":true|false,"data"|"error"}
 * Kinds:
 *   snapshot | tap | swipe | text | key | launch | browser_navigate |
 *   browser_snapshot | browser_click | browser_type | browser_back
 *
 * Browser commands answer asynchronously (the WebView JS callback writes the
 * response later); [execute] signals that by returning null.
 */
class DeviceCommandWorker private constructor(private val context: Context) {

    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var pollRunnable: Runnable? = null

    private val reqDir: File get() = File(context.filesDir, "data/device/req")
    private val respDir: File get() = File(context.filesDir, "data/device/resp")

    fun start() {
        if (running) return
        running = true
        reqDir.mkdirs()
        respDir.mkdirs()
        tick()
        Log.i(TAG, "device command worker started")
    }

    fun stop() {
        running = false
        pollRunnable?.let { handler.removeCallbacks(it) }
    }

    private fun tick() {
        if (!running) return
        try {
            pollOnce()
        } catch (error: Throwable) {
            Log.w(TAG, "poll error: ${error.message}")
        }
        val next = Runnable { tick() }
        pollRunnable = next
        handler.postDelayed(next, POLL_MS)
    }

    private fun pollOnce() {
        val requests = reqDir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: return
        for (file in requests) {
            val body = runCatching { file.readText() }.getOrNull() ?: continue
            file.delete() // claim before executing so the next poll never double-runs
            val request = runCatching { JSONObject(body) }.getOrElse {
                Log.w(TAG, "bad request json: ${it.message}")
                null
            } ?: continue
            val id = request.optString("id")
            if (id.isEmpty()) continue
            val kind = request.optString("kind")
            val args = request.optJSONObject("args") ?: JSONObject()

            val response = execute(kind, args, id)
            if (response != null) writeResp(id, response)
        }
    }

    /**
     * Runs one command on the main thread. Returns the response object, or null when
     * the response will be written asynchronously (browser commands).
     */
    private fun execute(kind: String, args: JSONObject, id: String): JSONObject? = when (kind) {
        "snapshot" -> a11y { BotAccessibilityService.get()?.snapshot() }
        "tap" -> a11y { BotAccessibilityService.get()?.tap(args.optInt("x"), args.optInt("y")) }
        "swipe" -> a11y {
            BotAccessibilityService.get()?.swipe(
                args.optInt("x1"), args.optInt("y1"), args.optInt("x2"), args.optInt("y2"), args.optInt("ms", 300),
            )
        }
        "text" -> a11y { BotAccessibilityService.get()?.inputText(args.optString("text")) }
        "key" -> a11y { BotAccessibilityService.get()?.globalKey(args.optString("key")) }
        "launch" -> launchApp(args)
        "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_back" -> {
            // WebView commands complete through evaluateJavascript callbacks. Returning null
            // tells pollOnce "no response yet" so only the real answer is ever written.
            //
            // 🔴 Returning a "pending" ack here instead was a real bug: pollOnce wrote it
            // immediately, the runtime read it as the command result, and the genuine answer
            // arrived later into an id nobody was reading. Symptoms: snapshot came back as
            // the string "pending", and the orphan response file stayed on disk forever.
            handler.post {
                BrowserHost.handle(kind, args) { response ->
                    writeResp(id, response)
                }
            }
            null
        }
        else -> JSONObject().put("ok", false).put("error", "unknown kind: $kind")
    }

    private fun writeResp(id: String, resp: JSONObject) {
        runCatching {
            val out = JSONObject().apply {
                put("id", id)
                put("ok", resp.optBoolean("ok", false))
                put("data", resp.opt("data") ?: JSONObject.NULL)
                put("error", resp.opt("error") ?: JSONObject.NULL)
            }
            respDir.mkdirs()
            // Write-then-rename: the runtime polls this directory, and a half-written file
            // would make it parse garbage and fail the whole command. rename is atomic on
            // the same filesystem, so the runtime only ever sees a complete answer.
            val target = File(respDir, "$id.json")
            val tmp = File(respDir, "$id.json.tmp")
            tmp.writeText(out.toString())
            if (!tmp.renameTo(target)) {
                target.writeText(out.toString())
                tmp.delete()
            }
        }.onFailure { Log.w(TAG, "resp write failed: ${it.message}") }
    }

    /** Wraps a11y-backed actions with the availability check in one place. */
    private inline fun a11y(block: () -> Any?): JSONObject {
        val service = BotAccessibilityService.get()
        if (service == null) {
            return JSONObject()
                .put("ok", false)
                .put("error", "accessibility service is not enabled — enable SUPERCRZY in system settings")
        }
        return runCatching {
            val data = block()
            JSONObject().put("ok", true).put("data", data ?: JSONObject.NULL)
        }.getOrElse {
            JSONObject().put("ok", false).put("error", it.message ?: it.javaClass.simpleName)
        }
    }

    private fun launchApp(args: JSONObject): JSONObject {
        val pkg = args.optString("package")
        if (pkg.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "package required")
        }
        val intent = context.packageManager.getLaunchIntentForPackage(pkg)
        if (intent == null) {
            return JSONObject().put("ok", false).put("error", "app not installed: $pkg")
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return JSONObject().put("ok", true).put("data", "launched $pkg")
    }

    companion object {
        private const val TAG = "DeviceCmdWorker"
        private const val POLL_MS = 200L

        @Volatile
        private var instance: DeviceCommandWorker? = null

        fun start(context: Context) {
            if (instance == null) instance = DeviceCommandWorker(context.applicationContext)
            instance?.start()
        }

        fun stop() = instance?.stop()
    }
}

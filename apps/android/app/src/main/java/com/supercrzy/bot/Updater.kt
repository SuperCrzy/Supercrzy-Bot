package com.supercrzy.bot

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Environment
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.URL

/**
 * In-app update against the rolling pre-release.
 *
 * Flow: check GitHub for the android-latest tag → compare the build number in the
 * release title with our versionCode → offer the APK → DownloadManager fetches it →
 * the system installer opens on completion (REQUEST_INSTALL_PACKAGES is declared;
 * the user still confirms in the system dialog, which is the right amount of friction).
 *
 * GitHub is reachable from everywhere except flaky cross-border routes; when the
 * domestic mirror exists this switches to it by changing one URL.
 */
object Updater {

    private const val TAG = "Updater"
    private const val RELEASE_API =
        "https://api.github.com/repos/SuperCrzy/Supercrzy-Bot/releases/tags/android-latest"

    data class Info(val buildNumber: Int, val apkUrl: String, val title: String)

    /** Latest downloaded update id, so ACTION_DOWNLOAD_COMPLETE can find its file. */
    @Volatile
    var pendingDownloadId: Long = -1

    fun check(onResult: (Info?) -> Unit) {
        Thread {
            val info = runCatching { fetch() }.onFailure {
                Log.i(TAG, "update check failed: ${it.message}")
            }.getOrNull()
            onResult(info)
        }.start()
    }

    private fun fetch(): Info? {
        val json = URL(RELEASE_API).openStream().bufferedReader().use { it.readText() }
        val release = JSONObject(json)
        val title = release.optString("name", "")
        // Titles look like "Android · rolling build 14" — the number IS the versionCode
        // the CI stamped into versionCode for that build.
        val buildNumber = Regex("(\\d+)\\s*$").find(title)?.groupValues?.lastOrNull()?.toIntOrNull()
            ?: return null
        if (buildNumber <= BuildConfig.VERSION_CODE) return null
        val asset = release.optJSONArray("assets") ?: return null
        for (i in 0 until asset.length()) {
            val a = asset.getJSONObject(i)
            if (a.optString("name") == "app-release.apk") {
                return Info(buildNumber, a.optString("browser_download_url"), title)
            }
        }
        return null
    }

    fun download(context: Context, info: Info) {
        val request = DownloadManager.Request(Uri.parse(info.apkUrl)).apply {
            setTitle("SUPERCRZY BOT ${info.buildNumber}")
            setDescription("Update package")
            setMimeType("application/vnd.android.package-archive")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "supercrzy-bot-update.apk")
        }
        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        pendingDownloadId = manager.enqueue(request)
    }

    /** Call from an ACTION_DOWNLOAD_COMPLETE receiver; opens the system installer. */
    fun installDownloaded(context: Context, completedId: Long) {
        if (pendingDownloadId == -1L || completedId != pendingDownloadId) return
        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val cursor: Cursor? = manager.query(DownloadManager.Query().setFilterById(pendingDownloadId))
        cursor?.use {
            if (it.moveToFirst()) {
                val status = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    val uri = manager.getUriForDownloadedFile(pendingDownloadId)
                    if (uri != null) {
                        val install = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, "application/vnd.android.package-archive")
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        ContextCompat.startActivity(context, install, null)
                    }
                }
            }
        }
    }

    fun registerCompletionReceiver(context: Context, onInstalled: () -> Unit): BroadcastReceiver {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(recv: Context, intent: Intent) {
                if (intent.action == DownloadManager.ACTION_DOWNLOAD_COMPLETE) {
                    installDownloaded(context, intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1))
                    onInstalled()
                }
            }
        }
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        return receiver
    }
}

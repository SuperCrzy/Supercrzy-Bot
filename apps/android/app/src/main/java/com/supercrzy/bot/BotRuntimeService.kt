package com.supercrzy.bot

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Foreground anchor for work that must outlive the UI: in P0 it only holds the
 * process so a running WebView/SSE connection is not reaped; in P1 it will own the
 * PRoot + Node runtime lifecycle (extract rootfs → start proot → health check →
 * restart on crash).
 *
 * Starting it is cheap and idempotent; stopping it must stop the runtime too.
 */
class BotRuntimeService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = Notifications.runtimeNotification(this)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        }.recoverCatching {
            // Some ROMs reject the typed overload; the plain form still promotes us.
            startForeground(NOTIFICATION_ID, notification)
        }
        // Owns the runtime lifecycle: starts it if not up, no-ops otherwise.
        RuntimeHost.ensureStarted(this) { }
        return START_STICKY
    }

    override fun onDestroy() {
        // P1: RuntimeHost.stop() here.
        Log.i(TAG, "runtime service stopped")
        super.onDestroy()
    }

    companion object {
        private const val TAG = "BotRuntimeService"
        private const val NOTIFICATION_ID = 4711
    }
}

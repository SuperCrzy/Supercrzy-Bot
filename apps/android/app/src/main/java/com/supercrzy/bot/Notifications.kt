package com.supercrzy.bot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Notification plumbing in one place: channels are created once at startup, and
 * every post goes through [post] so a missing runtime permission degrades quietly
 * instead of throwing (Android 13+ requires POST_NOTIFICATIONS).
 */
object Notifications {

    const val CHANNEL_RUNTIME = "runtime"
    const val CHANNEL_TASKS = "tasks"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RUNTIME,
                context.getString(R.string.notification_channel_runtime),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_TASKS,
                context.getString(R.string.notification_channel_tasks),
                NotificationManager.IMPORTANCE_DEFAULT,
            ),
        )
    }

    fun runtimeNotification(context: Context): Notification {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_RUNTIME)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(context.getString(R.string.notification_runtime_title))
            .setContentText(context.getString(R.string.notification_runtime_text))
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    fun post(context: Context, channel: String, title: String, body: String) {
        runCatching {
            val notification = NotificationCompat.Builder(context, channel)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()
            NotificationManagerCompat.from(context).notify(System.currentTimeMillis().toInt(), notification)
        }
    }
}

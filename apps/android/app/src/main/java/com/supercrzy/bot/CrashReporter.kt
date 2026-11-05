package com.supercrzy.bot

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Records crashes on the device.
 *
 * The phone is not always attached to adb, and a crash the user cannot show us is
 * a bug we can never fix. The default handler writes the stack trace to
 * filesDir/logs/crash-latest.txt and then chains to the platform handler, so the
 * process still dies the normal way. The next launch reads it and shows it on the
 * error surface, where the user can copy it to us.
 */
object CrashReporter {

    private const val FILE = "crash-latest.txt"
    private const val MAX_BODY = 4000

    fun install(context: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching {
                val file = File(context.filesDir, "logs/$FILE").apply { parentFile?.mkdirs() }
                // Append the previous unread report so repeated crashes are not lost.
                if (file.exists() && file.length() > 0) {
                    val previousReport = file.readText()
                    File(context.filesDir, "logs/crash-previous.txt").writeText(previousReport.take(MAX_BODY))
                }
                file.writeText(format(thread, throwable))
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    /** Returns and clears the last crash report, or null. */
    fun consumeLastCrash(context: Context): String? {
        val file = File(context.filesDir, "logs/$FILE")
        if (!file.exists()) return null
        val text = runCatching { file.readText() }.getOrNull() ?: return null
        file.delete()
        return if (text.isBlank()) null else text.take(MAX_BODY)
    }

    private fun format(thread: Thread, throwable: Throwable): String {
        val stack = StringWriter().also { throwable.printStackTrace(PrintWriter(it)) }.toString()
        return buildString {
            appendLine("time: ${System.currentTimeMillis()}")
            appendLine("thread: ${thread.name}")
            appendLine("exception: ${throwable.javaClass.name}")
            appendLine("message: ${throwable.message.orEmpty()}")
            appendLine()
            append(stack.take(MAX_BODY))
        }
    }
}

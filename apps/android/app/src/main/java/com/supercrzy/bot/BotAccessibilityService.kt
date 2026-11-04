package com.supercrzy.bot

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * P3 placeholder: the service is declared and can be enabled now, but the actual
 * node-tree reading and gesture dispatch land with the screen-control feature.
 *
 * Contract with the runtime (kept here so P0 and P3 agree):
 *   - Both directions go through the local HTTP API, not a custom socket:
 *     the agent calls /api/device/screen (snapshot as JSON) and /api/device/action
 *     (tap / swipe / text). This service only produces and applies those.
 *   - Nothing is captured or stored while no task is running.
 */
class BotAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        instance = this
        Log.i(TAG, "accessibility connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // P3: publish a throttled snapshot of the active window for the runtime.
    }

    override fun onInterrupt() {
        // Nothing buffered yet.
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    /** Snapshot of the focused window as a flat node list (P3 entry point). */
    fun snapshot(): List<Map<String, Any?>> {
        val root: AccessibilityNodeInfo = rootInActiveWindow ?: return emptyList()
        val out = ArrayList<Map<String, Any?>>()
        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || depth > MAX_DEPTH) return
            val bounds = android.graphics.Rect()
            node.getBoundsInScreen(bounds)
            out.add(
                mapOf(
                    "text" to node.text?.toString(),
                    "desc" to node.contentDescription?.toString(),
                    "cls" to node.className?.toString(),
                    "viewId" to node.viewIdResourceName,
                    "clickable" to node.isClickable,
                    "editable" to node.isEditable,
                    "bounds" to listOf(bounds.left, bounds.top, bounds.right, bounds.bottom),
                ),
            )
            for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)
        }
        walk(root, 0)
        return out
    }

    companion object {
        private const val TAG = "BotA11y"
        private const val MAX_DEPTH = 40

        @Volatile
        private var instance: BotAccessibilityService? = null

        fun get(): BotAccessibilityService? = instance

        /** True when the user has switched our service on in system settings. */
        fun isEnabled(context: Context): Boolean {
            val expected = ComponentName(context, BotAccessibilityService::class.java)
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: return false
            val splitter = TextUtils.SimpleStringSplitter(':')
            splitter.setString(enabled)
            while (splitter.hasNext()) {
                if (ComponentName.unflattenFromString(splitter.next()) == expected) return true
            }
            return false
        }
    }
}

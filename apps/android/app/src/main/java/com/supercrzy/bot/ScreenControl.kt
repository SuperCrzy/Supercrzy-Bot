package com.supercrzy.bot

import android.accessibilityservice.AccessibilityService
import org.json.JSONObject
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Screen-control primitives on top of the accessibility pipeline.
 *
 * Two tiers, tried in order: node actions (precise, no geometry needed) and
 * dispatched gestures (real touch events at coordinates, works where node actions
 * are blocked). Text input prefers ACTION_SET_TEXT on the focused editable.
 */
fun BotAccessibilityService.tap(x: Int, y: Int): JSONObject {
    val node = findClickableAt(x, y)
    val viaNode = node?.let { target ->
        runCatching {
            if (target.isClickable) target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            else target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }.getOrDefault(false)
    }
    val result = JSONObject()
    if (viaNode == true) {
        result.put("ok", true)
        result.put("data", "clicked node at $x,$y")
        return result
    }
    return gestureTap(x, y)
}

fun BotAccessibilityService.gestureTap(x: Int, y: Int): JSONObject {
    val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
    val gesture = GestureDescription.Builder()
        .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
        .build()
    val ok = dispatchGesture(gesture, null, null)
    return JSONObject().put("ok", ok).put("data", if (ok) "tapped $x,$y" else JSONObject.NULL)
}

fun BotAccessibilityService.swipe(x1: Int, y1: Int, x2: Int, y2: Int, ms: Int): JSONObject {
    val path = Path().apply {
        moveTo(x1.toFloat(), y1.toFloat())
        lineTo(x2.toFloat(), y2.toFloat())
    }
    val gesture = GestureDescription.Builder()
        .addStroke(GestureDescription.StrokeDescription(path, 0, ms.coerceIn(80, 2000)))
        .build()
    val ok = dispatchGesture(gesture, null, null)
    return JSONObject().put("ok", ok).put("data", if (ok) "swiped" else JSONObject.NULL)
}

fun BotAccessibilityService.inputText(text: String): JSONObject {
    val node = findEditable()
        ?: return JSONObject().put("ok", false).put("error", "no focused editable field")
    val args = android.os.Bundle().apply {
        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    return if (ok) JSONObject().put("ok", true).put("data", "input done")
    else JSONObject().put("ok", false).put("error", "ACTION_SET_TEXT rejected")
}

fun BotAccessibilityService.globalKey(key: String): JSONObject {
    val action = when (key.lowercase()) {
        "back" -> AccessibilityService.GLOBAL_ACTION_BACK
        "home" -> AccessibilityService.GLOBAL_ACTION_HOME
        "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
        "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
        else -> return JSONObject().put("ok", false).put("error", "unknown key: $key")
    }
    val ok = performGlobalAction(action)
    return if (ok) JSONObject().put("ok", true).put("data", key)
    else JSONObject().put("ok", false).put("error", "global action rejected")
}

private fun findClickableAt(x: Int, y: Int): AccessibilityNodeInfo? {
    val root: AccessibilityNodeInfo = rootInActiveWindow ?: return null
    var best: AccessibilityNodeInfo? = null
    fun walk(node: AccessibilityNodeInfo?, depth: Int) {
        if (node == null || depth > 30) return
        val rect = android.graphics.Rect()
        node.getBoundsInScreen(rect)
        if (rect.contains(x, y)) {
            if (node.isClickable) best = node
            for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)
        }
    }
    walk(root, 0)
    return best
}

private fun findEditable(): AccessibilityNodeInfo? {
    val root: AccessibilityNodeInfo = rootInActiveWindow ?: return null
    var found: AccessibilityNodeInfo? = null
    fun walk(node: AccessibilityNodeInfo?, depth: Int) {
        if (node == null || depth > 30 || found != null) return
        if (node.isEditable && node.isFocused) { found = node; return }
        if (node.isEditable) found = node
        for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)
    }
    walk(root, 0)
    return found ?: root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
}

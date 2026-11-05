package com.supercrzy.bot

import android.annotation.SuppressLint
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * The AI browser on the phone: a WebView the agent drives through the device bridge.
 *
 * The engine is the system WebView (Chromium, 0 MB extra). The flow mirrors the
 * desktop AI browser: navigate → snapshot (interactive elements with stable
 * indices) → click/type by index. Elements are tagged with data-sc-idx on the page;
 * that attribute is the stable address the agent clicks or types into.
 *
 * Everything runs on the main thread; command results are delivered through the
 * callback, so the device-bridge worker never blocks the UI thread.
 */
object BrowserHost {

    private const val TAG = "BrowserHost"

    private var webView: WebView? = null

    /** 1×1 and attached: JS keeps running while staying invisible to the user. */
    fun attach(root: FrameLayout) {
        if (webView != null) return
        val view = WebView(root.context)
        view.layoutParams = FrameLayout.LayoutParams(1, 1)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString SuperCrzyBotAgent/1.0"
        }
        // Popups/new windows would silently die otherwise.
        view.settings.setSupportMultipleWindows(false)
        view.webViewClient = object : WebViewClient() {
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                Log.i(TAG, "at $url")
            }
        }
        root.addView(view)
        webView = view
        Log.i(TAG, "browser host attached")
    }

    /**
     * Executes one browser command and calls [respond] with the result JSON.
     * Must be called on the main thread.
     */
    fun handle(kind: String, args: JSONObject, respond: (JSONObject) -> Unit) {
        val view = webView
        if (view == null) {
            respond(JSONObject().put("ok", false).put("error", "browser host not attached"))
            return
        }
        when (kind) {
            "browser_navigate" -> {
                var url = args.optString("url").trim()
                if (url.isEmpty()) {
                    respond(JSONObject().put("ok", false).put("error", "url required"))
                    return
                }
                if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url
                view.loadUrl(url)
                // Give the first paint a beat; the tool can snapshot again for more.
                respond(JSONObject().put("ok", true).put("data", "navigating to $url"))
            }
            "browser_snapshot" -> {
                val js = "(function(){" + SNAPSHOT_BODY + "})()"
                view.evaluateJavascript(js) { raw ->
                    respond(parsePayload(raw, "snapshot"))
                }
            }
            "browser_click" -> {
                val idx = args.optInt("index", -1)
                val js = "(function(){" + """
                    var el=document.querySelector('[data-sc-idx="$idx"]');
                    if(!el) return JSON.stringify({ok:false,error:'no element with index $idx — snapshot again'});
                    el.scrollIntoView({block:'center'});
                    el.click();
                    return JSON.stringify({ok:true,data:'clicked index $idx, url '+location.href});
                """ + "})()"
                view.evaluateJavascript(js) { raw -> respond(parsePayload(raw, "click")) }
            }
            "browser_type" -> {
                val idx = args.optInt("index", -1)
                val text = args.optString("text")
                val js = "(function(){" + """
                    var el=document.querySelector('[data-sc-idx="$idx"]');
                    if(!el) return JSON.stringify({ok:false,error:'no element with index $idx — snapshot again'});
                    el.focus();
                    var proto = el.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var setter = Object.getOwnPropertyDescriptor(proto,'value');
                    if(setter && setter.set) setter.set.call(el, ${JSONObject.quote(text)});
                    else el.value = ${JSONObject.quote(text)};
                    el.dispatchEvent(new Event('input',{bubbles:true}));
                    el.dispatchEvent(new Event('change',{bubbles:true}));
                    return JSON.stringify({ok:true,data:'typed into index $idx'});
                """ + "})()"
                view.evaluateJavascript(js) { raw -> respond(parsePayload(raw, "type")) }
            }
            "browser_back" -> {
                if (view.canGoBack()) view.goBack()
                respond(JSONObject().put("ok", true).put("data", "back"))
            }
            else -> respond(JSONObject().put("ok", false).put("error", "unknown browser kind: $kind"))
        }
    }

    /** evaluateJavascript answers a JSON-encoded string; unwrap it once. */
    private fun parsePayload(raw: String?, kind: String): JSONObject {
        val unquoted = raw?.let { if (it.length >= 2 && it.startsWith("\"") && it.endsWith("\"")) it.drop(1).dropLast(1) else it } ?: ""
        val unescaped = unquoted.replace("\\\"", "\"").replace("\\\\", "\\")
        return runCatching {
            val parsed = JSONObject(unescaped)
            parsed.put("ok", parsed.optBoolean("ok", true))
            parsed
        }.getOrElse {
            Log.w(TAG, "$kind: unparseable js payload")
            JSONObject().put("ok", true).put("data", unescaped.take(2000))
        }
    }

    /**
     * Tags interactive elements and returns the flat list the agent reads.
     * Kept as a string constant: evaluateJavascript needs the whole body inline.
     */
    private const val SNAPSHOT_BODY = """
      var els = document.querySelectorAll('a,button,input,textarea,select,[role="button"],[onclick],[contenteditable]');
      var out = [];
      var i = 0;
      els.forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width < 2 && r.height < 2) return;
        var style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return;
        el.setAttribute('data-sc-idx', String(i));
        out.push({
          i: i,
          tag: el.tagName.toLowerCase(),
          text: ((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + '').trim().slice(0, 80),
          href: el.getAttribute('href') || null,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          disabled: !!el.disabled
        });
        i++;
      });
      return JSON.stringify({ ok: true, url: location.href, ready: document.readyState, title: document.title, elements: out });
    """

    /** Guard for the [JavascriptInterface] annotation convention; unused today. */
    @Suppress("unused")
    @JavascriptInterface
    fun version(): String = "1.0"
}

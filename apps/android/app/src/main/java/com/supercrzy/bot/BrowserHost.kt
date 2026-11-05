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
                    var idx = $idx;
                    var el = idx >= 0 ? document.querySelector('[data-sc-idx="' + idx + '"]') : document.activeElement;
                    if(!el) return JSON.stringify({ok:false,error:'no element with index ' + idx + ' — snapshot again'});
                    el.scrollIntoView({block:'center'});
                    el.click();
                    return JSON.stringify({ok:true,data:'clicked index ' + idx + ', url ' + location.href});
                """ + "})()"
                view.evaluateJavascript(js) { raw -> respond(parsePayload(raw, "click")) }
            }
            "browser_type" -> {
                val idx = args.optInt("index", -1)
                val text = args.optString("text")
                val js = "(function(){" + """
                    var idx = $idx;
                    var el = idx >= 0 ? document.querySelector('[data-sc-idx="' + idx + '"]') : document.activeElement;
                    if(!el || !el.tagName) return JSON.stringify({ok:false,error:'no element with index ' + idx + ' — snapshot again'});
                    el.focus();
                    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
                    if(setter && setter.set) setter.set.call(el, ${JSONObject.quote(text)});
                    else el.value = ${JSONObject.quote(text)};
                    el.dispatchEvent(new Event('input', {bubbles:true}));
                    el.dispatchEvent(new Event('change', {bubbles:true}));
                    return JSON.stringify({ok:true,data:'typed into index ' + idx});
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

    /** evaluateJavascript answers a JSON string literal; decoding it as one is exact. */
    private fun parsePayload(raw: String?, kind: String): JSONObject {
        if (raw.isNullOrBlank() || raw == "null") {
            return JSONObject().put("ok", false)
                .put("error", "$kind returned nothing — is the page still loading?")
        }
        // Why not hand-rolled unescaping: the old code did replace("\\\"", "\"").replace("\\\\", "\\").
        // That leaves "\n" as a literal backslash-n (page text showed raw \n) and mangles any
        // escaped quote inside the payload. Parsing it as a JSON value round-trips everything.
        val decoded = runCatching {
            JSONObject("{\"v\":$raw}").opt("v") as? String
        }.getOrNull() ?: raw
        return runCatching {
            val parsed = JSONObject(decoded)
            parsed.put("ok", parsed.optBoolean("ok", true))
            parsed
        }.getOrElse {
            Log.w(TAG, "$kind: unparseable js payload: ${decoded.take(200)}")
            JSONObject().put("ok", false).put("error", "page returned non-JSON: ${decoded.take(200)}")
        }
    }

    /**
     * Tags interactive elements and returns the flat list the agent reads.
     * Kept as a string constant: evaluateJavascript needs the whole body inline.
     *
     * Two payloads, one pass:
     *  · `elements` — what can be pressed, with a stable index (data-sc-idx).
     *  · `blocks`   — the page's reading order (headings/paragraphs/lists) so the side
     *                 panel can redraw a simplified page instead of a screenshot.
     * `text` stays for the agent: it is the whole readable body in one string.
     */
    private const val SNAPSHOT_BODY = """
      var norm = function(s){ return (s || '').replace(/[ \t\n\r]+/g, ' ').trim(); };
      var out = [];
      var i = 0;
      var nodes = document.querySelectorAll('a,button,input,textarea,select,[role="button"],[onclick],[contenteditable]');
      for (var j = 0; j < nodes.length && i < 300; j++) {
        var el = nodes[j];
        var r = el.getBoundingClientRect();
        if (r.width < 2 && r.height < 2) continue;
        var st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') continue;
        el.setAttribute('data-sc-idx', String(i));
        var label = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 80);
        out.push({
          i: i,
          tag: el.tagName.toLowerCase(),
          text: label,
          href: el.tagName === 'A' ? (el.href || null) : null,
          type: el.getAttribute('type') || null,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          disabled: !!el.disabled
        });
        i++;
      }
      var blocks = [];
      var bn = document.querySelectorAll('h1,h2,h3,h4,h5,p,li,pre,blockquote,td');
      for (var k = 0; k < bn.length && blocks.length < 220; k++) {
        var b = bn[k];
        var txt = norm(b.innerText);
        if (!txt) continue;
        if (txt.length > 400) txt = txt.slice(0, 400) + '…';
        blocks.push({ k: b.tagName.toLowerCase(), t: txt });
      }
      if (!blocks.length && document.body) {
        blocks.push({ k: 'p', t: norm(document.body.innerText).slice(0, 2000) });
      }
      var full = norm(document.body ? document.body.innerText : '');
      return JSON.stringify({ ok: true, url: location.href, ready: document.readyState, title: document.title, text: full.slice(0, 8000), elements: out, blocks: blocks });
    """

    /** Guard for the [JavascriptInterface] annotation convention; unused today. */
    @Suppress("unused")
    @JavascriptInterface
    fun version(): String = "1.0"
}

package com.supercrzy.bot

import android.Manifest
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * The whole shell: a WebView that hosts the existing Vue client, plus the bridges a
 * browser cannot provide on Android (back key, file chooser, downloads, notifications).
 *
 * The WebView always talks to a Node server over plain HTTP:
 *   P0 — the desktop instance on the LAN, address stored in [PREFS].
 *   P1 — the on-device runtime on 127.0.0.1, which will become the default and the
 *        stored address turns into the fallback.
 * Nothing here knows which one it is; that keeps the switch a one-line change.
 */
class MainActivity : ComponentActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var errorBar: LinearLayout
    private lateinit var errorText: TextView

    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val data = result.data
        if (result.resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }
        val clip = data.clipData
        val uris: Array<Uri> = when {
            clip != null && clip.count > 0 -> Array(clip.count) { clip.getItemAt(it).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> emptyArray()
        }
        callback.onReceiveValue(uris)
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Notifications.ensureChannels(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        root = FrameLayout(this)
        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        root.addView(webView)
        errorBar = buildErrorBar().also { it.visibility = View.GONE }
        root.addView(errorBar)
        setContentView(root)

        configureWebView()

        // Back goes through WebView history first — the single most obvious bridge
        // a bare WebView misses.
        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) webView.goBack() else finish()
        }

        val target = serverUrl()
        if (target.isEmpty()) {
            showSettings(firstRun = true)
        } else {
            load(target)
        }

        // Keeps the local runtime (P1) alive in the background. Harmless in P0.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(this, Intent(this, BotRuntimeService::class.java))
        }
    }

    // ---- WebView wiring -----------------------------------------------------

    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString SuperCrzyBot/${BuildConfig.VERSION_NAME}"
        }

        webView.addJavascriptInterface(Bridge(), "SuperCrzy")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                // Keep our own origins inside the WebView; hand everything else to the OS.
                if (url.scheme == "http" || url.scheme == "https") {
                    if (url.host == webView.url?.let { Uri.parse(it).host }) return false
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    return true
                }
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                errorBar.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                showError(serverUrl())
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: WebChromeClient.FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return runCatching {
                    val intent = params.createIntent()
                    if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    filePicker.launch(intent)
                    true
                }.getOrElse {
                    fileCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                // The page only asks for mic/camera from the composer; grant what the
                // user already approved at the OS level rather than blocking silently.
                runCatching { request.grant(request.resources) }
                    .onFailure { request.deny() }
            }
        }

        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            enqueueDownload(url, userAgent, contentDisposition, mimeType)
        })
    }

    private fun load(url: String) {
        errorBar.visibility = View.GONE
        webView.loadUrl(url)
    }

    // ---- Downloads ----------------------------------------------------------

    private fun enqueueDownload(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        runCatching {
            val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(name)
                setMimeType(mimeType)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                userAgent?.let { addRequestHeader("User-Agent", it) }
                addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            Notifications.post(this, Notifications.CHANNEL_TASKS, getString(R.string.app_name), name)
        }.onFailure {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
    }

    // ---- Server address -----------------------------------------------------

    private fun serverUrl(): String =
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URL, "").orEmpty()

    private fun saveServerUrl(raw: String) {
        val normalized = normalize(raw)
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_URL, normalized).apply()
        load(normalized)
    }

    /** Accepts "1.2.3.4", "1.2.3.4:3000", "http://host:3000/" and returns a loadable URL. */
    private fun normalize(raw: String): String {
        var value = raw.trim()
        if (value.isEmpty()) return ""
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://$value"
        if (!Regex(""":\d+""").containsMatchIn(value.substringAfter("://"))) {
            value = value.trimEnd('/') + ":3000"
        }
        return value.trimEnd('/')
    }

    private fun showSettings(firstRun: Boolean = false) {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = getString(R.string.server_hint)
            setText(serverUrl().removePrefix("http://"))
            setSingleLine()
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(TextView(context).apply {
                text = getString(R.string.server_help)
                textSize = 13f
                setPadding(0, 0, 0, dp(12))
            })
            addView(input)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.server_title)
            .setView(box)
            .setPositiveButton(R.string.save) { _, _ -> saveServerUrl(input.text.toString()) }
            .setNegativeButton(R.string.cancel) { _, _ -> if (firstRun && serverUrl().isEmpty()) showError("") }
            .setCancelable(!firstRun)
            .create()
        dialog.show()
    }

    // ---- Error surface ------------------------------------------------------

    private fun buildErrorBar(): LinearLayout {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xF20F1419.toInt())
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        errorText = TextView(this).apply {
            setTextColor(0xFFE2E2E2.toInt())
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(8))
        }
        bar.addView(errorText)
        bar.addView(Button(this).apply {
            text = getString(R.string.retry)
            setOnClickListener { if (serverUrl().isEmpty()) showSettings() else load(serverUrl()) }
        })
        bar.addView(Button(this).apply {
            text = getString(R.string.settings)
            setOnClickListener { showSettings() }
        })
        return bar
    }

    private fun showError(url: String) {
        errorText.text = if (url.isEmpty()) getString(R.string.server_hint) else getString(R.string.cannot_reach, url)
        errorBar.visibility = View.VISIBLE
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /** JS surface: page code calls window.SuperCrzy.* — see the client for usage. */
    inner class Bridge {
        @JavascriptInterface
        fun notify(title: String, body: String) {
            runOnUiThread { Notifications.post(this@MainActivity, Notifications.CHANNEL_TASKS, title, body) }
        }

        @JavascriptInterface
        fun getServerUrl(): String = serverUrl()

        @JavascriptInterface
        fun openSettings() = runOnUiThread { showSettings() }

        /** Capability probe for the UI: which layer this device can reach. */
        @JavascriptInterface
        fun getCapabilities(): String {
            val a11y = BotAccessibilityService.isEnabled(this@MainActivity)
            val wirelessDebug = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            return """{"sdk":${Build.VERSION.SDK_INT},"accessibility":$a11y,"wirelessDebug":$wirelessDebug}"""
        }
    }

    companion object {
        private const val PREFS = "supercrzy"
        private const val KEY_URL = "server_url"
    }
}

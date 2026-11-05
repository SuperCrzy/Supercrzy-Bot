package com.supercrzy.bot

import android.Manifest
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Context
import android.content.BroadcastReceiver
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
 * Address model:
 *   stored value empty (default) → the on-device runtime managed by [RuntimeHost]
 *   stored value set             → a Node server on the LAN, e.g. the desktop
 *
 * The on-device path starts proot first (rootfs extraction happens on first run) and
 * only loads the page once /api/health answers.
 */
class MainActivity : ComponentActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var errorBar: LinearLayout
    private lateinit var errorText: TextView

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var updateReceiver: BroadcastReceiver? = null
    private var updateInfo: Updater.Info? = null
    private var updateChip: Button? = null

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
            clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> emptyArray()
        }
        callback.onReceiveValue(uris)
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashReporter.install(this)

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

        // The agent's browser lives in this same window, 1px, invisible.
        BrowserHost.attach(root)
        DeviceCommandWorker.start(this)

        configureWebView()

        // Back goes through WebView history first — the single most obvious bridge
        // a bare WebView misses.
        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) webView.goBack() else finish()
        }

        if (wantsLocal()) {
            startLocalAndLoad()
        } else {
            load(targetUrl())
        }
        updateReceiver = Updater.registerCompletionReceiver(this) {
            runOnUiThread { updateChip?.visibility = View.GONE }
        }
        Updater.check { info -> if (info != null) runOnUiThread { showUpdateChip(info) } }

        // Keeps the local runtime alive while the app is backgrounded.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(this, Intent(this, BotRuntimeService::class.java))
        }
    }

    /** Boots the on-device runtime (idempotent), then loads its URL. */
    private fun startLocalAndLoad() {
        showStarting()
        RuntimeHost.ensureStarted(this) { state ->
            runOnUiThread {
                when (state.status) {
                    RuntimeHost.Status.RUNNING -> load(RuntimeHost.currentUrl(this))
                    else -> tryLegacyFallback(state.message)
                }
            }
        }
    }

    /**
     * Fallback chain: if the packaged runtime cannot start on this device, try the
     * legacy chroot server that may already be listening on 3000. This keeps the app
     * usable while the proot path is being hardened on new devices.
     */
    private fun tryLegacyFallback(reason: String?) {
        errorText.text = listOf(
            getString(R.string.starting_runtime),
            reason.orEmpty().take(200),
            getString(R.string.fallback_legacy),
        ).joinToString("\n")
        errorBar.visibility = View.VISIBLE
        Thread {
            if (RuntimeHost.probe(LEGACY_URL)) {
                runOnUiThread {
                    load(LEGACY_URL)
                    Notifications.post(
                        this,
                        Notifications.CHANNEL_TASKS,
                        getString(R.string.fallback_title),
                        LEGACY_URL,
                    )
                }
            } else {
                runOnUiThread {
                    showError(RuntimeHost.currentUrl(this))
                    errorText.text = listOf(
                        getString(R.string.cannot_reach, RuntimeHost.currentUrl(this)),
                        reason.orEmpty().take(200),
                    ).joinToString("\n")
                }
            }
        }.start()
    }

    private fun showUpdateChip(info: Updater.Info) {
        updateInfo = info
        updateChip?.apply {
            text = getString(R.string.update_available, info.buildNumber)
            visibility = View.VISIBLE
        }
        Notifications.post(
            this,
            Notifications.CHANNEL_TASKS,
            getString(R.string.update_available, info.buildNumber),
            getString(R.string.update_hint),
        )
    }

    private fun showStarting() {
        val lastCrash = CrashReporter.consumeLastCrash(this)
        errorText.text = if (lastCrash.isNullOrBlank()) {
            getString(R.string.starting_runtime)
        } else {
            // The previous run died: surface it here, where the user can copy it to us.
            getString(R.string.starting_runtime) + "\n\n" + lastCrash
        }
        errorBar.visibility = View.VISIBLE
    }

    override fun onDestroy() {
        updateReceiver?.let { unregisterReceiver(it) }
        super.onDestroy()
    }

    // ---- Address resolution ---------------------------------------------------

    /** Raw stored value; empty means "the runtime on this phone". */
    private fun storedServer(): String =
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URL, "").orEmpty().trim()

    private fun wantsLocal(): Boolean = storedServer().isBlank()

    private fun targetUrl(): String {
        if (wantsLocal()) return RuntimeHost.currentUrl(this)
        var value = storedServer()
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value
        val afterScheme = value.substringAfter("://")
        if (Regex(":\\d+").containsMatchIn(afterScheme) == false) value = value.trimEnd('/') + ":3000"
        return value.trimEnd('/')
    }

    private fun saveServerUrl(raw: String) {
        // Empty input means "back to the on-device runtime".
        val value = if (raw.trim().isEmpty()) "" else targetUrl()
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_URL, value).apply()
        if (wantsLocal()) startLocalAndLoad() else load(targetUrl())
    }

    private fun showSettings() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = getString(R.string.server_hint)
            setText(storedServer())
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
        AlertDialog.Builder(this)
            .setTitle(R.string.server_title)
            .setView(box)
            .setPositiveButton(R.string.save) { _, _ -> saveServerUrl(input.text.toString()) }
            .setNegativeButton(R.string.cancel, null)
            .setNeutralButton(R.string.use_local) { _, _ ->
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_URL).apply()
                startLocalAndLoad()
            }
            .setCancelable(true)
            .create()
            .show()
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
                if (url.scheme == "http" || url.scheme == "https") {
                    val currentHost = webView.url?.let { Uri.parse(it).host }
                    if (url.host != null && url.host == currentHost) return false
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
                showError(targetUrl())
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
            setOnClickListener { if (wantsLocal()) startLocalAndLoad() else load(targetUrl()) }
        })
        bar.addView(Button(this).apply {
            text = getString(R.string.settings)
            setOnClickListener { showSettings() }
        })
        updateChip = Button(this).apply {
            visibility = View.GONE
            setOnClickListener { updateInfo?.let { Updater.download(this@MainActivity, it) } }
        }
        bar.addView(updateChip)
        return bar
    }

    private fun showError(url: String) {
        errorText.text = getString(R.string.cannot_reach, url)
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
        fun getServerUrl(): String = targetUrl()

        @JavascriptInterface
        fun openSettings() = runOnUiThread { showSettings() }

        /** Capability probe for the UI: which layer this device can reach. */
        @JavascriptInterface
        fun getCapabilities(): String {
            val a11y = BotAccessibilityService.isEnabled(this@MainActivity)
            val wirelessDebug = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            val localRuntime = RuntimeHost.snapshot().status == RuntimeHost.Status.RUNNING
            return """{"sdk":${Build.VERSION.SDK_INT},"accessibility":$a11y,"wirelessDebug":$wirelessDebug,"localRuntime":$localRuntime}"""
        }
    }

    companion object {
        private const val PREFS = "supercrzy"
        private const val KEY_URL = "server_url"
        /** The chroot BOT that may already run on this phone; the fallback target. */
        private const val LEGACY_URL = "http://127.0.0.1:3000"
    }
}

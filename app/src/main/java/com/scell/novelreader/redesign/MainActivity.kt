package com.scell.novelreader.redesign

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64

class MainActivity : ComponentActivity() {

    // Built once in setupImmersiveMode() and reused by
    // applySystemBarsForMenuState() so toggling the nav bar on/off (see
    // setMenuOpen() in the bridge below) doesn't need to rebuild it.
    private var insetsController: WindowInsetsControllerCompat? = null

    private lateinit var webView: WebView
    private val adaptiveBrightness by lazy { AdaptiveBrightness(this) }
    private var hasLoadedOnce = false

    // Keeps the screen awake while the user is active, then lets it time
    // out normally once there has been no touch input for 15 minutes.
    private val screenHandler = Handler(Looper.getMainLooper())
    private val screenTimeoutMs = 15 * 60 * 1000L
    private val releaseScreenRunnable = Runnable {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // Closes the app after 10 minutes with no touch/key input, unless music
    // is active (then it keeps going and re-checks later). "Active" covers
    // BOTH engines: the native Media3 player (including the moments when it
    // is READY/BUFFERING with play requested but not yet reporting
    // isPlaying), and the WebView <audio> fallback engine, which the native
    // controller knows nothing about.
    private val inactivityCloseMs = 10 * 60 * 1000L
    // Set after the first "nothing is playing" reading; the app only closes if
    // a second reading a few seconds later agrees (see closeRunnable).
    private var closeRecheckPending = false

    private fun logAutoClose(reason: String) {
        try {
            val f = File(getExternalFilesDir(null) ?: filesDir, "autoclose_log.txt")
            f.appendText("${java.util.Date()} auto-close: $reason\n")
        } catch (e: Exception) {
            // Logging only; never block closing on it.
        }
    }

    private val closeRunnable = object : Runnable {
        override fun run() {
            val nativeActive = audio.isNativeActive()
            if (nativeActive || audio.isBusy() || chapterTools.isBusy() || appUpdater.isBusy()) {
                closeRecheckPending = false
                screenHandler.postDelayed(this, inactivityCloseMs)
                return
            }
            // A single reading can land in the gap between two tracks, a
            // crossfade hand-over or a short audio-focus blip. Look again
            // a few seconds later before closing anything.
            if (!closeRecheckPending) {
                closeRecheckPending = true
                screenHandler.postDelayed(this, 5_000L)
                return
            }
            closeRecheckPending = false
            if (!::webView.isInitialized) {
                logAutoClose("no webview")
                finishAndRemoveTask()
                return
            }
            webView.evaluateJavascript(
                "!!(window.NovelAudio && window.NovelAudio.isPlaying && window.NovelAudio.isPlaying())"
            ) { result ->
                // Only an explicit "false" closes. A null/failed answer (e.g. a
                // paused WebView that can't run the script) is not proof that
                // nothing is playing.
                if (result == "false") {
                    logAutoClose("idle for 10 min, native=${audio.nativeStateDebug()}, js=false")
                    finishAndRemoveTask()
                } else {
                    screenHandler.postDelayed(this, inactivityCloseMs)
                }
            }
        }
    }

    // The moon lock's one-hour unlock: signed record in app-private storage,
    // timed on the monotonic clock (see MoonUnlockStore). The page asks for it
    // through AndroidBridge.moonUnlockRemainingMs() / moonUnlockGrant().
    private val moonUnlock by lazy { MoonUnlockStore(this) }
    private val moonUnlockMs = 60 * 60 * 1000L
    // The puzzle unlock (non-holiday days) is shorter: half an hour. Fixed here, not
    // chosen by the page.
    private val moonPuzzleUnlockMs = 30 * 60 * 1000L

    // Upper limit for settings.txt (read and write); see readSettingsFile().
    private val MAX_SETTINGS_BYTES = 256 * 1024

    // Night lock, native side. reader.js draws the lock between 12:00 AM and
    // 6:00 AM. This also stops background playback if WebView timers pause.
    // Respect the moon lock's one-hour unlock so a successful cheat works for
    // native audio as well as the WebView UI. Checked natively, so it does not
    // depend on the page being loaded.
    private val nightLockHandler = Handler(Looper.getMainLooper())
    private val nightLockCheck = object : Runnable {
        override fun run() {
            val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
            if (hour < 6 && moonUnlock.remainingMs() <= 0L) {
                audio.pauseNative()
            }
            nightLockHandler.postDelayed(this, 15_000L)
        }
    }

    private fun keepScreenAwake() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        screenHandler.removeCallbacks(releaseScreenRunnable)
        screenHandler.postDelayed(releaseScreenRunnable, screenTimeoutMs)
        screenHandler.removeCallbacks(closeRunnable)
        screenHandler.postDelayed(closeRunnable, inactivityCloseMs)
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) keepScreenAwake()
        return super.dispatchTouchEvent(ev)
    }

    private val settingsFile get() = File(novelRoot, "settings.txt")

    // True once the page has finished loading. Permission answers that arrive
    // earlier leave the novel listing to onPageFinished().
    private var pageLoaded = false

    // Set once the WebView's renderer process has died and the view has been
    // thrown away (see onRenderProcessGone); the activity is then rebuilt.
    private var webViewGone = false
    // True between onResume and onPause; the progress poll slows down when false.
    @Volatile internal var appInForeground = false
    private var lastBackPressMs = 0L
    private var permissionFlowActive = false
    private var permissionFlowStarted = false

    // Android 13+ requires notification access for the media notification to
    // display; requested once at startup. If the user declines, playback and
    // the in-app UI still work fine — they just won't see the system
    // notification or its transport controls. Startup asks for notifications
    // first, then (when that dialog is answered) folder access, so both
    // prompts appear back-to-back on first launch. The second step is chained
    // here because Android can't show two permission screens at once.
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        // Granted or not, move on to folder access.
        if (!hasStoragePermission()) {
            requestPermissionIfNeededThenLoad()
        } else {
            permissionFlowActive = false
            if (pageLoaded) listNovels()
        }
    }

    // Everything for the music player (native player, library scan, song downloads) lives in
    // AudioBackend, which exists twice: the real one in app/src/full/, an empty one in app/src/noaudio/.
    private val audio = AudioBackend(this)

    /** Asks for notification access and folder access in one go, once per
     * launch. Called from onCreate and (if the page asks before then)
     * from tryAutoReconnect(). */
    private fun requestStartupPermissions() {
        if (permissionFlowStarted) return
        permissionFlowStarted = true
        permissionFlowActive = true
        // Notifications are only for the player's system notification, so the "noaudio" build skips them.
        if (BuildConfig.HAS_AUDIO && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        } else if (!hasStoragePermission()) {
            requestPermissionIfNeededThenLoad()
        } else {
            permissionFlowActive = false
        }
    }

    // Root folder containing one subfolder per novel, e.g.
    // Novel/Shadow-Slave/*.txt, Novel/Iron-Prince/*.txt. The old flat
    // Novel/Chapters folder (from before novels were split up) is still
    // recognized and shown as one novel entry, for backward compatibility.
    private val novelRoot = File("/storage/emulated/0/Novel")

    // Where audio-player.js's MediaLibrary.scan() expects to find music —
    // documented in the README's "Audio player" section.
    internal val audioRoot = File("/storage/emulated/0/Novel/Audio")

    // "Fetch new chapters" and "Delete chapters": the Python scripts in assets/scripts, run in
    // Termux in the background (see ChapterTools.kt and the page's reader.js).
    private val chapterTools: ChapterTools = ChapterTools(
        activity = this,
        novelRoot = novelRoot,
        reservedFolder = audioRoot.name,
        requestRunCommandPermission = { termuxPermissionLauncher.launch(ChapterTools.RUN_COMMAND_PERMISSION) },
        onState = { json -> callPage("onChapterJob", JSONObject.quote(json)) },
    )

    // Termux's own "run commands in Termux" permission; asked the first time a script is run.
    private val termuxPermissionLauncher: androidx.activity.result.ActivityResultLauncher<String> = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> chapterTools.onPermissionResult(granted) }

    // The in-app updater (GitHub Releases -> download -> PackageInstaller): see AppUpdater.kt and the
    // update bar in app-update.js. Its state reaches the page through window.onUpdateState(json).
    private val appUpdater: AppUpdater = AppUpdater(
        activity = this,
        onState = { json -> callPage("onUpdateState", JSONObject.quote(json)) },
    )
    /**
     * The crash log lives in this app's own folder,
     * /storage/emulated/0/Android/data/<package>/files/crash_log.txt, not in the
     * shared Novel/ folder: other apps can't read it there, yet a file manager
     * can often still open it. Falls back to the private files dir if the
     * external one isn't available.
     */
    private fun crashLogFile(): File =
        File(getExternalFilesDir(null) ?: filesDir, "crash_log.txt")

    /**
     * Writes any uncaught crash to a plain text file that can be opened
     * with any file manager (no logcat/adb needed) — useful for
     * diagnosing crashes on locked-down OEM Android builds (e.g. MIUI)
     * that restrict logcat access for non-debuggable apps.
     */
    private fun installCrashLogger() {
        // Older versions wrote the log into the shared Novel/ folder, where
        // other apps could read it. Remove that copy (best effort).
        try {
            val old = File("/storage/emulated/0/Novel/crash_log.txt")
            if (old.exists()) old.delete()
        } catch (e: Exception) {
            // No storage access yet: nothing to remove.
        }
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val crashFile = crashLogFile()
                crashFile.parentFile?.mkdirs()
                crashFile.writeText(
                    "Crash at ${java.util.Date()}\n" +
                        throwable.stackTraceToString()
                )
            } catch (e: Exception) {
                // If we can't even write the crash log, there's nothing more
                // we can do here — fall through to the default handler.
            }
            defaultHandler?.uncaughtException(thread, throwable)
        }
    }

    // The page is served from this https origin (not file://), so the WebView
    // needs no file access at all. The app's own files come from assets/ via
    // WebViewAssetLoader; local music is served by serveAudio() below.
    internal val appHost = "appassets.androidplatform.net"
    private val appUrl = "https://$appHost/assets/index.html"
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(appHost)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    private val manageStorageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        // Whether granted or not, try loading — listNovels() will report
        // an error to the JS side if permission is still missing. If the
        // page hasn't finished loading yet, onPageFinished() does this.
        permissionFlowActive = false
        // Create the Novel folder the moment access is granted, even if the
        // page is still loading, so it exists on the very first launch.
        if (hasStoragePermission()) ensureNovelFolders()
        if (pageLoaded) listNovels()
    }

    private val legacyPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        permissionFlowActive = false
        val granted = results.isNotEmpty() && results.values.all { it }
        // Create the Novel folder the moment access is granted, even if the
        // page is still loading, so it exists on the very first launch.
        if (granted) ensureNovelFolders()
        if (pageLoaded) {
            if (granted) listNovels() else notifyError("Storage permission was not granted.")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashLogger()
        if (BuildConfig.HAS_AUDIO) registerVolumeReceiver()   // it only pauses the music on mute
        audio.warmUp()   // unpacks yt-dlp / ffmpeg (nothing in the no-audio build)
        appUpdater.start()
        // A few seconds after launch, so the check does not compete with the splash and the library scan.
        screenHandler.postDelayed({ appUpdater.checkOnStart() }, 6000L)
        // If access was already granted, make sure the folders exist right away.
        if (hasStoragePermission()) Thread { ensureNovelFolders() }.start()

        // Start reading the music library right away, in parallel with the page
        // and the chapter loading. (Without storage access yet, it starts from
        // listNovels() once access is granted.)
        if (hasStoragePermission()) audio.runScan()

        webView = WebView(this)
        webView.setBackgroundColor(android.graphics.Color.parseColor("#0b0d12"))
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // Lock the WebView down. The page comes from the https origin above, so
        // it never needs file:// or content:// access, and nothing it loads
        // may be mixed (http) content. Local music is not read from file://
        // by the page; it is requested from this same origin under /audio/
        // and served by serveAudio(), which only hands out real audio files
        // inside Novel/Audio.
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        @Suppress("DEPRECATION")
        webView.settings.allowFileAccessFromFileURLs = false
        @Suppress("DEPRECATION")
        webView.settings.allowUniversalAccessFromFileURLs = false
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // mediaPlaybackRequiresUserGesture is turned off so that programmatic
        // calls to play() (next/prev, auto-advance to the following track,
        // resuming after a reading break) aren't silently blocked for not
        // originating from a fresh tap — the *first* play always does come
        // from a genuine tap on the play button.
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
            // The only page this WebView may show is the app itself. A link
            // the user taps that points at http/https goes to the external
            // browser; every other navigation (and anything a script starts
            // without a tap) is dropped.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                if (isAppUrl(target)) return false
                val scheme = target.scheme
                if (request.hasGesture() && (scheme == "https" || scheme == "http")) {
                    openInExternalBrowser(target)
                }
                return true
            }

            // Everything the page requests is answered here: its own assets
            // through the asset loader, music through serveAudio(), and every
            // other host or path is refused (no network from the page).
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val target = request.url
                if (target.scheme != "https" || target.host != appHost) return plainResponse(403)
                if (request.method != "GET") return plainResponse(405)
                val path = target.path ?: return plainResponse(404)
                if (path.startsWith("/audio/")) {
                    return audio.serveAudio(path.removePrefix("/audio/"), request.requestHeaders) ?: plainResponse(404)
                }
                if (!path.startsWith("/assets/")) return plainResponse(404)
                val response = assetLoader.shouldInterceptRequest(target) ?: return plainResponse(404)
                return if (path.endsWith(".woff2")) {
                    WebResourceResponse("font/woff2", null, response.data)
                } else {
                    response
                }
            }

            // Android can kill the WebView's separate renderer process while the
            // app is in the background (typically after the phone has been locked
            // for a while and memory is needed elsewhere), and a renderer can also
            // crash. If the app does not handle that, the whole app is shut down
            // the next time it is opened. Handle it: drop the dead WebView and
            // rebuild the screen; saved settings are re-read on startup.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (webViewGone) return true
                webViewGone = true
                pageLoaded = false
                try {
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()
                } catch (e: Exception) {
                    // Already gone; nothing to clean up.
                }
                val now = System.currentTimeMillis()
                if (now - lastRendererGoneAt < 5_000L) {
                    // Died again right after a rebuild: stop instead of looping.
                    finish()
                } else {
                    lastRendererGoneAt = now
                    recreate()
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                // The page (and reader.js, which defines window.onFolderPicked
                // and window.onStatusBarInset) is now fully loaded, so re-send
                // the current status bar height in case it loaded before this
                // fired, and auto-load novels if we already have permission.
                setupImmersiveMode()
                pageLoaded = true
                if (hasStoragePermission()) {
                    listNovels()
                } else if (!permissionFlowActive) {
                    // Permission was refused (or never needed asking) and
                    // nothing is pending: show the setup guide rather than
                    // leaving the launch screen up.
                    notifyError("Storage access hasn't been allowed yet.")
                }
                // The MediaController may have connected before this page
                // finished loading, in which case the original ready
                // callback hit a page that had no handler yet and was
                // silently dropped (leaving the player on the WebView
                // fallback engine). Re-announce it now.
                audio.onPageFinished()
            }
        }
        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onJsAlert(
                view: WebView,
                url: String?,
                message: String?,
                result: JsResult
            ): Boolean {
                try {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setOnCancelListener { result.cancel() }
                        .setCancelable(false)
                        .show()
                } catch (e: Exception) {
                    result.confirm()
                }
                return true
            }

            override fun onJsConfirm(
                view: WebView,
                url: String?,
                message: String?,
                result: JsResult
            ): Boolean {
                try {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }
                        .setCancelable(false)
                        .show()
                } catch (e: Exception) {
                    result.cancel()
                }
                return true
            }
        }

        webView.loadUrl(appUrl)

        setupImmersiveMode()

        // Back closes whatever is open (dialog, library, panel, menu) before
        // it is allowed to leave the app. The page decides; see
        // window.handleBack in reader.js.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){return !!(window.handleBack && window.handleBack());})()"
                ) { result ->
                    if (result != "true") {
                        // Nothing left to close: leaving needs a second back
                        // press within 2 seconds, so a stray tap or gesture
                        // doesn't drop you out of the app.
                        val now = System.currentTimeMillis()
                        if (now - lastBackPressMs < 2000L) {
                            finish()
                        } else {
                            lastBackPressMs = now
                            android.widget.Toast.makeText(
                                this@MainActivity, "Press back again to exit",
                                android.widget.Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                }
            }
        })

        requestStartupPermissions()

        audio.connect()
    }

    /**
     * Makes the navigation bar (bottom) transparent, same as before, and
     * hides the status bar (top) entirely — the notification bar itself
     * is not drawn at all, though swiping down from the top briefly
     * reveals it again (standard Android behavior).
     *
     * Hiding it doesn't remove the physical camera cutout though, so we
     * still measure exactly how much space the cutout needs (via the
     * displayCutout inset, not the status bar inset, since the status
     * bar is hidden and no longer reports a height) and hand that to the
     * web page as window.onStatusBarInset(heightInCssPx). reader.js uses
     * that to reserve precisely that much space as a permanent gap above
     * its own top bar — with a clock drawn in it — so nothing is ever
     * drawn underneath the camera hole.
     */
    private fun setupImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        window.statusBarColor = android.graphics.Color.TRANSPARENT

        // Let content draw into the cutout area in any orientation, so we
        // can measure it ourselves and reserve exactly that much space
        // rather than leaving a system-decided gap behind.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val params = window.attributes
            params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            window.attributes = params
        }

        val controller = WindowInsetsControllerCompat(window, webView)
        controller.isAppearanceLightNavigationBars = false
        controller.isAppearanceLightStatusBars = false
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insetsController = controller

        // Default/"reading" state: status bar hidden, navigation bar
        // shown but transparent (see window.navigationBarColor above) —
        // this is the look while a chapter is open and is left exactly
        // as it was. It only changes to fully hidden while the sidebar
        // drawer is open; see applySystemBarsForMenuState() and the
        // setMenuOpen() bridge method below, called live from
        // reader.js's syncScrim() every time the drawer opens/closes.
        applySystemBarsForMenuState(open = false)

        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            view.setPadding(0, 0, 0, insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
            reportInsets(insets)
            insets
        }
        ViewCompat.requestApplyInsets(webView)

        val currentInsets = ViewCompat.getRootWindowInsets(webView)
        if (currentInsets != null) {
            webView.setPadding(0, 0, 0, currentInsets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
            reportInsets(currentInsets)
        }
    }

    /**
     * Switches between the two system-bar states the app ever uses:
     *
     *   open = false ("reading"): status bar hidden, navigation bar
     *     shown but transparent — the existing look while a chapter is
     *     on screen, left untouched.
     *
     *   open = true ("menu"): both bars fully hidden. The sidebar drawer
     *     is a full-height panel; a transparent-but-visible nav bar sitting
     *     on top of it let the reading text (or the drawer's own bottom
     *     edge, which is deliberately inset by exactly the nav bar's
     *     height — see --nav-bar-height in index.html) show straight
     *     through the icons. Hiding it outright while the drawer is open
     *     removes that overlap, and also lets the drawer's CSS
     *     bottom:var(--nav-bar-height) collapse to 0 on its own, since
     *     the live inset reported to reportNavBarInset() below drops to 0
     *     the moment the bar is actually hidden — so the drawer reaching
     *     the true bottom edge falls out of this automatically rather
     *     than needing a second, separate fix.
     *
     * Driven live from reader.js's syncScrim() via the setMenuOpen()
     * bridge method, every time the drawer opens or closes.
     */
    private fun applySystemBarsForMenuState(open: Boolean) {
        val controller = insetsController ?: return
        if (open) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.hide(WindowInsetsCompat.Type.statusBars())
            controller.show(WindowInsetsCompat.Type.navigationBars())
        }
    }

    /**
     * Tells the page an inset height in CSS px (not raw device px) through
     * window.[handler]. Two are reported: the front-camera cutout gap
     * (onStatusBarInset) and the transparent navigation bar (onNavBarInset).
     * reader.js uses the latter to keep fixed-position elements, like the
     * sidebar, from extending underneath the back/home/recents icons.
     */
    private fun reportInset(handler: String, px: Int) {
        val density = resources.displayMetrics.density
        callPage(handler, (if (density > 0f) px / density else px.toFloat()).toString())
    }

    private fun reportInsets(insets: WindowInsetsCompat) {
        reportInset("onStatusBarInset", insets.getInsets(WindowInsetsCompat.Type.displayCutout()).top)
        reportInset("onNavBarInset", insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::webView.isInitialized) {
            setupImmersiveMode()
        }
    }

    // Muting the media volume (by any means: volume keys, the system volume
    // panel, the in-app slider) pauses the music; raising it again resumes
    // it. Only a pause caused by muting is undone. Handled here, natively, so
    // it also works with the screen off or the app in the background.
    private val volumeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val stream = intent?.getIntExtra("android.media.EXTRA_VOLUME_STREAM_TYPE", -1)
            if (stream == AudioManager.STREAM_MUSIC) handleMuteChange()
        }
    }

    private fun handleMuteChange() {
        try {
            val am = getSystemService(AudioManager::class.java) ?: return
            audio.onMuteChanged(am.getStreamVolume(AudioManager.STREAM_MUSIC) <= 0)
        } catch (e: Exception) {
            // Not permitted right now — ignore.
        }
        syncPageVolume()
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private fun registerVolumeReceiver() {
        val filter = IntentFilter("android.media.VOLUME_CHANGED_ACTION")
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(volumeReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(volumeReceiver, filter)
            }
        } catch (e: Exception) {
            // Without it, muting still works from the slider and volume keys.
        }
    }

    // Raises/lowers the real media volume (shows the system volume UI) and
    // refreshes the slider in the audio panel.
    private fun adjustMediaVolume(raise: Boolean) {
        try {
            val am = getSystemService(AudioManager::class.java)
            am?.adjustStreamVolume(
                AudioManager.STREAM_MUSIC,
                if (raise) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER,
                AudioManager.FLAG_SHOW_UI
            )
        } catch (e: Exception) {
            // Not permitted in the current device state (e.g. Do Not Disturb) — ignore.
        }
        syncPageVolume()
    }

    // True while any in-app menu/panel is open; set from reader.js via
    // AndroidBridge.setVolumeKeysFree(). Read in handleVolumeKey().
    @Volatile
    private var menuOpen = false

    // Whether the volume buttons scroll the page while reading. Mirrors the
    // "Volume button scroll" switch in the theme panel (reader.js reports it
    // through AndroidBridge.setVolumeScrollEnabled()). On by default.
    @Volatile
    private var volumeScrollEnabled = true

    /**
     * Handles the hardware volume buttons. Overriding dispatchKeyEvent (not
     * onKeyDown) means this runs BEFORE the WebView sees the key, so
     * nothing inside the page can swallow it.
     *
     * Normally the buttons scroll the page (Volume Up = scroll up, Volume
     * Down = scroll down). They change the real media volume instead while
     * a menu/panel is open (e.g. the audio player) or when volume scrolling
     * is switched off in the settings. Both key-down and key-up are
     * consumed, which stops Android's own volume UI from also firing.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if ((code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) &&
            ::webView.isInitialized
        ) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                keepScreenAwake()
                handleVolumeKey(code == KeyEvent.KEYCODE_VOLUME_DOWN)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun handleVolumeKey(down: Boolean) {
        // Fast path: the page already told us volume scrolling shouldn't apply.
        if (menuOpen || !volumeScrollEnabled) {
            adjustMediaVolume(!down)
            return
        }
        // Otherwise ask the page. It scrolls the reader, or answers "volume"
        // if a menu is open / scrolling is off (covers a stale flag) — then
        // the key changes the media volume.
        webView.evaluateJavascript(
            "window.scrollReaderByVolumeKey ? window.scrollReaderByVolumeKey(" + down + ") : ''"
        ) { result ->
            if (result == "\"volume\"") adjustMediaVolume(!down)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        keepScreenAwake()
        return super.onKeyDown(keyCode, event)
    }

    /**
     * Releases the MediaController connection and stops polling — NOT
     * the same as stopping playback: PlaybackService and its ExoPlayer
     * instance are a separate component and keep running/playing
     * regardless of what happens to this Activity (that's the entire
     * point of the Service architecture — see PlaybackService.kt).
     * Clearing the static queueNavigationListener here matters because
     * it would otherwise hold a reference to this Activity (via the
     * webView it closes over) past the Activity's own lifetime — a
     * classic static-reference leak.
     */
    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(volumeReceiver) } catch (e: Exception) { /* not registered */ }
        audio.release()
        chapterTools.release()
        appUpdater.release()
        screenHandler.removeCallbacks(releaseScreenRunnable)
        screenHandler.removeCallbacks(closeRunnable)
        nightLockHandler.removeCallbacks(nightLockCheck)
    }

    override fun onPause() {
        super.onPause()
        appInForeground = false
        adaptiveBrightness.onPause()
        screenHandler.removeCallbacks(releaseScreenRunnable)
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (::webView.isInitialized && !webViewGone) {
            webView.onPause()
        }
    }

    override fun onResume() {
        super.onResume()
        appInForeground = true
        adaptiveBrightness.onResume()
        appUpdater.onResume()
        audio.onResume()
        keepScreenAwake()
        nightLockHandler.removeCallbacks(nightLockCheck)
        if (BuildConfig.HAS_AUDIO) nightLockHandler.post(nightLockCheck)   // it only pauses the music
        if (::webView.isInitialized && !webViewGone) {
            webView.onResume()
        }
        // Only (re)load novels on resume if we haven't successfully loaded
        // yet this session — e.g. the user just granted storage permission
        // in system Settings and is coming back. If we've already loaded
        // once, ordinary app-switching (checking a notification, etc.)
        // shouldn't re-scan the whole folder and rebuild the chapter list
        // every time; reader.js keeps its own state and scroll position
        // intact across a simple resume.
        if (::webView.isInitialized && !webViewGone && webView.progress == 100 && hasStoragePermission() && !hasLoadedOnce) {
            listNovels()
        }
    }

    inner class AndroidBridge {

        // Called on startup and when the user taps "Grant storage access".
        // Requests permission if needed, then lists available novels.
        @JavascriptInterface
        fun pickFolder() {
            runOnUiThread { requestPermissionIfNeededThenLoad() }
        }

        @JavascriptInterface
        fun tryAutoReconnect() {
            runOnUiThread {
                if (hasStoragePermission()) {
                    if (!permissionFlowActive) listNovels()
                } else if (!permissionFlowStarted) {
                    // First run: ask now (together with notifications).
                    // The launch screen stays up until the answer arrives
                    // and the chapters have loaded.
                    requestStartupPermissions()
                } else if (!permissionFlowActive) {
                    notifyError("Storage access hasn't been allowed yet.")
                }
            }
        }

        // Loads the chapters for one specific novel subfolder.
        @JavascriptInterface
        fun loadNovel(novelFolderName: String) {
            runOnUiThread { loadNovelChapters(novelFolderName) }
        }

        // "Fetch new chapters" (shown under the last chapter): runs chapter_downloader.py --resume in
        // Termux, in the background. It opens the page the newest saved chapter came from, finds the
        // link to the chapter after it and downloads everything up to the latest. Returns false when
        // nothing was started (unknown novel, or a job is already running); otherwise the page hears
        // about it through window.onChapterJob(json). See ChapterTools.kt.
        @JavascriptInterface
        fun fetchNewChapters(novel: String): Boolean = chapterTools.fetchNewChapters(novel)

        // "Delete chapters" (side menu): runs delete_chapters.py in Termux and removes the chapter
        // files 1 to [upToChapter] of the novel. Same answers as fetchNewChapters.
        @JavascriptInterface
        fun deleteChapters(novel: String, upToChapter: Int): Boolean =
            chapterTools.deleteChapters(novel, upToChapter)

        // In-app updates (AppUpdater.kt, app-update.js). All answers arrive as window.onUpdateState(json).
        // checkForUpdate: a manual check (always answers, even "up to date"); downloadUpdate and
        // installUpdate act on what the last check found; updateState is the latest state JSON ("" before
        // the first); the auto switch decides whether the app checks and downloads by itself.
        @JavascriptInterface
        fun checkForUpdate() { appUpdater.check(manual = true) }

        @JavascriptInterface
        fun downloadUpdate() { appUpdater.download() }

        @JavascriptInterface
        fun installUpdate() { runOnUiThread { appUpdater.install() } }

        @JavascriptInterface
        fun updateState(): String = appUpdater.stateJson()

        @JavascriptInterface
        fun getAutoUpdate(): Boolean = appUpdater.autoEnabled()

        @JavascriptInterface
        fun setAutoUpdate(on: Boolean) { appUpdater.setAutoEnabled(on) }

        // The latest window.onChapterJob state as JSON ("" if no job ran yet): lets the page catch up
        // after the app was in the background while the answer arrived.
        @JavascriptInterface
        fun chapterJobState(): String = chapterTools.stateJson()

        // "Download songs" wizard (song-download.js). A job is answered through
        // window.onSongDownloadStatus(jobId, "done"|"failed", message), exactly once; both methods
        // return false only when a job with that id is already running. Two jobs may run at once
        // (the next song downloads while the current one is placed). See SongDownloader.kt.
        //
        // stageSong: downloads one link into Audio/.staging/ (invisible to the music scan). The
        // "done" message is the downloaded file's full path.
        @JavascriptInterface
        fun stageSong(jobId: String, url: String): Boolean = audio.stageSong(jobId, url)

        // placeSong: names a staged song [name] ("" = keep) and moves it into the playlist folder
        // [folder] ("" = Audio/ itself). The "done" message is the song's new full path.
        @JavascriptInterface
        fun placeSong(jobId: String, path: String, name: String, folder: String): Boolean =
            audio.placeSong(jobId, path, name, folder)

        // Stops every running download/placement (the user left the tab).
        @JavascriptInterface
        fun cancelSongDownload() { audio.cancelSongDownload() }

        // Deletes everything in the staging folder: songs that were downloaded but never placed.
        @JavascriptInterface
        fun discardStagedSongs() { audio.discardStagedSongs() }

        // The text on the clipboard ("" if none), for the "Click to paste" button. Android only lets
        // an app read the clipboard while it is in the foreground, which it is when the button is tapped.
        @JavascriptInterface
        fun readClipboard(): String {
            return try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: ""
            } catch (e: Exception) {
                ""
            }
        }

        // Settings file: /storage/emulated/0/Novel/settings.txt. Returns null when storage isn't accessible yet, ""
        // when the file doesn't exist, otherwise its text. See settings-file.js
        // for the format.
        @JavascriptInterface
        fun readSettingsFile(): String? {
            if (!hasStoragePermission()) return null
            return try {
                // A real settings file is about a kilobyte. Anything far larger
                // is not ours (or was tampered with): ignore it and let it be
                // rewritten from the app's current settings.
                if (settingsFile.exists() && settingsFile.length() <= MAX_SETTINGS_BYTES) {
                    settingsFile.readText()
                } else {
                    ""
                }
            } catch (e: Exception) {
                null
            }
        }

        @JavascriptInterface
        fun writeSettingsFile(text: String): Boolean {
            if (!hasStoragePermission()) return false
            if (text.length > MAX_SETTINGS_BYTES) return false
            return try {
                novelRoot.mkdirs()
                settingsFile.writeText(text)
                true
            } catch (e: Exception) {
                false
            }
        }

        // Moon-lock unlock (see MoonUnlockStore): the page can only start the
        // hour and ask how much is left; the record itself stays native.
        @JavascriptInterface
        fun moonUnlockGrant(): Boolean = moonUnlock.grant(moonUnlockMs)

        @JavascriptInterface
        fun moonUnlockGrantPuzzle(): Boolean = moonUnlock.grant(moonPuzzleUnlockMs)

        @JavascriptInterface
        fun moonUnlockRemainingMs(): Long = moonUnlock.remainingMs()

        // Keeps the native window in step with the reading theme: the
        // WebView's backdrop colour (visible during overscroll/resizes) and
        // whether the system bar icons are drawn dark (light theme) or
        // light (dark theme).
        @JavascriptInterface
        fun setThemeColors(bgHex: String, isLight: Boolean) {
            runOnUiThread {
                try {
                    webView.setBackgroundColor(android.graphics.Color.parseColor(bgHex))
                    insetsController?.isAppearanceLightNavigationBars = isLight
                    insetsController?.isAppearanceLightStatusBars = isLight
                } catch (e: Exception) {
                    // Invalid colour string — keep the current look.
                }
            }
        }

        // Called live from reader.js's syncScrim() every time the sidebar
        // drawer opens or closes — see applySystemBarsForMenuState() for
        // what this actually changes.
        @JavascriptInterface
        fun setMenuOpen(open: Boolean) {
            runOnUiThread { applySystemBarsForMenuState(open) }
        }

        // Rescan button / explicit scan: always walk the folder again (see AudioBackend).
        @JavascriptInterface
        fun scanAudio() { runOnUiThread { audio.scanNow() } }

        // Called once by the page at start-up: hands over the scan already started in onCreate.
        @JavascriptInterface
        fun scanAudioStartup() { runOnUiThread { audio.scanAtStartup() } }

        // Novel cover for the library screen: an image inside that novel's
        // own folder (cover/folder/poster/... .jpg|.png|.webp, or failing
        // that the first image there), as a small data: URI. "" if none.
        @JavascriptInterface
        fun getNovelCover(novelName: String): String {
            val bytes = loadNovelCoverBytes(novelName) ?: return ""
            return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        }

        // Cover art as a data: URI for the in-app player, or "" if none.
        @JavascriptInterface
        fun getArtwork(path: String): String = audio.artworkDataUri(path)

        // The nativeAudio* calls are what audio-player.js's NativeAudioEngine runs on (see AudioBackend).
        @JavascriptInterface
        fun nativeAudioLoad(path: String, title: String, artist: String, album: String) =
            audio.nativeAudioLoad(path, title, artist, album)

        @JavascriptInterface
        fun nativeAudioCrossfade(
            path: String, title: String, artist: String, album: String,
            seconds: Double, outGain: Double, inGain: Double
        ) = audio.nativeAudioCrossfade(path, title, artist, album, seconds, outGain, inGain)

        @JavascriptInterface
        fun nativeAudioSyncState() = audio.nativeAudioSyncState()

        @JavascriptInterface
        fun nativeAudioPlay() = audio.nativeAudioPlay()

        @JavascriptInterface
        fun nativeAudioPause() = audio.nativeAudioPause()

        @JavascriptInterface
        fun nativeAudioSeek(seconds: Double) = audio.nativeAudioSeek(seconds)

        // The volume slider's real effect: sets the phone's media volume.
        @JavascriptInterface
        fun setSystemVolume(volume: Double) = audio.setSystemVolume(volume)

        // Separate from setMenuOpen() above (drawer-only, system bars):
        // this is true while ANY menu/panel is open, so the volume
        // buttons change the media volume instead of scrolling.
        @JavascriptInterface
        fun setVolumeKeysFree(open: Boolean) {
            menuOpen = open
        }

        // True when a Bluetooth audio device is connected as an output (audio-player.js asks once at start-up).
        @JavascriptInterface
        fun isBluetoothAudioConnected(): Boolean = audio.isBluetoothAudioConnected()

        // Mirrors the "Adaptive brightness" switch in the theme panel (see
        // AdaptiveBrightness.kt). Returns false when the phone has no light
        // sensor, so the page can put the switch back off.
        @JavascriptInterface
        fun setAdaptiveBrightness(enabled: Boolean): Boolean {
            if (enabled && !adaptiveBrightness.isSupported) return false
            runOnUiThread { adaptiveBrightness.setEnabled(enabled) }
            return true
        }

        // Mirrors the "Volume button scroll" switch in the theme panel.
        @JavascriptInterface
        fun setVolumeScrollEnabled(enabled: Boolean) {
            volumeScrollEnabled = enabled
        }

        @JavascriptInterface
        fun getSystemVolume(): Double = audio.getSystemVolume()

        @JavascriptInterface
        fun nativeAudioSetVolume(volume: Double) = audio.nativeAudioSetVolume(volume)

        // Replay-gain boost for quiet tracks (see NativeAudioEffects.kt).
        @JavascriptInterface
        fun nativeAudioSetBoostDb(db: Double) = audio.nativeAudioSetBoostDb(db)
    }

    internal fun hasStoragePermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            // Read AND write: without write the Novel folder can't be created.
            ContextCompat.checkSelfPermission(
                this,
                android.Manifest.permission.READ_EXTERNAL_STORAGE
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(
                    this,
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        }
    }

    /**
     * Creates /storage/emulated/0/Novel and Novel/Audio if they are missing.
     * Called as soon as storage access is granted (so the folders exist on
     * the very first launch after installing) and again whenever the novels
     * are listed. A no-op when they already exist; never touches their
     * contents. Returns false if the Novel folder could not be created.
     */
    private fun ensureNovelFolders(): Boolean {
        return try {
            if (!novelRoot.exists()) novelRoot.mkdirs()
            if (BuildConfig.HAS_AUDIO && novelRoot.isDirectory && !audioRoot.exists()) audioRoot.mkdirs()
            novelRoot.isDirectory
        } catch (e: Exception) {
            false
        }
    }

    private fun requestPermissionIfNeededThenLoad() {
        if (hasStoragePermission()) {
            listNovels()
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                intent.data = Uri.parse("package:$packageName")
                manageStorageLauncher.launch(intent)
            } catch (e: Exception) {
                // Some devices don't support the app-specific screen; fall back
                // to the general "All files access" settings list.
                val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                manageStorageLauncher.launch(intent)
            }
        } else {
            legacyPermissionLauncher.launch(
                arrayOf(
                    android.Manifest.permission.READ_EXTERNAL_STORAGE,
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                )
            )
        }
    }

    /**
     * Scans /storage/emulated/0/Novel/ for subfolders (one per novel) and
     * sends the list to JS. The old flat Novel/Chapters folder (used
     * before novels were split into subfolders) is included as its own
     * entry too, for backward compatibility with existing setups.
     */
    private fun listNovels() {
        Thread {
            try {
                if (!hasStoragePermission()) {
                    runOnUiThread {
                        notifyError("Storage access is needed to read /storage/emulated/0/Novel. Tap \"Allow access to your novels\" to grant it.")
                    }
                    return@Thread
                }

                // Novel/ and Novel/Audio/ are created here on first run (not
                // only when the Music panel first scans), so the full folder
                // structure exists whether or not the user opens it. Never
                // touches existing folders or their contents.
                if (!ensureNovelFolders()) {
                    runOnUiThread {
                        notifyError("Couldn't create /storage/emulated/0/Novel. Check that storage access is allowed for this app.")
                    }
                    return@Thread
                }

                // Audio/ is where the music scan (audio.runScan()) looks for
                // music and playlist subfolders, not a novel — it must never show up in the novel picker. Matched
                // by name case-insensitively rather than by exact File equality
                // so it's still excluded even if listFiles() returns a
                // differently-cased or differently-rooted File instance for
                // the same folder.
                val novelNames = novelRoot.listFiles { f -> f.isDirectory }
                    ?.filter { !it.name.equals(audioRoot.name, ignoreCase = true) }
                    // Folders starting with a dot are never novels.
                    ?.filter { !it.name.startsWith(".") }
                    ?.map { it.name }
                    ?.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it })
                    ?: emptyList()

                val namesArray = JSONArray()
                novelNames.forEach { namesArray.put(it) }

                // Put the chapter scripts in the Novel folder, where Termux can run them.
                try { chapterTools.deployScripts() } catch (e: Exception) { /* tried again on every run */ }

                // Permission is confirmed here: make sure the music scan is under way too.
                audio.runScan()

                runOnUiThread {
                    hasLoadedOnce = true
                    callPage("onNovelsListed", JSONObject.quote(namesArray.toString()))
                }
            } catch (e: Exception) {
                runOnUiThread { notifyError("Could not read /storage/emulated/0/Novel: ${e.message}") }
            }
        }.start()
    }

    /**
     * Loads every .txt file inside /storage/emulated/0/Novel/<novelFolderName>/
     * and sends it to JS as the active novel's chapter list.
     */
    private fun loadNovelChapters(novelFolderName: String) {
        Thread {
            try {
                if (!hasStoragePermission()) {
                    runOnUiThread {
                        notifyError("Storage permission is needed to read that novel's folder.")
                    }
                    return@Thread
                }

                val safeName = File(novelFolderName).name // strips any path components
                val novelDir = File(novelRoot, safeName)

                if (!novelDir.exists() || !novelDir.isDirectory) {
                    runOnUiThread {
                        notifyError("Folder not found: /storage/emulated/0/Novel/$safeName")
                    }
                    return@Thread
                }

                // next_chapter.txt is only the downloader's bookmark, not a chapter.
                val txtFiles = novelDir.listFiles { f ->
                    f.isFile && ChapterTools.isChapterFile(f.name)
                } ?: emptyArray()

                val filesArray = JSONArray()
                for (f in txtFiles) {
                    try {
                        val text = f.readText(Charsets.UTF_8)
                        val obj = JSONObject()
                        obj.put("name", f.name)
                        obj.put("text", text)
                        filesArray.put(obj)
                    } catch (e: Exception) {
                        // Skip unreadable file, continue with the rest.
                    }
                }

                runOnUiThread {
                    callPage("onFolderPicked", JSONObject.quote(safeName) + ", " + JSONObject.quote(filesArray.toString()))
                }
            } catch (e: Exception) {
                runOnUiThread { notifyError("Could not read that novel's folder: ${e.message}") }
            }
        }.start()
    }

    private fun loadNovelCoverBytes(novelName: String): ByteArray? {
        return try {
            if (!hasStoragePermission()) return null
            val dir = File(novelRoot, File(novelName).name) // strips path parts
            if (!dir.isDirectory) return null
            val exts = setOf("jpg", "jpeg", "png", "webp")
            val images = dir.listFiles { f -> f.isFile && exts.contains(f.extension.lowercase()) }
                ?: return null
            if (images.isEmpty()) return null
            val preferred = listOf("cover", "folder", "front", "poster", "thumbnail", "thumb", "art", "image")
            val chosen = preferred.firstNotNullOfOrNull { n ->
                images.firstOrNull { it.nameWithoutExtension.equals(n, ignoreCase = true) }
            } ?: images.sortedBy { it.name.lowercase() }.first()

            val cacheDirCovers = File(cacheDir, "covers").apply { mkdirs() }
            val key = (chosen.absolutePath + chosen.lastModified()).hashCode().toString()
            val cached = File(cacheDirCovers, "$key.jpg")
            if (cached.exists()) return cached.readBytes()
            val scaled = scaleToJpeg(chosen.readBytes(), 480) ?: return null
            cached.writeBytes(scaled)
            scaled
        } catch (e: Exception) {
            null
        }
    }

    internal fun scaleToJpeg(raw: ByteArray, maxSide: Int): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxSide && bounds.outHeight / (sample * 2) >= maxSide) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(
            raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample }
        ) ?: return null
        val longest = maxOf(bmp.width, bmp.height)
        val out = if (longest > maxSide) {
            val f = maxSide.toFloat() / longest
            Bitmap.createScaledBitmap(bmp, (bmp.width * f).toInt().coerceAtLeast(1), (bmp.height * f).toInt().coerceAtLeast(1), true)
        } else bmp
        val baos = ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.JPEG, 85, baos)
        return baos.toByteArray()
    }

    private fun isAppUrl(u: Uri): Boolean =
        u.scheme == "https" && u.host == appHost && (u.path ?: "").startsWith("/assets/")

    private fun openInExternalBrowser(u: Uri) {
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, u)
                    .addCategory(Intent.CATEGORY_BROWSABLE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            // No browser installed: nothing to open.
        }
    }

    internal fun plainResponse(code: Int): WebResourceResponse {
        val reason = when (code) {
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            416 -> "Range Not Satisfiable"
            else -> "Error"
        }
        return WebResourceResponse(
            "text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0))
        )
    }

    internal fun notifyError(message: String) {
        callPage("onFolderPickError", JSONObject.quote(message))
    }

    /**
     * Calls window.[fn]([args]) in the page, if the page has defined it yet.
     * [args] must already be valid JavaScript: numbers as they are, strings
     * through JSONObject.quote().
     */
    /** Runs [block] on the WebView's thread. */
    internal fun postToPage(block: () -> Unit) {
        if (::webView.isInitialized) webView.post { block() }
    }

    internal fun callPage(fn: String, args: String = "") {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript("window.$fn && window.$fn($args);", null)
    }

    /** Asks the audio panel to re-read the phone's media volume. */
    private fun syncPageVolume() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            "window.NovelAudio && window.NovelAudio.syncVolume && window.NovelAudio.syncVolume();", null
        )
    }
}

/** When a WebView renderer last died; survives recreate() so a crash loop can be stopped. */
private var lastRendererGoneAt = 0L

package com.scell.novelreader.redesign

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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
    private val closeRunnable = object : Runnable {
        override fun run() {
            val c = mediaController
            val nativeActive = c != null && (c.isPlaying ||
                (c.playWhenReady && (c.playbackState == Player.STATE_BUFFERING ||
                    c.playbackState == Player.STATE_READY)))
            if (nativeActive) {
                screenHandler.postDelayed(this, inactivityCloseMs)
                return
            }
            if (!::webView.isInitialized) {
                finishAndRemoveTask()
                return
            }
            webView.evaluateJavascript(
                "!!(window.NovelAudio && window.NovelAudio.isPlaying && window.NovelAudio.isPlaying())"
            ) { result ->
                if (result == "true") {
                    screenHandler.postDelayed(this, inactivityCloseMs)
                } else {
                    finishAndRemoveTask()
                }
            }
        }
    }

    // Night lock, native side. reader.js draws the lock between 12:00 AM and
    // 6:00 AM. This also stops background playback if WebView timers pause.
    // Respect the moon lock's persisted one-hour unlock so a successful cheat
    // works for native audio as well as the WebView UI.
    private val nightLockHandler = Handler(Looper.getMainLooper())
    private val nightLockCheck = object : Runnable {
        override fun run() {
            val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
            if (hour < 6) {
                if (pageLoaded) {
                    webView.evaluateJavascript(
                        "!!(window.NovelMoonLock && window.NovelMoonLock.isUnlocked())"
                    ) { unlocked -> if (unlocked != "true") mediaController?.pause() }
                } else {
                    mediaController?.pause()
                }
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

    // The native audio engine (audio-player.js's NativeAudioEngine) talks
    // to PlaybackService's real ExoPlayer through this controller — see
    // connectNativePlayer(). Null until that async connection completes,
    // during which the web page keeps using its WebView <audio> fallback.
    private var mediaController: MediaController? = null
    private var mediaControllerFuture: ListenableFuture<MediaController>? = null

    // Polls mediaController.currentPosition while playing and reports it
    // to JS — MediaController has no built-in "position changed" event,
    // unlike the WebView <audio> element's 'timeupdate'.
    private val progressHandler = Handler(Looper.getMainLooper())
    private var progressRunnable: Runnable? = null

    // Android 13+ requires this to actually be granted for the media
    // notification to display; requested once at startup. If the user
    // declines, playback and the in-app UI still work fine — they just
    // won't see the system notification or its transport controls.
    // Startup asks for notifications first, then (when that dialog is
    // answered) folder access, so both prompts appear back-to-back on first
    // launch. The second step is chained here because Android can't show
    // two permission screens at once.
    private var pageLoaded = false
    private var lastBackPressMs = 0L
    private var permissionFlowActive = false
    private var permissionFlowStarted = false

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

    /** Asks for notification access and folder access in one go, once per
     * launch. Called from onCreate and (if the page asks before then)
     * from tryAutoReconnect(). */
    private fun requestStartupPermissions() {
        if (permissionFlowStarted) return
        permissionFlowStarted = true
        permissionFlowActive = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
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
    private val audioRoot = File("/storage/emulated/0/Novel/Audio")
    private val audioExtensions = setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav")

    /**
     * Writes any uncaught crash to a plain text file that can be opened
     * with any file manager (no logcat/adb needed) — useful for
     * diagnosing crashes on locked-down OEM Android builds (e.g. MIUI)
     * that restrict logcat access for non-debuggable apps.
     */
    private fun installCrashLogger() {
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val crashFile = File("/storage/emulated/0/Novel/crash_log.txt")
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

    private val manageStorageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        // Whether granted or not, try loading — listNovels() will report
        // an error to the JS side if permission is still missing. If the
        // page hasn't finished loading yet, onPageFinished() does this.
        permissionFlowActive = false
        if (pageLoaded) listNovels()
    }

    private val legacyPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        permissionFlowActive = false
        if (pageLoaded) {
            if (granted) listNovels() else notifyError("Storage permission was not granted.")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashLogger()

        webView = WebView(this)
        webView.setBackgroundColor(android.graphics.Color.parseColor("#0b0d12"))
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // The audio player (audio-player.js) plays tracks directly from
        // file:// URIs handed out by scanAudio() below — allowFileAccess
        // is what lets a WebView-loaded page's <audio src="file://...">
        // actually load local files. mediaPlaybackRequiresUserGesture is
        // turned off so that programmatic calls to play() (next/prev,
        // auto-advance to the following track, resuming after a reading
        // break) aren't silently blocked for not originating from a
        // fresh tap — the *first* play always does come from a genuine
        // tap on the ▶ button, which is what actually matters for
        // autoplay-abuse prevention; it's everything downstream of that
        // first tap that this setting unblocks.
        webView.settings.allowFileAccess = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
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
                if (mediaController != null) {
                    view.evaluateJavascript(
                        "window.onNativeAudioReady && window.onNativeAudioReady();", null
                    )
                }
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

        webView.loadUrl("file:///android_asset/index.html")

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

        connectNativePlayer()
    }

    /**
     * Connects a MediaController to PlaybackService's MediaSession. This
     * is the other half of NativeAudioEngine in audio-player.js: once
     * this succeeds, window.onNativeAudioReady() fires and the web page
     * switches from its WebView <audio> fallback to real background
     * playback through this controller.
     *
     * Building a MediaController is asynchronous (it may need to start
     * and bind to PlaybackService first) — the future's listener is what
     * runs once that's done, on the main executor since everything here
     * (mediaController itself, the listener, evaluateJavascript) must
     * stay on the UI thread.
     */
    private fun connectNativePlayer() {
        val sessionToken = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, sessionToken).buildAsync()
        mediaControllerFuture = future
        future.addListener({
            try {
                val controller = future.get()
                mediaController = controller
                controller.addListener(nativePlayerListener)

                // MainActivity is how PlaybackService's QueueAwarePlayer
                // reaches the JS queue for Next/Previous notification
                // taps — see PlaybackService.kt. Set here (not in
                // connectNativePlayer's caller) so it's only live once we
                // actually have a working controller/session to react
                // through.
                PlaybackService.queueNavigationListener = object : PlaybackService.QueueNavigationListener {
                    override fun onSkipToNext() {
                        webView.post {
                            webView.evaluateJavascript("window.onNativeAudioSkipNext && window.onNativeAudioSkipNext();", null)
                        }
                    }
                    override fun onSkipToPrevious() {
                        webView.post {
                            webView.evaluateJavascript("window.onNativeAudioSkipPrevious && window.onNativeAudioSkipPrevious();", null)
                        }
                    }
                }

                webView.evaluateJavascript("window.onNativeAudioReady && window.onNativeAudioReady();", null)
            } catch (e: Exception) {
                // Native engine unavailable (e.g. the service failed to
                // bind) — audio-player.js's LocalAudioEngine keeps
                // working as the fallback, so there's nothing further to
                // do here; deliberately not surfaced as a user-facing
                // error since local playback still works fine.
            }
        }, MoreExecutors.directExecutor())
    }

    /**
     * Forwards ExoPlayer/MediaSession state to JS. Covers both state
     * changes WE caused (a bridge play()/pause() call) and ones we
     * didn't — the system notification's own buttons, a Bluetooth
     * remote, or audio focus lost to another app all land here too,
     * which is exactly why audio-player.js's NativeAudioEngine treats
     * these callbacks as the source of truth rather than only trusting
     * its own bridge calls.
     */
    private val nativePlayerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            val stateJson = JSONObject().put("playing", isPlaying).toString()
            webView.evaluateJavascript(
                "window.onNativeAudioState && window.onNativeAudioState(${JSONObject.quote(stateJson)});",
                null
            )
            if (isPlaying) startProgressUpdates() else stopProgressUpdates()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY -> {
                    val durationMs = mediaController?.duration ?: C.TIME_UNSET
                    val durationSec = if (durationMs != C.TIME_UNSET) durationMs / 1000.0 else 0.0
                    webView.evaluateJavascript(
                        "window.onNativeAudioLoaded && window.onNativeAudioLoaded($durationSec);",
                        null
                    )
                }
                Player.STATE_ENDED -> {
                    webView.evaluateJavascript("window.onNativeAudioEnded && window.onNativeAudioEnded();", null)
                }
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val msg = JSONObject.quote(error.message ?: "Playback error")
            webView.evaluateJavascript("window.onNativeAudioError && window.onNativeAudioError($msg);", null)
        }
    }

    /** Polls playback position roughly twice a second while playing —
     * MediaController has no push-based position-changed callback, so
     * this is the standard Media3 pattern for a live seek bar. Stops
     * itself the moment playback pauses, so it's not silently running
     * (and evaluating JS) in the background doing nothing useful. */
    private fun startProgressUpdates() {
        stopProgressUpdates()
        val runnable = object : Runnable {
            override fun run() {
                val controller = mediaController
                if (controller != null) {
                    val posSec = controller.currentPosition / 1000.0
                    val durMs = controller.duration
                    val durSec = if (durMs != C.TIME_UNSET && durMs > 0) durMs / 1000.0 else 0.0
                    webView.evaluateJavascript(
                        "window.onNativeAudioProgress && window.onNativeAudioProgress($posSec, $durSec);",
                        null
                    )
                }
                progressHandler.postDelayed(this, 1000)
            }
        }
        progressRunnable = runnable
        progressHandler.post(runnable)
    }

    private fun stopProgressUpdates() {
        progressRunnable?.let { progressHandler.removeCallbacks(it) }
        progressRunnable = null
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
            val navBarInsets = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            val cutoutInsets = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            view.setPadding(0, 0, 0, navBarInsets.bottom)
            reportTopGapInset(cutoutInsets.top)
            reportNavBarInset(navBarInsets.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(webView)

        val currentInsets = ViewCompat.getRootWindowInsets(webView)
        if (currentInsets != null) {
            val navBarInsets = currentInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
            val cutoutInsets = currentInsets.getInsets(WindowInsetsCompat.Type.displayCutout())
            webView.setPadding(0, 0, 0, navBarInsets.bottom)
            reportTopGapInset(cutoutInsets.top)
            reportNavBarInset(navBarInsets.bottom)
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

    /** Tells the web page how tall the front-camera cutout gap is, in CSS px (not raw device px). */
    private fun reportTopGapInset(topPx: Int) {
        if (!::webView.isInitialized) return
        val density = resources.displayMetrics.density
        val topDp = if (density > 0f) topPx / density else topPx.toFloat()
        webView.evaluateJavascript(
            "window.onStatusBarInset && window.onStatusBarInset(${topDp});",
            null
        )
    }

    /**
     * Tells the web page how tall the transparent navigation bar is, in
     * CSS px. reader.js uses this to keep fixed-position elements (like
     * the sidebar, which is position:fixed on mobile and so ignores the
     * WebView's own bottom padding) from extending underneath the
     * back/home/recents icons.
     */
    private fun reportNavBarInset(bottomPx: Int) {
        if (!::webView.isInitialized) return
        val density = resources.displayMetrics.density
        val bottomDp = if (density > 0f) bottomPx / density else bottomPx.toFloat()
        webView.evaluateJavascript(
            "window.onNavBarInset && window.onNavBarInset(${bottomDp});",
            null
        )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::webView.isInitialized) {
            setupImmersiveMode()
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
        if (::webView.isInitialized) {
            webView.evaluateJavascript(
                "window.NovelAudio && window.NovelAudio.syncVolume && window.NovelAudio.syncVolume();", null
            )
        }
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
        screenHandler.removeCallbacks(releaseScreenRunnable)
        screenHandler.removeCallbacks(closeRunnable)
        nightLockHandler.removeCallbacks(nightLockCheck)
        stopProgressUpdates()
        mediaControllerFuture?.let { MediaController.releaseFuture(it) }
        mediaController = null
        if (PlaybackService.queueNavigationListener != null) {
            PlaybackService.queueNavigationListener = null
        }
    }

    override fun onPause() {
        super.onPause()
        screenHandler.removeCallbacks(releaseScreenRunnable)
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (::webView.isInitialized) {
            webView.onPause()
        }
    }

    override fun onResume() {
        super.onResume()
        keepScreenAwake()
        nightLockHandler.removeCallbacks(nightLockCheck)
        nightLockHandler.post(nightLockCheck)
        if (::webView.isInitialized) {
            webView.onResume()
        }
        // Only (re)load novels on resume if we haven't successfully loaded
        // yet this session — e.g. the user just granted storage permission
        // in system Settings and is coming back. If we've already loaded
        // once, ordinary app-switching (checking a notification, etc.)
        // shouldn't re-scan the whole folder and rebuild the chapter list
        // every time; reader.js keeps its own state and scroll position
        // intact across a simple resume.
        if (::webView.isInitialized && webView.progress == 100 && hasStoragePermission() && !hasLoadedOnce) {
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

        // Opens the Termux app (if installed) — shown once the user
        // reaches the end of a novel, as a quick way to run the chapter
        // downloader for more chapters.
        @JavascriptInterface
        fun openTermux() {
            runOnUiThread {
                val launchIntent = packageManager.getLaunchIntentForPackage("com.termux")
                if (launchIntent != null) {
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(launchIntent)
                } else {
                    notifyError("Termux isn't installed on this device.")
                }
            }
        }

        // Called live from reader.js's syncScrim() every time the sidebar
        // drawer opens or closes — see applySystemBarsForMenuState() for
        // what this actually changes.
        // Settings file: /storage/emulated/0/Novel/settings.txt. Returns
        // null when storage isn't accessible yet, "" when the file doesn't
        // exist, otherwise its text. See settings-file.js for the format.
        @JavascriptInterface
        fun readSettingsFile(): String? {
            if (!hasStoragePermission()) return null
            return try {
                if (settingsFile.exists()) settingsFile.readText() else ""
            } catch (e: Exception) {
                null
            }
        }

        @JavascriptInterface
        fun writeSettingsFile(text: String): Boolean {
            if (!hasStoragePermission()) return false
            return try {
                novelRoot.mkdirs()
                settingsFile.writeText(text)
                true
            } catch (e: Exception) {
                false
            }
        }

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

        @JavascriptInterface
        fun setMenuOpen(open: Boolean) {
            runOnUiThread { applySystemBarsForMenuState(open) }
        }

        // Scans /storage/emulated/0/Novel/Audio for playable audio files
        // and reports them to audio-player.js's MediaLibrary. Mirrors
        // loadNovel() above: same permission, same background-thread +
        // runOnUiThread(evaluateJavascript) shape.
        @JavascriptInterface
        fun scanAudio() {
            runOnUiThread { listAudioFiles() }
        }

        // The five calls behind audio-player.js's NativeAudioEngine —
        // each just forwards to the MediaController connected in
        // connectNativePlayer(). All are no-ops if that connection
        // hasn't completed yet (mediaController is still null), which
        // matches NativeAudioEngine only ever being reachable from JS
        // after window.onNativeAudioReady has already fired.

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
        fun getArtwork(path: String): String {
            val bytes = loadArtworkBytes(path) ?: return ""
            return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        }

        @JavascriptInterface
        fun nativeAudioLoad(path: String, title: String, artist: String, album: String) {
            // Extract cover art here (we're on the bridge thread, not the
            // UI thread) so the notification and lock screen can show it.
            val art = loadArtworkBytes(path)
            runOnUiThread {
                val metadata = MediaMetadata.Builder()
                    .setTitle(title.ifBlank { null })
                    .setArtist(artist.ifBlank { null })
                    .setAlbumTitle(album.ifBlank { null })
                    .apply {
                        if (art != null) setArtworkData(art, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                    }
                    .build()
                val item = MediaItem.Builder()
                    .setUri(path)
                    .setMediaId(path)
                    .setMediaMetadata(metadata)
                    .build()
                mediaController?.setMediaItem(item)
                mediaController?.prepare()
            }
        }

        // Reports what the native player is really doing, so the web UI
        // can correct itself if an earlier state callback was missed.
        @JavascriptInterface
        fun nativeAudioSyncState() {
            runOnUiThread {
                val c = mediaController
                val playing = c != null && c.playWhenReady &&
                    (c.playbackState == Player.STATE_READY || c.playbackState == Player.STATE_BUFFERING)
                val json = JSONObject().put("playing", playing).toString()
                webView.evaluateJavascript(
                    "window.onNativeAudioState && window.onNativeAudioState(${JSONObject.quote(json)});",
                    null
                )
            }
        }

        @JavascriptInterface
        fun nativeAudioPlay() {
            runOnUiThread { mediaController?.play() }
        }

        @JavascriptInterface
        fun nativeAudioPause() {
            runOnUiThread { mediaController?.pause() }
        }

        @JavascriptInterface
        fun nativeAudioSeek(seconds: Double) {
            runOnUiThread { mediaController?.seekTo((seconds * 1000).toLong()) }
        }

        // The volume slider's real effect: sets the phone's media volume
        // (the stream both ExoPlayer and the WebView play on).
        @JavascriptInterface
        fun setSystemVolume(volume: Double) {
            try {
                val am = getSystemService(AudioManager::class.java) ?: return
                val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                val level = Math.round(volume.coerceIn(0.0, 1.0) * max).toInt()
                am.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)
            } catch (e: Exception) {
                // Not permitted in the current device state — ignore.
            }
        }

        // Separate from setMenuOpen() above (drawer-only, system bars):
        // this is true while ANY menu/panel is open, so the volume
        // buttons change the media volume instead of scrolling.
        @JavascriptInterface
        fun setVolumeKeysFree(open: Boolean) {
            menuOpen = open
        }

        // Mirrors the "Volume button scroll" switch in the theme panel.
        @JavascriptInterface
        fun setVolumeScrollEnabled(enabled: Boolean) {
            volumeScrollEnabled = enabled
        }

        @JavascriptInterface
        fun getSystemVolume(): Double {
            return try {
                val am = getSystemService(AudioManager::class.java) ?: return 0.8
                val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                if (max <= 0) 0.8 else am.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max
            } catch (e: Exception) {
                0.8
            }
        }

        @JavascriptInterface
        fun nativeAudioSetVolume(volume: Double) {
            runOnUiThread {
                mediaController?.volume = volume.toFloat().coerceIn(0f, 1f)
            }
        }

        @JavascriptInterface
        fun nativeAudioSetSpeed(speed: Double) {
            runOnUiThread {
                // Single-arg PlaybackParameters(speed) defaults pitch to
                // 1f — i.e. pitch stays constant while speed changes,
                // matching the WebView engine's preservesPitch=true.
                mediaController?.playbackParameters = PlaybackParameters(speed.toFloat())
            }
        }

        // ---- Native equalizer / replay-gain boost (see NativeAudioEffects.kt) ----

        /** bandsJson: JSON array of 10 dB values, one per UI band. */
        @JavascriptInterface
        fun nativeAudioSetEqualizer(bandsJson: String, preampDb: Double) {
            runOnUiThread {
                try {
                    val arr = JSONArray(bandsJson)
                    val bands = FloatArray(arr.length()) { i -> arr.optDouble(i, 0.0).toFloat() }
                    PlaybackService.effects?.setEqualizer(bands, preampDb.toFloat())
                } catch (e: Exception) {
                    // Malformed input from the page: ignore rather than crash playback.
                }
            }
        }

        @JavascriptInterface
        fun nativeAudioSetBoostDb(db: Double) {
            runOnUiThread {
                PlaybackService.effects?.setBoostDb(db.toFloat())
            }
        }

        /** Answers asynchronously through window.onNativeAudioEffectsInfo(json). */
        @JavascriptInterface
        fun nativeAudioEffectsRequestInfo() {
            runOnUiThread {
                val json = PlaybackService.effects?.describe() ?: "{\"available\":false}"
                webView.evaluateJavascript(
                    "window.onNativeAudioEffectsInfo && window.onNativeAudioEffectsInfo(${JSONObject.quote(json)});",
                    null
                )
            }
        }
    }

    private fun hasStoragePermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(
                this,
                android.Manifest.permission.READ_EXTERNAL_STORAGE
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
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
            legacyPermissionLauncher.launch(android.Manifest.permission.READ_EXTERNAL_STORAGE)
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

                if (!novelRoot.exists()) {
                    novelRoot.mkdirs()
                }
                // Created alongside Novel/ (not only later, when the Music
                // panel first scans for audio) so the full expected folder
                // structure exists from the first launch, whether or not
                // the user ever opens the Music panel. mkdirs() is a no-op
                // when the folder already exists, so this never touches an
                // existing Audio/ folder or its contents.
                if (!audioRoot.exists()) {
                    audioRoot.mkdirs()
                }

                // Audio/ is where scanAudio()/listAudioFiles() looks for music
                // (and now playlist subfolders — see listAudioFiles()), not a
                // novel — it must never show up in the novel picker. Matched
                // by name case-insensitively rather than by exact File equality
                // so it's still excluded even if listFiles() returns a
                // differently-cased or differently-rooted File instance for
                // the same folder.
                val novelNames = novelRoot.listFiles { f -> f.isDirectory }
                    ?.filter { !it.name.equals(audioRoot.name, ignoreCase = true) }
                    ?.map { it.name }
                    ?.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it })
                    ?: emptyList()

                val namesArray = JSONArray()
                novelNames.forEach { namesArray.put(it) }

                runOnUiThread {
                    hasLoadedOnce = true
                    webView.evaluateJavascript(
                        "window.onNovelsListed && window.onNovelsListed(${JSONObject.quote(namesArray.toString())});",
                        null
                    )
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

                val txtFiles = novelDir.listFiles { f ->
                    f.isFile && f.name.lowercase().endsWith(".txt")
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

                val folderNameEscaped = JSONObject.quote(safeName)
                val filesJson = filesArray.toString()
                val filesJsonEscaped = JSONObject.quote(filesJson)

                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.onFolderPicked($folderNameEscaped, $filesJsonEscaped);",
                        null
                    )
                }
            } catch (e: Exception) {
                runOnUiThread { notifyError("Could not read that novel's folder: ${e.message}") }
            }
        }.start()
    }

    /**
     * Recursively scans audioRoot for files with a recognised extension,
     * reads title/artist/album/duration tags off each with
     * MediaMetadataRetriever, and sends the result to
     * window.onAudioListed() as a JSON array — the contract
     * audio-player.js's MediaLibrary.onScanned() expects: each entry has
     * id, path (a file:// URI), title, artist, album, durationSec, playlist.
     *
     * Runs on a background thread, same reasoning as listNovels()/
     * loadNovelChapters(): MediaMetadataRetriever is slow enough per file
     * (opening and parsing the container) that a few hundred tracks would
     * visibly freeze the UI thread otherwise.
     *
     * Every retriever call is individually try/caught with its own
     * fallback (filename as title, empty artist/album, zero duration) so
     * that one malformed or DRM'd file can't abort the whole scan — this
     * is the "VLC-style robustness" half of the brief: a library scan
     * should degrade gracefully per file, never fail wholesale.
     *
     * PLAYLISTS: subfolders directly under Audio/ become playlists named
     * after the folder, and everything inside them (however deep) belongs
     * to that playlist; files sitting directly in Audio/ itself are
     * reported with no playlist (audio-player.js's MediaLibrary treats
     * that as "not in a playlist" rather than an error). Example:
     *   Audio/
     *     Lo-fi Focus/2AM.mp3       -> playlist "Lo-fi Focus"
     *     Lo-fi Focus/Rain.mp3      -> playlist "Lo-fi Focus"
     *     Podcasts/Ep1/part1.mp3    -> playlist "Podcasts" (nested folders
     *                                  inside a playlist still count as
     *                                  that same playlist — there's only
     *                                  one level of grouping)
     *     standalone-track.mp3      -> no playlist
     */
    private fun listAudioFiles() {
        Thread {
            try {
                if (!hasStoragePermission()) {
                    runOnUiThread {
                        notifyError("Storage permission is needed to read /storage/emulated/0/Novel/Audio.")
                    }
                    return@Thread
                }

                if (!audioRoot.exists()) {
                    audioRoot.mkdirs()
                }

                // Sorted by path-relative-to-Audio/ (not just filename) so
                // tracks in the same playlist folder stay grouped together
                // in the result, rather than interleaving alphabetically
                // with same-named files from other folders.
                val audioFiles = audioRoot.walkTopDown()
                    .filter { it.isFile && audioExtensions.contains(it.extension.lowercase()) }
                    .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) {
                        it.toRelativeString(audioRoot)
                    })
                    .toList()

                val tracksArray = JSONArray()
                for (f in audioFiles) {
                    val obj = JSONObject()
                    obj.put("id", f.absolutePath)
                    obj.put("path", Uri.fromFile(f).toString()) // percent-encodes spaces etc. correctly

                    // The first path segment under Audio/ is the playlist
                    // name; a file with no '/' in its relative path sits
                    // directly in Audio/ and has no playlist.
                    val relativePath = f.toRelativeString(audioRoot).replace(File.separatorChar, '/')
                    val slashIndex = relativePath.indexOf('/')
                    if (slashIndex > 0) {
                        obj.put("playlist", relativePath.substring(0, slashIndex))
                    } else {
                        obj.put("playlist", JSONObject.NULL)
                    }

                    readAudioTags(f, obj)
                    tracksArray.put(obj)
                }

                val tracksJsonEscaped = JSONObject.quote(tracksArray.toString())

                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.onAudioListed && window.onAudioListed($tracksJsonEscaped);",
                        null
                    )
                }
            } catch (e: Exception) {
                runOnUiThread { notifyError("Could not scan /storage/emulated/0/Novel/Audio: ${e.message}") }
            }
        }.start()
    }

    /**
     * Cover art for the track at `path` (a file:// URI), as a JPEG scaled
     * to at most 512px so it is cheap to hand to the notification and the
     * WebView. Looks for embedded art first, then a cover/folder image in
     * the same folder. Results are cached in cacheDir/art so each file is
     * only decoded once. Returns null when there is no art.
     */
    private fun loadArtworkBytes(path: String): ByteArray? {
        return try {
            val file = File(Uri.parse(path).path ?: return null)
            if (!file.exists()) return null
            val dir = File(cacheDir, "art").apply { mkdirs() }
            val key = (file.absolutePath + file.lastModified()).hashCode().toString()
            val cached = File(dir, "$key.jpg")
            val none = File(dir, "$key.none")
            if (cached.exists()) return cached.readBytes()
            if (none.exists()) return null

            var raw: ByteArray? = null
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(file.absolutePath)
                raw = retriever.embeddedPicture
            } catch (e: Exception) {
                // fall through to folder images
            } finally {
                try { retriever.release() } catch (e: Exception) { }
            }
            if (raw == null) {
                val names = listOf("cover", "folder", "front", "album", "albumart", "artwork")
                val exts = listOf("jpg", "jpeg", "png", "webp")
                val siblings = file.parentFile?.listFiles()
                val match = siblings?.firstOrNull { f ->
                    f.isFile && names.contains(f.nameWithoutExtension.lowercase()) &&
                        exts.contains(f.extension.lowercase())
                }
                raw = match?.readBytes()
            }
            if (raw == null) {
                none.createNewFile()
                return null
            }
            val scaled = scaleToJpeg(raw, 512)
            if (scaled == null) {
                none.createNewFile()
                return null
            }
            cached.writeBytes(scaled)
            scaled
        } catch (e: Exception) {
            null
        }
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

    private fun scaleToJpeg(raw: ByteArray, maxSide: Int): ByteArray? {
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

    /**
     * Reads title/artist/album/duration off one file into `obj`, falling
     * back to sensible defaults (filename as title, 0 duration) on any
     * failure. Always releases the retriever, even on exception — a leaked
     * MediaMetadataRetriever is a real native-memory leak, not just a
     * dangling Java object, so this can't be left to the garbage collector.
     */
    private fun readAudioTags(f: File, obj: JSONObject) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(f.absolutePath)
            val title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)
                ?.takeIf { it.isNotBlank() } ?: f.nameWithoutExtension
            val artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST) ?: ""
            val album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM) ?: ""
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull() ?: 0L

            obj.put("title", title)
            obj.put("artist", artist)
            obj.put("album", album)
            obj.put("durationSec", durationMs / 1000.0)
        } catch (e: Exception) {
            // Malformed tags, unsupported codec for tag-reading, etc. —
            // the file may still be playable even though we couldn't read
            // its tags, so it stays in the list with filename-based
            // fallbacks rather than being dropped.
            obj.put("title", f.nameWithoutExtension)
            obj.put("artist", "")
            obj.put("album", "")
            obj.put("durationSec", 0.0)
        } finally {
            try {
                retriever.release()
            } catch (e: Exception) {
                // Nothing more we can do if release() itself fails.
            }
        }
    }

    private fun notifyError(message: String) {
        val msg = JSONObject.quote(message)
        webView.evaluateJavascript("window.onFolderPickError && window.onFolderPickError($msg);", null)
    }
}

package com.scell.novelreader.redesign

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The in-app updater. It finds out that a newer build exists on GitHub, downloads it and installs it
 * over the running app.
 *
 *   check     GET https://api.github.com/repos/<OWNER_REPO>/releases/latest  (public repo, no token)
 *             -> tag_name ("v1.15.00") and the ".apk" asset (url, size, sha256 digest when GitHub gives one)
 *             The workflow publishes that Release for every build signed with the real key.
 *   compare   tag_name against APP_VERSION read from assets/version.js, as numbers (see [isNewer]).
 *   download  asset -> cacheDir/updates/<name>.part -> size and sha256 checked -> <name>.apk
 *   install   a PackageInstaller session; Android shows its own confirm screen (it may skip it on
 *             Android 12+ for later updates: we ask for that, but cannot count on it).
 *
 *   page   -> AndroidBridge.checkForUpdate() / downloadUpdate() / installUpdate() / updateState()
 *             / getAutoUpdate() / setAutoUpdate(on)
 *   native -> window.onUpdateState(json)
 *             json = {"status","step","current","version","percent","message","manual"}
 *             status: checking | uptodate | available | downloading | ready | needpermission |
 *                     installing | failed
 *             step (only for "failed"): check | download | install - the page stays quiet about a
 *             failed *automatic* check (no network at start-up is normal), but not about a failed
 *             download or install.
 *
 * Automatic part (only while [autoEnabled], default on): [checkOnStart] checks at most every 6 hours;
 * a newer build is then downloaded in the background, but only on an unmetered network (the APK is
 * big). The install always waits for a tap.
 *
 * "Install unknown apps" has to be allowed for this app once; without it the status is
 * "needpermission", the system settings page opens, and [onResume] carries on when the user is back.
 *
 * Written without being run on a device: test it there.
 */
class AppUpdater(
    private val activity: ComponentActivity,
    /** Sends the state (JSON) to the page. Always called on the main thread. */
    private val onState: (String) -> Unit,
) {
    companion object {
        const val OWNER_REPO = "Chirag-S-Reddy/Reader-Android"
        private const val LATEST_URL = "https://api.github.com/repos/$OWNER_REPO/releases/latest"
        private const val INSTALL_ACTION = "com.scell.novelreader.redesign.UPDATE_INSTALL_RESULT"
        private const val PREFS = "updater"
        private const val KEY_AUTO = "auto"
        private const val KEY_LAST_CHECK = "lastCheck"
        private const val CHECK_EVERY_MS = 6L * 60 * 60 * 1000
        private const val FILE_PREFIX = "novel-reader-"

        private val VERSION_RE = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)")
        private val APP_VERSION_RE = Regex("APP_VERSION\\s*=\\s*'([^']+)'")

        /** "v1.15.00" -> [1, 15, 0]; null when the text does not start with MAJOR.MID.MINOR. */
        fun parseVersion(text: String?): IntArray? {
            val m = VERSION_RE.find((text ?: "").trim()) ?: return null
            return try {
                intArrayOf(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
            } catch (e: NumberFormatException) {
                null
            }
        }

        /** True when [remote] is a higher version than [local]. Numbers, never text ("v1.9" vs "v1.10"). */
        fun isNewer(remote: String?, local: String?): Boolean {
            val r = parseVersion(remote) ?: return false
            val l = parseVersion(local) ?: return false
            for (i in 0..2) {
                if (r[i] != l[i]) return r[i] > l[i]
            }
            return false
        }

        /** The version out of assets/version.js ("window.APP_VERSION = 'v1.15.00';"), or "". */
        fun versionFromScript(script: String): String =
            APP_VERSION_RE.find(script)?.groupValues?.get(1) ?: ""
    }

    private val main = Handler(Looper.getMainLooper())
    // Lazy: this class is built while MainActivity's properties are initialised, before the activity
    // has a Context. Nothing may touch the activity until start() (called from onCreate).
    private val prefs by lazy { activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private val updatesDir by lazy { File(activity.cacheDir, "updates") }

    // What the last check found (null = nothing newer known).
    @Volatile private var newVersion: String? = null
    @Volatile private var apkUrl: String? = null
    @Volatile private var apkName: String? = null
    @Volatile private var apkSize: Long = 0L
    @Volatile private var apkSha256: String? = null

    @Volatile private var working = false
    @Volatile private var pendingInstall = false
    @Volatile private var lastJson = ""
    private val installedVersion: String by lazy { readInstalledVersion() }

    private val resultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val code = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            val text = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
            when (code) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    val confirm = readConfirmIntent(intent)
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        try {
                            activity.startActivity(confirm)
                        } catch (e: Exception) {
                            working = false
                            fail("install", "Android's install screen could not be opened.")
                        }
                    } else {
                        working = false
                        fail("install", "Android did not give an install screen.")
                    }
                }
                PackageInstaller.STATUS_SUCCESS -> {
                    // Normally the app is replaced and restarted before this is seen.
                    working = false
                    setState("uptodate")
                }
                PackageInstaller.STATUS_FAILURE_ABORTED -> {
                    working = false
                    // The file is still there: the user can tap Install again.
                    setState("ready", message = "Install cancelled.")
                }
                else -> {
                    working = false
                    fail("install", if (text.isNotEmpty()) "Install failed: $text" else "Install failed.")
                }
            }
        }
    }

    /** Call once from onCreate: listens for the installer's answer and tidies old downloads. */
    fun start() {
        ContextCompat.registerReceiver(
            activity, resultReceiver, IntentFilter(INSTALL_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED
        )
        // Old downloads are deleted once the installed version has caught up with them.
        Thread { cleanOldFiles() }.start()
    }

    /** True while a check, a download or an install is going on; the app does not close itself then. */
    fun isBusy(): Boolean = working

    fun stateJson(): String = lastJson

    fun autoEnabled(): Boolean = prefs.getBoolean(KEY_AUTO, true)

    fun setAutoEnabled(on: Boolean) {
        prefs.edit().putBoolean(KEY_AUTO, on).apply()
    }

    /** Start-up check: only when automatic updates are on and the last check is old enough. */
    fun checkOnStart() {
        if (!autoEnabled()) return
        val last = prefs.getLong(KEY_LAST_CHECK, 0L)
        if (System.currentTimeMillis() - last < CHECK_EVERY_MS) return
        check(manual = false)
    }

    /** Called from onResume: carries on with an install that was waiting for the settings page. */
    fun onResume() {
        if (pendingInstall && canInstall()) {
            pendingInstall = false
            install()
        }
    }

    fun release() {
        try { activity.unregisterReceiver(resultReceiver) } catch (e: Exception) { /* not registered */ }
    }

    fun check(manual: Boolean) {
        if (working) {
            // Something is already going on: just say where it stands.
            if (lastJson.isNotEmpty()) main.post { onState(lastJson) }
            return
        }
        working = true
        setState("checking", manual = manual)
        Thread {
            var downloadNext = false
            try {
                val conn = open(LATEST_URL)
                conn.setRequestProperty("Accept", "application/vnd.github+json")
                val code = conn.responseCode
                if (code == 404) {
                    // No Release published yet: nothing to update to.
                    forgetRelease()
                    prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
                    setState("uptodate", manual = manual)
                    return@Thread
                }
                if (code == 403 || code == 429) {
                    fail("check", "GitHub is limiting requests right now. Try again later.", manual)
                    return@Thread
                }
                if (code != 200) {
                    fail("check", "GitHub answered $code.", manual)
                    return@Thread
                }
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                conn.disconnect()
                prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()

                val release = JSONObject(body)
                val tag = release.optString("tag_name", "")
                if (!isNewer(tag, installedVersion)) {
                    forgetRelease()
                    setState("uptodate", manual = manual)
                    return@Thread
                }
                // The first .apk attached to the Release.
                val assets = release.optJSONArray("assets")
                var found: JSONObject? = null
                if (assets != null) {
                    for (i in 0 until assets.length()) {
                        val a = assets.optJSONObject(i) ?: continue
                        if (a.optString("name", "").endsWith(".apk", ignoreCase = true)) {
                            found = a
                            break
                        }
                    }
                }
                if (found == null) {
                    // A Release without an APK (still uploading, or made by hand): not an update yet.
                    forgetRelease()
                    setState("uptodate", manual = manual)
                    return@Thread
                }
                newVersion = tag
                apkUrl = found.optString("browser_download_url", "")
                apkName = FILE_PREFIX + tag + ".apk"
                apkSize = found.optLong("size", 0L)
                val digest = found.optString("digest", "")
                apkSha256 = if (digest.startsWith("sha256:")) digest.substring(7).lowercase() else null

                if (readyFile() != null) {
                    setState("ready", manual = manual)
                } else {
                    setState("available", manual = manual)
                    downloadNext = autoEnabled() && !isMetered()
                }
            } catch (e: Exception) {
                fail("check", "Could not reach GitHub.", manual)
            } finally {
                working = false
            }
            if (downloadNext) download()
        }.start()
    }

    fun download() {
        val url = apkUrl
        val name = apkName
        if (working || url == null || url.isEmpty() || name == null) return
        working = true
        setState("downloading", percent = 0)
        val part = File(updatesDir, "$name.part")
        Thread {
            try {
                updatesDir.mkdirs()
                updatesDir.listFiles()?.forEach { if (it.name.endsWith(".part")) it.delete() }
                val conn = open(url)
                conn.readTimeout = 30000
                if (conn.responseCode != 200) {
                    fail("download", "The download failed (${conn.responseCode}).")
                    return@Thread
                }
                val total = if (apkSize > 0) apkSize else conn.contentLengthLong
                val digest = MessageDigest.getInstance("SHA-256")
                var written = 0L
                var shown = -1
                conn.inputStream.use { input ->
                    part.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            digest.update(buf, 0, n)
                            written += n
                            if (total > 0) {
                                val pct = (written * 100 / total).toInt().coerceIn(0, 100)
                                if (pct != shown) {
                                    shown = pct
                                    setState("downloading", percent = pct)
                                }
                            }
                        }
                    }
                }
                conn.disconnect()
                if (apkSize > 0 && written != apkSize) {
                    part.delete()
                    fail("download", "The download was cut short. Try again.")
                    return@Thread
                }
                val expected = apkSha256
                if (expected != null) {
                    val got = digest.digest().joinToString("") { "%02x".format(it) }
                    if (got != expected) {
                        part.delete()
                        fail("download", "The downloaded file did not match GitHub's checksum.")
                        return@Thread
                    }
                }
                val done = File(updatesDir, name)
                done.delete()
                if (!part.renameTo(done)) {
                    fail("download", "The downloaded file could not be saved.")
                    return@Thread
                }
                setState("ready")
            } catch (e: Exception) {
                part.delete()
                fail("download", "The download failed. Check the connection and try again.")
            } finally {
                working = false
            }
        }.start()
    }

    fun install() {
        if (working) return
        val file = readyFile()
        if (file == null) {
            fail("install", "The update file is missing. Download it again.")
            return
        }
        if (!canInstall()) {
            pendingInstall = true
            setState("needpermission", message = "Allow installing apps from Novel Reader, then come back.")
            try {
                val intent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.packageName)
                )
                activity.startActivity(intent)
            } catch (e: Exception) {
                pendingInstall = false
                fail("install", "Open Settings > Apps > Novel Reader and allow installing unknown apps.")
            }
            return
        }
        working = true
        setState("installing")
        Thread {
            try {
                val installer = activity.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(activity.packageName)
                params.setSize(file.length())
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                val id = installer.createSession(params)
                val session = installer.openSession(id)
                try {
                    FileInputStream(file).use { input ->
                        session.openWrite("novel-reader.apk", 0, file.length()).use { out ->
                            input.copyTo(out)
                            session.fsync(out)
                        }
                    }
                    // Explicit (package set) and mutable: the installer fills in the result.
                    val intent = Intent(INSTALL_ACTION).setPackage(activity.packageName)
                    var flags = PendingIntent.FLAG_UPDATE_CURRENT
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
                    val pending = PendingIntent.getBroadcast(activity, id, intent, flags)
                    session.commit(pending.intentSender)
                } finally {
                    session.close()
                }
                // From here the answer arrives in resultReceiver; working stays true until then.
            } catch (e: Exception) {
                working = false
                fail("install", "The install could not be started.")
            }
        }.start()
    }

    // ---- helpers -------------------------------------------------------------------------

    private fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    private fun isMetered(): Boolean = try {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        cm.isActiveNetworkMetered
    } catch (e: Exception) {
        true
    }

    private fun open(url: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 20000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "NovelReader-Updater")
        return conn
    }

    @Suppress("DEPRECATION")
    private fun readConfirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }

    private fun readInstalledVersion(): String = try {
        versionFromScript(activity.assets.open("version.js").bufferedReader().use { it.readText() })
    } catch (e: Exception) {
        ""
    }

    private fun forgetRelease() {
        newVersion = null
        apkUrl = null
        apkName = null
        apkSize = 0L
        apkSha256 = null
    }

    /** The downloaded APK of the newer version, when it is complete. */
    private fun readyFile(): File? {
        val name = apkName ?: return null
        val f = File(updatesDir, name)
        if (!f.isFile) return null
        if (apkSize > 0 && f.length() != apkSize) return null
        return f
    }

    private fun cleanOldFiles() {
        try {
            updatesDir.listFiles()?.forEach { f ->
                val version = f.name.removePrefix(FILE_PREFIX).removeSuffix(".apk")
                if (!f.name.endsWith(".apk") || !isNewer(version, installedVersion)) f.delete()
            }
        } catch (e: Exception) { /* a leftover file is harmless */ }
    }

    private fun fail(step: String, message: String, manual: Boolean = true) {
        setState("failed", message = message, step = step, manual = manual)
    }

    private fun setState(
        status: String,
        message: String = "",
        percent: Int = 0,
        step: String = "",
        manual: Boolean = true,
    ) {
        val json = JSONObject()
            .put("status", status)
            .put("step", step)
            .put("current", installedVersion)
            .put("version", newVersion ?: "")
            .put("percent", percent)
            .put("message", message)
            .put("manual", manual)
            .toString()
        lastJson = json
        main.post { onState(json) }
    }
}

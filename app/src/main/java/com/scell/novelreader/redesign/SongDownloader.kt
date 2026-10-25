package com.scell.novelreader.redesign

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * The native half of the "Download songs" sheet (song-download.js).
 *
 * The page hands over one job at a time. A job is either
 *   - a name look-up: the link only; the answer is the song's name (message of a "done"), or
 *   - a download: a link, an optional playlist (folder) and an optional song name to save it under.
 * Each is run in Termux with song_dl.py (yt-dlp), through Termux's RUN_COMMAND service:
 *
 *   page   -> AndroidBridge.lookupSongTitle(jobId, url)               -> [start], titleOnly
 *             AndroidBridge.downloadSong(jobId, url, folder, name)    -> [start]
 *             AndroidBridge.cancelSongDownload()                       -> [cancel]
 *   native -> window.onSongDownloadStatus(jobId, "done"|"failed", message)   (via [onStatus])
 *
 * Exactly one done/failed is reported per accepted job.
 *
 * How the script gets to Termux: song_dl.py ships in this app's assets and is handed to
 * `python -c` as an argument, so there is no copy in shared storage that another app could
 * swap out, and nothing to install by hand. Link and playlist go in as separate arguments
 * (never a shell string; RUN_COMMAND starts the program directly).
 *
 * Needs, on the phone: Termux from F-Droid or GitHub (the Play Store build is too old),
 * `pkg install python ffmpeg`, `pip install yt-dlp`, `termux-setup-storage`,
 * `allow-external-apps=true` in ~/.termux/termux.properties, and the "Run commands in
 * Termux environment" permission for this app (asked for the first time a job starts).
 *
 * Written without being compiled or run: test it on a device.
 */
class SongDownloader(
    private val activity: ComponentActivity,
    /** Reports a result to the page. Always called on the main thread. */
    private val onStatus: (jobId: String, status: String, message: String) -> Unit,
    /** Shows the system dialog for [PERMISSION]. */
    private val askPermission: () -> Unit,
) {

    companion object {
        const val PERMISSION = "com.termux.permission.RUN_COMMAND"
        const val SCRIPT_ASSET = "song_dl.py"

        private const val TERMUX_PACKAGE = "com.termux"
        private const val TERMUX_SERVICE = "com.termux.app.RunCommandService"
        private const val TERMUX_HOME = "/data/data/com.termux/files/home"
        private const val TERMUX_BIN = "/data/data/com.termux/files/usr/bin"
        private const val TERMUX_TMP = "/data/data/com.termux/files/usr/tmp"

        private const val ACTION_RUN = "com.termux.RUN_COMMAND"
        private const val ACTION_RESULT = "com.scell.novelreader.redesign.SONG_DL_RESULT"
        private const val EXTRA_JOB = "songJobId"

        /** A song is a few seconds to a few minutes; this only catches "Termux never answered". */
        private const val ANSWER_TIMEOUT_MS = 15 * 60 * 1000L

        private val badFolderChars = Regex("[^A-Za-z0-9 _\\-().&',]")
        private val spaces = Regex("\\s+")
        private val webLink = Regex("^https?://\\S+$", RegexOption.IGNORE_CASE)

        /** Same rule as cleanFolderName in song-download.js and clean_folder in song_dl.py. */
        fun cleanFolder(name: String?): String =
            (name ?: "")
                .replace(badFolderChars, "")
                .replace(spaces, " ")
                .trim()
                .trim('.')
                .trim()
                .take(60)

        fun isWebLink(url: String?): Boolean = url != null && webLink.matches(url)

        private val controlChars = Regex("[\\u0000-\\u001f\\u007f]")
        private val badNameChars = Regex("[\\\\/:*?\"<>|]")

        /** Same rule as cleanSongName in song-download.js and clean_song_name in song_dl.py. */
        fun cleanSongName(name: String?): String {
            val tidy = (name ?: "")
                .replace(controlChars, " ")
                .replace(badNameChars, "")
                .replace(spaces, " ")
                .trim()
                .trim('.')
                .trim()
            // At most 120 characters, counted as whole characters (never cutting an emoji in half).
            val cut = if (tidy.codePointCount(0, tidy.length) > 120) tidy.offsetByCodePoints(0, 120) else tidy.length
            return tidy.substring(0, cut)
        }

        /**
         * song_dl.py prints `RESULT {"status": ..., "message": ...}` as its last line.
         * Returns (status, message) with status "done" or "failed", or null if there is no such line.
         */
        fun parseResult(stdout: String?): Pair<String, String>? {
            val line = (stdout ?: "").lines().map { it.trim() }.lastOrNull { it.startsWith("RESULT ") }
                ?: return null
            return try {
                val json = JSONObject(line.removePrefix("RESULT "))
                val status = if (json.optString("status") == "done") "done" else "failed"
                status to json.optString("message")
            } catch (e: Exception) {
                null
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var current: String? = null   // the job Termux is working on
    private var requestSeq = 0

    private val timeout = Runnable {
        val id = synchronized(lock) { current } ?: return@Runnable
        sendStop()
        finish(id, "failed",
            "Termux did not answer. Check that allow-external-apps=true is set in ~/.termux/termux.properties.")
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val id = intent?.getStringExtra(EXTRA_JOB) ?: return
            val bundle: Bundle? = intent.getBundleExtra("result")
            val parsed = parseResult(bundle?.getString("stdout"))
            val errMsg = bundle?.getString("errmsg").orEmpty().trim()
            val lastError = bundle?.getString("stderr").orEmpty().lines()
                .map { it.trim() }.lastOrNull { it.isNotEmpty() }.orEmpty()
            when {
                parsed != null -> finish(id, parsed.first, parsed.second)
                errMsg.isNotEmpty() -> finish(id, "failed", errMsg)
                else -> {
                    val exit = bundle?.getInt("exitCode", -1) ?: -1
                    finish(id, "failed", lastError.ifEmpty { "The download ended unexpectedly (exit $exit)." })
                }
            }
        }
    }

    fun register() {
        val filter = IntentFilter(ACTION_RESULT)
        try {
            ContextCompat.registerReceiver(activity, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        } catch (e: Exception) {
            // Without it no result ever comes back; the time-out then ends the job.
        }
    }

    fun release() {
        main.removeCallbacks(timeout)
        try { activity.unregisterReceiver(receiver) } catch (e: Exception) { /* not registered */ }
    }

    /** True while a job is out with Termux (the app must not close itself meanwhile). */
    fun isBusy(): Boolean = synchronized(lock) { current != null }

    /**
     * Accepts one job. Returns false only when another job is still running; every other
     * problem is reported to the page as a "failed" result with a message the user can act on.
     * May be called from the WebView's bridge thread.
     */
    fun start(jobId: String, url: String, folder: String, name: String = "", titleOnly: Boolean = false): Boolean {
        synchronized(lock) {
            if (current != null) return false
            current = jobId
        }
        val cleanedFolder = cleanFolder(folder)
        val cleanedName = cleanSongName(name)
        main.post {
            when {
                !isWebLink(url) -> finish(jobId, "failed", "That doesn't look like a web link.")
                folder.isNotBlank() && cleanedFolder.isEmpty() ->
                    finish(jobId, "failed", "That playlist name has no usable letters or numbers.")
                else -> launch(jobId, url.trim(), cleanedFolder, cleanedName, titleOnly)
            }
        }
        return true
    }

    /** Asks the running script to stop; it then reports "Stopped" by itself. */
    fun cancel() {
        main.post { sendStop() }
    }

    // ---- main thread from here on ----------------------------------------------------

    private fun launch(jobId: String, url: String, folder: String, name: String, titleOnly: Boolean) {
        if (activity.packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE) == null) {
            finish(jobId, "failed", "Termux isn't installed on this device.")
            return
        }
        if (ContextCompat.checkSelfPermission(activity, PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            askPermission()
            finish(jobId, "failed",
                "Allow \"Run commands in Termux environment\" for this app, then tap Retry. " +
                    "(Needs Termux from F-Droid or GitHub.)")
            return
        }
        val script = try {
            activity.assets.open(SCRIPT_ASSET).bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            finish(jobId, "failed", "The download script is missing from the app.")
            return
        }

        // python -c SCRIPT [--title | --name NAME] URL [FOLDER]: the script sees
        // sys.argv = ["-c", ...options, URL, FOLDER]. Options always come before the link.
        val args = ArrayList<String>()
        args.add("-c")
        args.add(script)
        if (titleOnly) {
            args.add("--title")
        } else if (name.isNotEmpty()) {
            args.add("--name")
            args.add(name)
        }
        args.add(url)
        if (!titleOnly && folder.isNotEmpty()) args.add(folder)

        val reply = Intent(ACTION_RESULT).setPackage(activity.packageName).putExtra(EXTRA_JOB, jobId)
        // Termux adds its result to this intent, so the PendingIntent has to be mutable.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val pending = PendingIntent.getBroadcast(activity, ++requestSeq, reply, flags)

        val run = Intent(ACTION_RUN).apply {
            setClassName(TERMUX_PACKAGE, TERMUX_SERVICE)
            putExtra("com.termux.RUN_COMMAND_PATH", "$TERMUX_BIN/python")
            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", args.toTypedArray())
            putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME)
            putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pending)
        }
        try {
            activity.startService(run)
            main.removeCallbacks(timeout)
            main.postDelayed(timeout, ANSWER_TIMEOUT_MS)
        } catch (e: SecurityException) {
            askPermission()
            finish(jobId, "failed", "Termux refused the request. Allow \"Run commands in Termux environment\" " +
                "for this app, then tap Retry.")
        } catch (e: Exception) {
            // Android 12+ also refuses to start another app's service while this app is in the background.
            finish(jobId, "failed", "Could not reach Termux. Keep Novel Reader open while it downloads.")
        }
    }

    /** Sends SIGTERM to the running song_dl.py, found through the pid file it keeps. */
    private fun sendStop() {
        try {
            val stop = Intent(ACTION_RUN).apply {
                setClassName(TERMUX_PACKAGE, TERMUX_SERVICE)
                putExtra("com.termux.RUN_COMMAND_PATH", "$TERMUX_BIN/sh")
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf(
                    "-c",
                    "f=\"\${TMPDIR:-$TERMUX_TMP}/song_dl.pid\"; [ -f \"\$f\" ] && kill -TERM \"\$(cat \"\$f\")\"; true"
                ))
                putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME)
                putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            }
            activity.startService(stop)
        } catch (e: Exception) {
            // The job still ends by itself (or through the time-out).
        }
    }

    private fun finish(jobId: String, status: String, message: String) {
        val mine = synchronized(lock) {
            if (current == jobId) { current = null; true } else false
        }
        if (!mine) return                    // a late or repeated answer changes nothing
        main.removeCallbacks(timeout)
        onStatus(jobId, status, message)
    }
}

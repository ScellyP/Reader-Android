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
 * The native half of the "Download songs" wizard (song-download.js).
 *
 * The page runs two kinds of job, and may have one of each at the same time (the next song
 * downloads while the current one is being named and placed):
 *   - stage: download one link into the staging folder, Audio/.staging/<run>/ (the music scan skips
 *            folders that start with a dot, so nothing shows up in the library yet). The answer's
 *            message is the downloaded file's full path.
 *   - place: give a staged song its final name (file name and title tag) and move it into its
 *            playlist folder, or Audio/ itself. The answer's message is the song's new full path.
 * Both are run in Termux with song_dl.py (yt-dlp, ffmpeg), through Termux's RUN_COMMAND service:
 *
 *   page   -> AndroidBridge.stageSong(jobId, url)                       -> [stage]
 *             AndroidBridge.placeSong(jobId, path, name, folder)         -> [place]
 *             AndroidBridge.cancelSongDownload()                          -> [cancel]  (stops every job)
 *   native -> window.onSongDownloadStatus(jobId, "done"|"failed", message)   (via [onStatus])
 *
 * Exactly one done/failed is reported per accepted job.
 *
 * How the script gets to Termux: song_dl.py ships in this app's assets and is handed to
 * `python -c` as an argument, so there is no copy in shared storage that another app could
 * swap out, and nothing to install by hand. Link, path, name and playlist go in as separate
 * arguments (never a shell string; RUN_COMMAND starts the program directly).
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

        /** Where downloads wait until they are named and placed. Must match STAGING_ROOT in song_dl.py. */
        const val STAGING_DIR = "/storage/emulated/0/Novel/Audio/.staging"

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

        /** Is [path] a file inside the staging folder? (Nothing else may be moved or renamed.) */
        fun isStagedPath(path: String?): Boolean {
            if (path.isNullOrBlank()) return false
            return try {
                val file = java.io.File(path).canonicalFile
                val root = java.io.File(STAGING_DIR).canonicalFile
                file.path.startsWith(root.path + java.io.File.separator) && file.isFile
            } catch (e: Exception) {
                false
            }
        }

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
    private val running = HashSet<String>()                 // jobs Termux is working on
    private val timeouts = HashMap<String, Runnable>()      // one watchdog per job (main thread only)
    private var requestSeq = 0

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
        timeouts.values.forEach { main.removeCallbacks(it) }
        timeouts.clear()
        try { activity.unregisterReceiver(receiver) } catch (e: Exception) { /* not registered */ }
    }

    /** True while a job is out with Termux (the app must not close itself meanwhile). */
    fun isBusy(): Boolean = synchronized(lock) { running.isNotEmpty() }

    /**
     * Accepts a download job. Returns false only when a job with this id is already running; every
     * other problem is reported to the page as a "failed" result with a message the user can act on.
     * May be called from the WebView's bridge thread.
     */
    fun stage(jobId: String, url: String): Boolean {
        if (!begin(jobId)) return false
        main.post {
            if (!isWebLink(url)) finish(jobId, "failed", "That doesn't look like a web link.")
            else launch(jobId, listOf("--stage", url.trim()))
        }
        return true
    }

    /** Accepts a placement job: [path] is the staged file, [name] its final name ("" = keep it). */
    fun place(jobId: String, path: String, name: String, folder: String): Boolean {
        if (!begin(jobId)) return false
        val cleanedFolder = cleanFolder(folder)
        val cleanedName = cleanSongName(name)
        main.post {
            when {
                !isStagedPath(path) -> finish(jobId, "failed", "That song is no longer there. Download it again.")
                folder.isNotBlank() && cleanedFolder.isEmpty() ->
                    finish(jobId, "failed", "That playlist name has no usable letters or numbers.")
                else -> {
                    val args = ArrayList<String>()
                    args.add("--place")
                    args.add(path)
                    if (cleanedName.isNotEmpty()) { args.add("--name"); args.add(cleanedName) }
                    if (cleanedFolder.isNotEmpty()) args.add(cleanedFolder)
                    launch(jobId, args)
                }
            }
        }
        return true
    }

    /** Asks every running song_dl.py to stop; each then reports "Stopped" by itself. */
    fun cancel() {
        main.post { sendStop() }
    }

    private fun begin(jobId: String): Boolean = synchronized(lock) { running.add(jobId) }

    // ---- main thread from here on ----------------------------------------------------

    private fun launch(jobId: String, scriptArgs: List<String>) {
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

        // python -c SCRIPT [options] ...: the script sees sys.argv = ["-c", ...scriptArgs].
        val args = ArrayList<String>()
        args.add("-c")
        args.add(script)
        args.addAll(scriptArgs)

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
            val watchdog = Runnable {
                sendStop()
                finish(jobId, "failed",
                    "Termux did not answer. Check that allow-external-apps=true is set in ~/.termux/termux.properties.")
            }
            timeouts[jobId] = watchdog
            main.postDelayed(watchdog, ANSWER_TIMEOUT_MS)
        } catch (e: SecurityException) {
            askPermission()
            finish(jobId, "failed", "Termux refused the request. Allow \"Run commands in Termux environment\" " +
                "for this app, then tap Retry.")
        } catch (e: Exception) {
            // Android 12+ also refuses to start another app's service while this app is in the background.
            finish(jobId, "failed", "Could not reach Termux. Keep Novel Reader open while it downloads.")
        }
    }

    /** Sends SIGTERM to every running song_dl.py, found through the pid file each one keeps. */
    private fun sendStop() {
        try {
            val stop = Intent(ACTION_RUN).apply {
                setClassName(TERMUX_PACKAGE, TERMUX_SERVICE)
                putExtra("com.termux.RUN_COMMAND_PATH", "$TERMUX_BIN/sh")
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf(
                    "-c",
                    "d=\"\${TMPDIR:-$TERMUX_TMP}\"; for f in \"\$d\"/song_dl.*.pid; do " +
                        "[ -f \"\$f\" ] && kill -TERM \"\$(cat \"\$f\")\" 2>/dev/null; done; true"
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
        val mine = synchronized(lock) { running.remove(jobId) }
        if (!mine) return                    // a late or repeated answer changes nothing
        timeouts.remove(jobId)?.let { main.removeCallbacks(it) }
        onStatus(jobId, status, message)
    }
}

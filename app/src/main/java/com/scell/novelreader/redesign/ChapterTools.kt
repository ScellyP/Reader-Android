package com.scell.novelreader.redesign

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * The two chapter scripts, run in Termux without opening it:
 *
 *   - fetch:  chapter_downloader.py --resume -o <novel folder> -n 100000
 *             Opens the page the newest saved chapter came from (its "Source:" line), only to find
 *             the "next chapter" link, and downloads everything after it, up to the latest.
 *   - delete: delete_chapters.py <novel folder> <N> --yes
 *             Deletes the chapter files 1 to N of the novel.
 *
 * Both scripts live in assets/scripts/. They are copied into the Novel folder itself (when the app
 * starts and again before each run; a changed copy is replaced) so that Termux can read them, then
 * sends Termux a RUN_COMMAND intent (background, no terminal window) and waits for its answer.
 *
 *   page   -> AndroidBridge.fetchNewChapters(novel) / deleteChapters(novel, upTo) / chapterJobState()
 *   native -> window.onChapterJob(json)
 *             json = {"id","kind":"fetch"|"delete","status":"waiting"|"running"|"done"|"failed",
 *                     "novel","count","message","latest"}
 *             "count" is how many chapter files appeared (fetch) or disappeared (delete) so far.
 *             A job ends with exactly one "done" or "failed".
 *
 * One job at a time. Progress is the number of chapter files in the novel's folder, looked at every
 * few seconds while the job runs (Termux only answers when the script has finished). If neither a
 * new file nor an answer shows up for too long, the job is reported as failed.
 *
 * What Termux needs, once: the app installed from F-Droid or GitHub, `allow-external-apps = true` in
 * ~/.termux/termux.properties, `pip install requests beautifulsoup4`, and `termux-setup-storage`.
 * This app asks for the "run commands in Termux" permission the first time.
 *
 * Written without being run on a device: test it there.
 */
class ChapterTools(
    private val activity: ComponentActivity,
    private val novelRoot: File,
    /** Name of the music folder inside [novelRoot]; it is not a novel. */
    private val reservedFolder: String,
    /** Asks for Termux's RUN_COMMAND permission; the answer must be passed to [onPermissionResult]. */
    private val requestRunCommandPermission: () -> Unit,
    /** Sends a job's state (JSON) to the page. Always called on the main thread. */
    private val onState: (String) -> Unit,
) {

    companion object {
        const val TERMUX_PACKAGE = "com.termux"
        const val RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND"
        const val TERMUX_PYTHON = "/data/data/com.termux/files/usr/bin/python"
        const val TERMUX_HOME = "/data/data/com.termux/files/home"

        const val DOWNLOADER = "chapter_downloader.py"
        const val DELETER = "delete_chapters.py"

        /** The "answer" Termux sends back to this app when a command is finished. */
        const val RESULT_ACTION = "com.scell.novelreader.redesign.CHAPTER_JOB_RESULT"
        private const val EXTRA_JOB = "job"

        /** "Up to the latest": the downloader's --max, high enough never to be reached. */
        const val MAX_CHAPTERS = 100_000

        const val POLL_MS = 3_000L
        const val FETCH_STALL_MS = 10 * 60 * 1000L
        const val DELETE_STALL_MS = 2 * 60 * 1000L

        const val SETUP_HINT = "In Termux run:  mkdir -p ~/.termux && echo \"allow-external-apps = true\" >> ~/.termux/termux.properties  " +
            "then close Termux completely and open it once more."

        /** The novel folder name the page sent, cleaned; null when it can't be a novel. */
        fun cleanNovelName(name: String?, reservedFolder: String): String? {
            if (name == null) return null
            val n = File(name).name.trim() // strips any path parts
            if (n.isEmpty() || n.startsWith(".")) return null // also "." and ".."
            if (n.equals(reservedFolder, ignoreCase = true)) return null
            return n
        }

        /** Is this file a chapter? (next_chapter.txt is only the downloader's bookmark.) */
        fun isChapterFile(name: String): Boolean {
            val low = name.lowercase()
            return low.endsWith(".txt") && low != "next_chapter.txt"
        }

        fun countChapters(dir: File): Int =
            dir.listFiles { f -> f.isFile && isChapterFile(f.name) }?.size ?: 0

        /** The name (without ".txt") of the chapter file saved most recently, or "" when there is none. */
        fun latestChapterName(dir: File): String {
            val files = dir.listFiles { f -> f.isFile && isChapterFile(f.name) } ?: return ""
            var newest: File? = null
            for (f in files) {
                if (newest == null || f.lastModified() > newest.lastModified()) newest = f
            }
            return newest?.name?.removeSuffix(".txt") ?: ""
        }

        /** The last few lines of a script's output, short enough for a message box. */
        fun tail(text: String?, maxLines: Int = 4, maxChars: Int = 320): String {
            val lines = (text ?: "").lines().map { it.trim() }.filter { it.isNotEmpty() }
            val joined = lines.takeLast(maxLines).joinToString("\n")
            return if (joined.length <= maxChars) joined else "…" + joined.takeLast(maxChars)
        }

        /** The script's last "[!] ..." line (its way of saying what went wrong), or null. */
        fun problem(text: String?): String? =
            (text ?: "").lines().map { it.trim() }.lastOrNull { it.startsWith("[!]") }
                ?.removePrefix("[!]")?.trim()?.takeIf { it.isNotEmpty() }

        /** What went wrong, for a message box: the script's own "[!]" line, else the end of its output. */
        fun whatWentWrong(stdout: String?, stderr: String?): String =
            problem(stdout) ?: tail((stdout ?: "") + "\n" + (stderr ?: ""))

        fun chaptersText(n: Int): String = if (n == 1) "1 chapter" else "$n chapters"
    }

    private class Job(
        val id: String,
        val kind: String,
        val novel: String,
        val dir: File,
        val upTo: Int,
    ) {
        var before = 0
        var lastCount = 0
        var lastChangeAt = SystemClock.elapsedRealtime()
        val stallMs get() = if (kind == "fetch") FETCH_STALL_MS else DELETE_STALL_MS
    }

    private val handler = Handler(Looper.getMainLooper())
    /** The scripts sit in the Novel folder itself, next to the novels (it only lists folders, so they never show up as novels). */
    private val scriptsDir get() = novelRoot

    // Touched on the main thread only, except [active] and [lastStateJson].
    private var job: Job? = null
    private var waitingForPermission: Job? = null
    private var receiverRegistered = false
    private var requestCounter = 0

    /** A job has been accepted and has not ended yet. */
    @Volatile private var active = false
    @Volatile private var lastStateJson = ""

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            onResult(intent)
        }
    }

    private val poll = object : Runnable {
        override fun run() {
            val j = job ?: return
            val now = countChapters(j.dir)
            if (now != j.lastCount) {
                j.lastCount = now
                j.lastChangeAt = SystemClock.elapsedRealtime()
                publish(j, "running", changed(j, now), "")
            }
            if (SystemClock.elapsedRealtime() - j.lastChangeAt > j.stallMs) {
                end(j, "failed", changed(j, now), "Termux didn't answer. $SETUP_HINT")
                return
            }
            handler.postDelayed(this, POLL_MS)
        }
    }

    // ---- What the page calls ----------------------------------------------------------------

    /** Is a job accepted and not yet finished? (The app doesn't close itself meanwhile.) */
    fun isBusy(): Boolean = active

    /** The latest state sent to the page ("" if no job ran yet), for when the page asks again. */
    fun stateJson(): String = lastStateJson

    /** Download everything after the newest saved chapter of [novelName]. False: not started. */
    fun fetchNewChapters(novelName: String?): Boolean = start("fetch", novelName, 0)

    /** Delete chapter files 1 to [upTo] of [novelName]. False: not started. */
    fun deleteChapters(novelName: String?, upTo: Int): Boolean {
        if (upTo < 1 || upTo > MAX_CHAPTERS) return false
        return start("delete", novelName, upTo)
    }

    /** The answer to [requestRunCommandPermission]. */
    fun onPermissionResult(granted: Boolean) {
        val j = waitingForPermission ?: return
        waitingForPermission = null
        if (granted) {
            launch(j)
        } else {
            end(
                j, "failed", 0,
                "Novel Reader needs the permission to run commands in Termux. Allow it when asked, or turn it on in " +
                    "Android Settings → Apps → Novel Reader → Permissions → Additional permissions."
            )
        }
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        if (receiverRegistered) {
            try { activity.unregisterReceiver(receiver) } catch (e: Exception) { /* not registered */ }
            receiverRegistered = false
        }
    }

    // ---- Starting ---------------------------------------------------------------------------

    private fun start(kind: String, novelName: String?, upTo: Int): Boolean {
        val novel = cleanNovelName(novelName, reservedFolder) ?: return false
        val dir = File(novelRoot, novel)
        if (!dir.isDirectory) return false
        synchronized(this) {
            if (active) return false
            active = true
        }
        val j = Job(UUID.randomUUID().toString(), kind, novel, dir, upTo)
        handler.post { begin(j) }
        return true
    }

    private fun begin(j: Job) {
        if (activity.packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE) == null) {
            end(j, "failed", 0, "Termux isn't installed on this device. Install it from F-Droid or GitHub.")
            return
        }
        if (ContextCompat.checkSelfPermission(activity, RUN_COMMAND_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            waitingForPermission = j
            publish(j, "waiting", 0, "Allow Novel Reader to run commands in Termux…")
            requestRunCommandPermission()
            return
        }
        launch(j)
    }

    private fun launch(j: Job) {
        try {
            deployScripts()
        } catch (e: Exception) {
            end(j, "failed", 0, "Couldn't put the scripts in ${scriptsDir.path}: ${e.message}")
            return
        }

        j.before = countChapters(j.dir)
        j.lastCount = j.before
        j.lastChangeAt = SystemClock.elapsedRealtime()

        val scriptArgs: Array<String> = if (j.kind == "fetch") {
            arrayOf(
                File(scriptsDir, DOWNLOADER).path,
                "--resume", "-o", j.dir.path, "-n", MAX_CHAPTERS.toString(),
            )
        } else {
            // Each value is its own argument: nothing is ever put together into a shell string.
            arrayOf(File(scriptsDir, DELETER).path, j.dir.path, j.upTo.toString(), "--yes")
        }

        registerReceiver()
        val answer = Intent(RESULT_ACTION)
            .setPackage(activity.packageName) // an explicit intent: Android 14 refuses mutable implicit ones
            .putExtra(EXTRA_JOB, j.id)
        // Termux adds its result to this intent, so the PendingIntent has to be mutable (Android 12+).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val pending = PendingIntent.getBroadcast(activity, ++requestCounter, answer, flags)

        val run = Intent("com.termux.RUN_COMMAND").apply {
            setClassName(TERMUX_PACKAGE, "com.termux.app.RunCommandService")
            putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_PYTHON)
            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", scriptArgs)
            putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME)
            putExtra("com.termux.RUN_COMMAND_BACKGROUND", true) // no terminal window
            putExtra(
                "com.termux.RUN_COMMAND_COMMAND_LABEL",
                if (j.kind == "fetch") "Novel Reader: fetch new chapters" else "Novel Reader: delete chapters"
            )
            putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pending)
        }

        try {
            try {
                activity.startService(run)
            } catch (e: IllegalStateException) {
                ContextCompat.startForegroundService(activity, run)
            }
        } catch (e: SecurityException) {
            end(j, "failed", 0, "Termux refused the command. $SETUP_HINT")
            return
        } catch (e: Exception) {
            end(j, "failed", 0, "Couldn't start Termux: ${e.message}")
            return
        }

        job = j
        publish(j, "running", 0, "")
        handler.removeCallbacks(poll)
        handler.postDelayed(poll, POLL_MS)
    }

    /** Copies the scripts out of the app into the Novel folder so Termux can read them (only when they changed). Throws on failure. */
    fun deployScripts() {
        val dir = scriptsDir
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw IOException("can't create the folder")
        for (name in arrayOf(DOWNLOADER, DELETER)) {
            val bytes = activity.assets.open("scripts/$name").use { it.readBytes() }
            val target = File(dir, name)
            if (target.isFile && target.length() == bytes.size.toLong() && target.readBytes().contentEquals(bytes)) continue
            val part = File(dir, "$name.part")
            part.writeBytes(bytes)
            if (!part.renameTo(target)) {
                target.delete()
                if (!part.renameTo(target)) throw IOException("can't write $name")
            }
        }
    }

    private fun registerReceiver() {
        if (receiverRegistered) return
        ContextCompat.registerReceiver(
            activity, receiver, IntentFilter(RESULT_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED
        )
        receiverRegistered = true
    }

    // ---- Finishing --------------------------------------------------------------------------

    /** Termux's answer: the script has finished (or could not be started). */
    private fun onResult(intent: Intent) {
        val j = job ?: return // a late answer for a job that was already given up on
        if (intent.getStringExtra(EXTRA_JOB) != j.id) return
        val result = intent.getBundleExtra("result")
        val errmsg = result?.getString("errmsg")?.trim().orEmpty()
        val exit: Int? = if (result != null && result.containsKey("exitCode")) result.getInt("exitCode") else null
        val stdout = result?.getString("stdout").orEmpty()
        val stderr = result?.getString("stderr").orEmpty()

        val now = countChapters(j.dir)
        val n = changed(j, now)

        if (errmsg.isNotEmpty()) {
            val hint = if (errmsg.contains("allow-external-apps", ignoreCase = true)) " $SETUP_HINT" else ""
            end(j, "failed", n, "Termux couldn't run the script: $errmsg$hint")
            return
        }

        if (j.kind == "fetch") {
            when {
                exit == null || exit == 0 -> end(
                    j, "done", n,
                    if (n > 0) "${chaptersText(n)} downloaded." else "No new chapters yet. You're up to date."
                )
                exit == 3 -> end(
                    j, if (n > 0) "done" else "failed", n,
                    (if (n > 0) "${chaptersText(n)} downloaded, then it stopped. " else "") +
                        "The next page couldn't be fetched.\n" + whatWentWrong(stdout, stderr)
                )
                else -> end(j, "failed", n, whatWentWrong(stdout, stderr).ifEmpty { "The downloader stopped (code $exit)." })
            }
        } else {
            when {
                exit == null || exit == 0 -> end(
                    j, "done", n,
                    if (n > 0) "Deleted ${chaptersText(n)}." else "No chapter files up to chapter ${j.upTo} were found."
                )
                else -> end(j, "failed", n, whatWentWrong(stdout, stderr).ifEmpty { "The delete script stopped (code $exit)." })
            }
        }
    }

    /** Chapter files gained (fetch) or lost (delete) since the job started. */
    private fun changed(j: Job, now: Int): Int =
        if (j.kind == "fetch") maxOf(0, now - j.before) else maxOf(0, j.before - now)

    private fun end(j: Job, status: String, count: Int, message: String) {
        handler.removeCallbacks(poll)
        if (job === j) job = null
        if (waitingForPermission === j) waitingForPermission = null
        active = false
        publish(j, status, count, message)
    }

    private fun publish(j: Job, status: String, count: Int, message: String) {
        val json = JSONObject()
            .put("id", j.id)
            .put("kind", j.kind)
            .put("status", status)
            .put("novel", j.novel)
            .put("count", count)
            .put("message", message)
            // The newest chapter saved so far; the page's progress window shows it while fetching.
            .put("latest", if (j.kind == "fetch" && count > 0) latestChapterName(j.dir) else "")
            .toString()
        lastStateJson = json
        onState(json)
    }
}

package com.scell.novelreader.redesign

import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The native half of the "Download songs" wizard (song-download.js). yt-dlp and ffmpeg run inside
 * this app (the youtubedl-android library bundles Python, yt-dlp and ffmpeg), so nothing has to be
 * installed or allowed anywhere else.
 *
 * The page runs two kinds of job, and may have one of each at the same time (the next song
 * downloads while the current one is being named and placed):
 *   - stage: download one link into the staging folder, Audio/.staging/<run>/ (the music scan skips
 *            folders that start with a dot, so nothing shows up in the library yet). The answer's
 *            message is the downloaded file's full path.
 *   - place: give a staged song its final name (file name and title tag) and move it into its
 *            playlist folder, or Audio/ itself. The answer's message is the song's new full path.
 *
 *   page   -> AndroidBridge.stageSong(jobId, url)                       -> [stage]
 *             AndroidBridge.placeSong(jobId, path, name, folder)         -> [place]
 *             AndroidBridge.cancelSongDownload()                          -> [cancel]  (stops every job)
 *   native -> window.onSongDownloadStatus(jobId, "done"|"failed", message)   (via [onStatus])
 *
 * Exactly one done/failed is reported per accepted job.
 *
 * Downloads: yt-dlp is started by the library as a child process (best audio -> mp3, tags and cover
 * art embedded). Stop = the library's destroyProcessById. Placing needs no ffmpeg: the title tag is
 * rewritten by [Id3Title]. yt-dlp breaks now and then when a site changes; the first failure of
 * a session therefore updates yt-dlp from within the app (the library's updater, one request to
 * GitHub) and retries once.
 *
 * Needs the INTERNET permission, and `useLegacyPackaging` for the native libraries (app/build.gradle).
 *
 * Written without being run on a device: test it there.
 */
class SongDownloader(
    private val activity: ComponentActivity,
    /** Reports a result to the page. Always called on the main thread. */
    private val onStatus: (jobId: String, status: String, message: String) -> Unit,
) {

    companion object {
        /** Where downloads wait until they are named and placed. */
        const val STAGING_DIR = "/storage/emulated/0/Novel/Audio/.staging"

        /** The music library; playlists are its sub-folders. */
        const val AUDIO_DIR = "/storage/emulated/0/Novel/Audio"

        /** Is [path] a file inside the staging folder? (Nothing else may be moved or renamed.) */
        fun isStagedPath(path: String?): Boolean {
            if (path.isNullOrBlank()) return false
            return try {
                val file = File(path).canonicalFile
                val root = File(STAGING_DIR).canonicalFile
                file.path.startsWith(root.path + File.separator) && file.isFile
            } catch (e: Exception) {
                false
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val pool: ExecutorService = Executors.newCachedThreadPool()
    private val lock = Any()
    private val running = HashSet<String>()                         // every accepted, unanswered job
    private val downloading = HashSet<String>()                     // the stage jobs among them
    private val cancelled = Collections.synchronizedSet(HashSet<String>())
    private var engineReady = false
    private val updateTried = AtomicBoolean(false)

    /** Gets the bundled Python/yt-dlp/ffmpeg unpacked in the background (a few seconds, once per install). */
    fun warmUp() {
        pool.execute { ensureEngine() }
    }

    fun release() {
        pool.shutdownNow()
    }

    /** True while a job is unanswered (the app must not close itself meanwhile). */
    fun isBusy(): Boolean = synchronized(lock) { running.isNotEmpty() }

    /**
     * Accepts a download job. Returns false only when a job with this id is already running; every
     * other problem is reported to the page as a "failed" result with a message the user can act on.
     * May be called from the WebView's bridge thread.
     */
    fun stage(jobId: String, url: String): Boolean {
        if (!begin(jobId, isDownload = true)) return false
        pool.execute { runStage(jobId, url.trim()) }
        return true
    }

    /** Accepts a placement job: [path] is the staged file, [name] its final name ("" = keep it). */
    fun place(jobId: String, path: String, name: String, folder: String): Boolean {
        if (!begin(jobId, isDownload = false)) return false
        pool.execute { runPlace(jobId, path, SongNames.cleanSongName(name), folder) }
        return true
    }

    /** Stops every running download; each then reports "Stopped" by itself. */
    fun cancel() {
        val ids = synchronized(lock) { downloading.toList() }
        cancelled.addAll(ids)
        for (id in ids) {
            try { YoutubeDL.getInstance().destroyProcessById(id) } catch (e: Exception) { /* already over */ }
        }
    }

    private fun begin(jobId: String, isDownload: Boolean): Boolean = synchronized(lock) {
        val fresh = running.add(jobId)
        if (fresh && isDownload) downloading.add(jobId)
        fresh
    }

    // ---- worker threads from here on ---------------------------------------------------

    /** Unpacks and starts the bundled tools. Returns null when ready, else a message for the user. */
    @Synchronized
    private fun ensureEngine(): String? {
        if (engineReady) return null
        return try {
            val context = activity.applicationContext
            YoutubeDL.getInstance().init(context)
            FFmpeg.getInstance().init(context)
            engineReady = true
            null
        } catch (e: Exception) {
            "Could not start the built-in downloader (${e.message ?: e.cause?.message ?: "unknown error"})."
        }
    }

    private fun runStage(jobId: String, url: String) {
        if (!SongNames.isWebLink(url)) return report(jobId, "failed", "That doesn't look like a web link.")
        ensureEngine()?.let { return report(jobId, "failed", it) }
        if (jobId in cancelled) return report(jobId, "failed", "Stopped")

        val runDir = File(STAGING_DIR, "s_" + UUID.randomUUID().toString().take(8))
        // Half-finished downloads (.webm, .part, thumbnails) go to a cache folder, so the music scan
        // never sees them.
        val tmpDir = File(activity.cacheDir, "song_dl_" + UUID.randomUUID().toString().take(8))
        try {
            if (!runDir.mkdirs() && !runDir.isDirectory) {
                return report(jobId, "failed", "Can't create $STAGING_DIR. Allow \"All files access\" for this app.")
            }
            tmpDir.mkdirs()

            var error = download(jobId, url, runDir, tmpDir)
            if (error != null && jobId !in cancelled && updateTried.compareAndSet(false, true)) {
                // yt-dlp goes stale when a site changes: update it once, then try again.
                val updated = try {
                    YoutubeDL.getInstance().updateYoutubeDL(activity.applicationContext) == YoutubeDL.UpdateStatus.DONE
                } catch (e: Exception) {
                    false
                }
                if (updated) {
                    runDir.listFiles()?.forEach { it.deleteRecursively() }
                    error = download(jobId, url, runDir, tmpDir)
                }
            }

            if (jobId in cancelled) {
                runDir.deleteRecursively()
                return report(jobId, "failed", "Stopped")
            }
            if (error != null) {
                runDir.deleteRecursively()
                return report(jobId, "failed", error)
            }
            val song = runDir.listFiles { f -> f.isFile && f.extension.equals("mp3", ignoreCase = true) }
                ?.maxByOrNull { it.lastModified() }
            if (song == null) {
                runDir.deleteRecursively()
                return report(jobId, "failed", "The download finished but no song file was made.")
            }
            report(jobId, "done", song.absolutePath)
        } catch (e: Exception) {
            runDir.deleteRecursively()
            report(jobId, "failed", SongNames.failureReason(e.message).ifEmpty { "The download failed." })
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    /** Runs yt-dlp once. Returns null on success, else the message to show. */
    private fun download(jobId: String, url: String, runDir: File, tmpDir: File): String? {
        // Same settings as the old script: best audio, converted to mp3 (quality 0), metadata and
        // cover art embedded, one video only.
        val request = YoutubeDLRequest(url)
            .addOption("--no-playlist")
            .addOption("-f", "bestaudio")
            .addOption("-x")
            .addOption("--audio-format", "mp3")
            .addOption("--audio-quality", "0")
            .addOption("--embed-metadata")
            .addOption("--embed-thumbnail")
            .addOption("--convert-thumbnails", "jpg")
            .addOption("--trim-filenames", "180")
            .addOption("-P", "home:" + runDir.absolutePath)
            .addOption("-P", "temp:" + tmpDir.absolutePath)
            .addOption("-o", "%(title)s.%(ext)s")
            .addOption("--no-warnings")
        return try {
            YoutubeDL.getInstance().execute(request, jobId, null)
            null
        } catch (e: YoutubeDL.CanceledException) {
            "Stopped"
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            "Stopped"
        } catch (e: Exception) {
            SongNames.failureReason(e.message ?: e.cause?.message).ifEmpty { "The download failed." }
        }
    }

    private fun runPlace(jobId: String, path: String, name: String, folder: String) {
        val cleanedFolder = SongNames.cleanFolder(folder)
        if (!isStagedPath(path)) return report(jobId, "failed", "That song is no longer there. Download it again.")
        if (folder.isNotBlank() && cleanedFolder.isEmpty()) {
            return report(jobId, "failed", "That playlist name has no usable letters or numbers.")
        }

        val staged = File(path)
        val stem = name.ifEmpty { staged.nameWithoutExtension }
        val destDir = if (cleanedFolder.isEmpty()) File(AUDIO_DIR) else File(AUDIO_DIR, cleanedFolder)
        if (!destDir.isDirectory && !destDir.mkdirs() && !destDir.isDirectory) {
            return report(jobId, "failed", "Can't create ${destDir.path}. Allow \"All files access\" for this app.")
        }
        val target = File(destDir, stem + "." + staged.extension)
        if (target.exists()) {
            return report(jobId, "failed",
                "A song called \u201c$stem\u201d is already in ${cleanedFolder.ifEmpty { "All songs" }}. Change the name.")
        }

        // With a name, the title tag is rewritten into a second file first, so a failure leaves the
        // staged song untouched. ".part" is not an audio extension, so the music scan ignores it.
        var source = staged
        var copy: File? = null
        if (name.isNotEmpty()) {
            copy = File(staged.parentFile, ".retag_" + UUID.randomUUID().toString().take(8) + ".part")
            try {
                Id3Title.copyWithTitle(staged, copy, name)
                source = copy
            } catch (e: Exception) {
                copy.delete()
                return report(jobId, "failed", "Could not change the song's title (${e.message ?: "unknown error"}).")
            }
        }

        val moved = source.renameTo(target) || try {         // renameTo is an instant move on the same storage
            source.copyTo(target, overwrite = false)
            true
        } catch (e: Exception) {
            target.delete()
            false
        }
        copy?.let { if (it.exists()) it.delete() }
        if (!moved) return report(jobId, "failed", "Could not move the song into ${cleanedFolder.ifEmpty { "Audio" }}.")

        staged.delete()
        staged.parentFile?.delete()                           // the song's own now-empty staging folder (only if empty)
        report(jobId, "done", target.absolutePath)
    }

    /** Hands a result to the main thread; the page hears about it there. */
    private fun report(jobId: String, status: String, message: String) {
        main.post { finish(jobId, status, message) }
    }

    private fun finish(jobId: String, status: String, message: String) {
        val mine = synchronized(lock) {
            downloading.remove(jobId)
            running.remove(jobId)
        }
        cancelled.remove(jobId)
        if (!mine) return                    // a late or repeated answer changes nothing
        onStatus(jobId, status, message)
    }
}

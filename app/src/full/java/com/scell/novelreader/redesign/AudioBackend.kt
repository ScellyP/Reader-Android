package com.scell.novelreader.redesign

import android.content.ComponentName
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.WebResourceResponse
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream

/**
 * Everything of the app that exists for the music player: the connection to PlaybackService, the
 * music library scan, cover art, serving music files to the page, the volume / Bluetooth helpers
 * and the "Download songs" jobs. MainActivity only forwards to it.
 *
 * This is the "full" flavor's version (app/src/full/). The "noaudio" flavor has a same-named class
 * with empty bodies (app/src/noaudio/), so MainActivity compiles unchanged in both and the no-audio
 * APK contains no media3, no yt-dlp / Python / ffmpeg and none of this code.
 */
internal class AudioBackend(private val a: MainActivity) {

    private val audioExtensions = setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav")

    // ---- Download songs ----
    private val songDownloader = SongDownloader(
        activity = a,
        onStatus = { jobId, status, message ->
            a.callPage(
                "onSongDownloadStatus",
                JSONObject.quote(jobId) + ", " + JSONObject.quote(status) + ", " + JSONObject.quote(message)
            )
        },
    )

    fun warmUp() = songDownloader.warmUp()   // unpacks yt-dlp / ffmpeg
    fun isBusy(): Boolean = songDownloader.isBusy()
    fun stageSong(jobId: String, url: String): Boolean = songDownloader.stage(jobId, url)
    fun placeSong(jobId: String, path: String, name: String, folder: String): Boolean =
        songDownloader.place(jobId, path, name, folder)
    fun cancelSongDownload() { songDownloader.cancel() }
    fun discardStagedSongs() {
        try { File(SongDownloader.STAGING_DIR).deleteRecursively() } catch (e: Exception) { /* nothing to delete */ }
    }

    // ---- Native player (MediaController <-> PlaybackService) ----
    private var mediaController: MediaController? = null
    private var mediaControllerFuture: ListenableFuture<MediaController>? = null
    private val progressHandler = Handler(Looper.getMainLooper())
    private var progressRunnable: Runnable? = null
    private var mutePaused = false

    /** True while the native player plays or is about to (used to keep the app from closing itself). */
    fun isNativeActive(): Boolean {
        val c = mediaController
        return c != null && (c.isPlaying ||
            (c.playWhenReady && (c.playbackState == Player.STATE_BUFFERING ||
                c.playbackState == Player.STATE_READY)))
    }

    fun nativeStateDebug(): String {
        val c = mediaController
        return "${c?.playbackState}/${c?.playWhenReady}"
    }

    fun pauseNative() { mediaController?.pause() }

    /** The controller may have connected before the page finished loading: announce it again. */
    fun onPageFinished() {
        if (mediaController != null) a.callPage("onNativeAudioReady")
    }

    fun onResume() {
        // Push the current position right away (the poll may have been in slow mode).
        if (mediaController?.isPlaying == true) startProgressUpdates()
    }

    /** Muting the media volume pauses the music; raising it again resumes it (only that pause is undone). */
    fun onMuteChanged(muted: Boolean) {
        val controller = mediaController
        if (muted) {
            if (controller != null && controller.isPlaying) {
                mutePaused = true
                controller.pause()
            }
        } else if (mutePaused) {
            mutePaused = false
            controller?.play()
        }
    }

    /** Connects a MediaController to PlaybackService's MediaSession (see audio-player.js's NativeAudioEngine). */
    fun connect() {
        val sessionToken = SessionToken(a, ComponentName(a, PlaybackService::class.java))
        val future = MediaController.Builder(a, sessionToken).buildAsync()
        mediaControllerFuture = future
        future.addListener({
            try {
                val controller = future.get()
                mediaController = controller
                controller.addListener(nativePlayerListener)
                PlaybackService.queueNavigationListener = object : PlaybackService.QueueNavigationListener {
                    override fun onSkipToNext() {
                        a.postToPage { a.callPage("onNativeAudioSkipNext") }
                    }
                    override fun onSkipToPrevious() {
                        a.postToPage { a.callPage("onNativeAudioSkipPrevious") }
                    }
                }
                a.callPage("onNativeAudioReady")
            } catch (e: Exception) {
                // Native engine unavailable: audio-player.js's LocalAudioEngine keeps working as the fallback.
            }
        }, MoreExecutors.directExecutor())
    }

    /** Releases the controller and stops polling (playback itself lives in PlaybackService and goes on). */
    fun release() {
        songDownloader.release()
        stopProgressUpdates()
        mediaControllerFuture?.let { MediaController.releaseFuture(it) }
        mediaController = null
        if (PlaybackService.queueNavigationListener != null) {
            PlaybackService.queueNavigationListener = null
        }
    }

    /** Forwards ExoPlayer/MediaSession state to JS (also what the notification buttons or a headset cause). */
    private val nativePlayerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            reportPlaying(isPlaying)
            if (isPlaying) startProgressUpdates() else stopProgressUpdates()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_READY -> {
                    val durationMs = mediaController?.duration ?: C.TIME_UNSET
                    val durationSec = if (durationMs != C.TIME_UNSET) durationMs / 1000.0 else 0.0
                    a.callPage("onNativeAudioLoaded", durationSec.toString())
                }
                Player.STATE_ENDED -> a.callPage("onNativeAudioEnded")
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            a.callPage("onNativeAudioError", JSONObject.quote(error.message ?: "Playback error"))
        }
    }

    /** Polls the playback position while playing (MediaController has no position-changed callback). */
    private fun startProgressUpdates() {
        stopProgressUpdates()
        val runnable = object : Runnable {
            override fun run() {
                val controller = mediaController
                if (controller != null) {
                    val posSec = controller.currentPosition / 1000.0
                    val durMs = controller.duration
                    val durSec = if (durMs != C.TIME_UNSET && durMs > 0) durMs / 1000.0 else 0.0
                    a.callPage("onNativeAudioProgress", "$posSec, $durSec")
                }
                // Screen visible: 500 ms keeps the seek bar smooth. In the background tick slowly
                // mid-track and only go back to 500 ms near the end (crossfade, sleep-timer fade).
                val remainingSec = if (controller != null && controller.duration != C.TIME_UNSET && controller.duration > 0)
                    (controller.duration - controller.currentPosition) / 1000.0 else 0.0
                val delay = if (a.appInForeground || remainingSec <= 35.0) 500L else 2000L
                progressHandler.postDelayed(this, delay)
            }
        }
        progressRunnable = runnable
        progressHandler.post(runnable)
    }

    private fun stopProgressUpdates() {
        progressRunnable?.let { progressHandler.removeCallbacks(it) }
        progressRunnable = null
    }

    /** Tells the page whether the native player is playing (window.onNativeAudioState). */
    private fun reportPlaying(playing: Boolean) {
        a.callPage("onNativeAudioState", JSONObject.quote(JSONObject().put("playing", playing).toString()))
    }

    // ---- The nativeAudio* bridge calls (audio-player.js's NativeAudioEngine) ----

    /** Resolves [path] (a real audio file inside Audio/), pulls cover art and builds the MediaItem; null (and an error to the page) if unusable. */
    private fun buildAudioItem(path: String, title: String, artist: String, album: String): MediaItem? {
        val audioFile = resolveAudioFile(path) ?: run {
            a.runOnUiThread { a.callPage("onNativeAudioError", JSONObject.quote("That file can't be played.")) }
            return null
        }
        val art = loadArtworkBytes(path)
        val metadata = MediaMetadata.Builder()
            .setTitle(title.ifBlank { null })
            .setArtist(artist.ifBlank { null })
            .setAlbumTitle(album.ifBlank { null })
            .apply {
                if (art != null) setArtworkData(art, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
            }
            .build()
        return MediaItem.Builder()
            .setUri(Uri.fromFile(audioFile))
            .setMediaId(path)
            .setMediaMetadata(metadata)
            .build()
    }

    fun nativeAudioLoad(path: String, title: String, artist: String, album: String) {
        val item = buildAudioItem(path, title, artist, album) ?: return
        a.runOnUiThread {
            PlaybackService.crossfade?.cancel()   // loading something else ends any crossfade
            mediaController?.setMediaItem(item)
            mediaController?.prepare()
        }
    }

    /** Starts [path] crossfading from the playing track over [seconds] (NativeCrossfade.kt); always ends with the new track playing. */
    fun nativeAudioCrossfade(
        path: String, title: String, artist: String, album: String,
        seconds: Double, outGain: Double, inGain: Double
    ) {
        val item = buildAudioItem(path, title, artist, album) ?: return
        a.runOnUiThread {
            val xf = PlaybackService.crossfade
            if (xf != null) {
                xf.start(item, seconds, outGain, inGain)
            } else {
                mediaController?.setMediaItem(item)
                mediaController?.prepare()
                mediaController?.play()
            }
        }
    }

    fun nativeAudioSyncState() {
        a.runOnUiThread {
            val c = mediaController
            reportPlaying(
                c != null && c.playWhenReady &&
                    (c.playbackState == Player.STATE_READY || c.playbackState == Player.STATE_BUFFERING)
            )
        }
    }

    fun nativeAudioPlay() { a.runOnUiThread { mediaController?.play() } }
    fun nativeAudioPause() { a.runOnUiThread { mediaController?.pause() } }
    fun nativeAudioSeek(seconds: Double) { a.runOnUiThread { mediaController?.seekTo((seconds * 1000).toLong()) } }

    fun nativeAudioSetVolume(volume: Double) {
        a.runOnUiThread {
            // During a crossfade the ramp owns the players' volume; the new level is only its target.
            val xf = PlaybackService.crossfade
            if (xf != null && xf.isActive()) {
                xf.setInGain(volume.toFloat())
            } else {
                mediaController?.volume = volume.toFloat().coerceIn(0f, 1f)
            }
        }
    }

    fun nativeAudioSetBoostDb(db: Double) {
        a.runOnUiThread { PlaybackService.effects?.setBoostDb(db.toFloat()) }
    }

    // ---- Volume slider / Bluetooth ----
    fun setSystemVolume(volume: Double) {
        try {
            val am = a.getSystemService(AudioManager::class.java) ?: return
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val level = Math.round(volume.coerceIn(0.0, 1.0) * max).toInt()
            am.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)
        } catch (e: Exception) {
            // Not permitted in the current device state — ignore.
        }
    }

    fun getSystemVolume(): Double {
        return try {
            val am = a.getSystemService(AudioManager::class.java) ?: return 0.8
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            if (max <= 0) 0.8 else am.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max
        } catch (e: Exception) {
            0.8
        }
    }

    /** True when a Bluetooth audio device is connected as an output (needs no permission). */
    fun isBluetoothAudioConnected(): Boolean {
        val am = a.getSystemService(AudioManager::class.java) ?: return false
        return am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { isBluetoothMusicOutput(it.type) }
    }

    /** Bluetooth outputs that carry music (the phone-call link SCO is left out on purpose). */
    private fun isBluetoothMusicOutput(type: Int): Boolean = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> true
        AudioDeviceInfo.TYPE_HEARING_AID -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        else -> false
    }

    // ---- Library scan, cover art, serving files ----
    fun runScan() = runAudioScan()

    /** Rescan button: always walk the folder again and report to the page. */
    fun scanNow() {
        jsWantsAudio = true
        runAudioScan()
    }

    fun scanAtStartup() { requestAudioListAtStartup() }

    /** Cover art as a data: URI for the in-app player, or "" if none. */
    fun artworkDataUri(path: String): String {
        val bytes = loadArtworkBytes(path) ?: return ""
        return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    /**
     * The only way a path coming from the page (the JavaScript bridge) may
     * turn into a File. The page is not trusted: it must not be able to make
     * the app read, decode or play arbitrary files, and this app holds
     * all-files access. A path is accepted only when it is a file:// URI (or
     * a plain absolute path), the real file after resolving "..", symlinks and
     * percent-encoding lies inside the Audio folder, it exists, and it has a
     * recognised audio extension. Returns the resolved File, or null.
     */
    private fun resolveAudioFile(path: String?): File? {
        return try {
            if (path.isNullOrBlank()) return null
            val uri = Uri.parse(path)
            val scheme = uri.scheme
            if (scheme != null && !scheme.equals("file", ignoreCase = true)) return null
            val raw = (if (scheme == null) path else uri.path) ?: return null
            val file = File(raw).canonicalFile
            val root = a.audioRoot.canonicalFile
            if (!file.path.startsWith(root.path + File.separator)) return null
            if (!file.isFile) return null
            if (!audioExtensions.contains(file.extension.lowercase())) return null
            file
        } catch (e: Exception) {
            null
        }
    }

    // ---- Audio library scan: starts at launch, runs in parallel, caches tags ----
    // The scan used to start only when the page asked for it and read every
    // file's tags one after another. Now it starts in onCreate (alongside the
    // chapter loading), reads tags on several threads, and remembers each
    // file's tags (keyed by path + size + modified time) so unchanged files
    // are not parsed again on the next launch.
    @Volatile private var audioScanRunning = false
    @Volatile private var jsWantsAudio = false
    @Volatile private var audioScanJson: String? = null
    @Volatile private var audioScanAt = 0L

    private fun deliverAudioList(tracksJson: String) {
        a.callPage("onAudioListed", JSONObject.quote(tracksJson))
    }

    /** Page start-up request: reuse a fresh early scan, or wait for the one in flight. */
    private fun requestAudioListAtStartup() {
        jsWantsAudio = true
        val ready = audioScanJson
        if (ready != null && System.currentTimeMillis() - audioScanAt < 120_000L) {
            deliverAudioList(ready)
        } else if (!audioScanRunning) {
            runAudioScan()
        } // else: a scan is running and delivers to the page when it finishes
    }

    private fun tagCacheFile() = File(a.cacheDir, "audio_tags.json")

    private fun loadTagCache(): java.util.concurrent.ConcurrentHashMap<String, JSONObject> {
        val map = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
        try {
            val f = tagCacheFile()
            if (f.exists()) {
                val root = JSONObject(f.readText())
                for (k in root.keys()) map[k] = root.getJSONObject(k)
            }
        } catch (e: Exception) {
            // Unreadable cache: just rebuild it.
        }
        return map
    }

    private fun saveTagCache(cache: Map<String, JSONObject>, livePaths: Set<String>) {
        try {
            val root = JSONObject()
            for ((k, v) in cache) if (livePaths.contains(k)) root.put(k, v)
            tagCacheFile().writeText(root.toString())
        } catch (e: Exception) {
            // Cache is an optimisation only.
        }
    }

    /**
     * Recursively scans a.audioRoot for files with a recognised extension,
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
    private fun runAudioScan() {
        if (audioScanRunning) return
        audioScanRunning = true
        Thread {
            try {
                if (!a.hasStoragePermission()) {
                    audioScanRunning = false
                    if (jsWantsAudio) a.runOnUiThread {
                        a.notifyError("Storage permission is needed to read /storage/emulated/0/Novel/Audio.")
                    }
                    return@Thread
                }

                if (!a.audioRoot.exists()) {
                    a.audioRoot.mkdirs()
                }

                // Sorted by path-relative-to-Audio/ (not just filename) so
                // tracks in the same playlist folder stay grouped together.
                // Folders starting with a dot are skipped: Audio/.staging/ holds songs of the Download
                // tab that are not named or placed yet.
                val audioFiles = a.audioRoot.walkTopDown()
                    .filter { it.isFile && audioExtensions.contains(it.extension.lowercase()) }
                    .filter { f -> f.toRelativeString(a.audioRoot).split(File.separatorChar).none { it.startsWith(".") } }
                    .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) {
                        it.toRelativeString(a.audioRoot)
                    })
                    .toList()

                val cache = loadTagCache()
                val results = arrayOfNulls<JSONObject>(audioFiles.size)
                val pool = java.util.concurrent.Executors.newFixedThreadPool(4)
                audioFiles.forEachIndexed { i, f ->
                    pool.execute {
                        results[i] = try { buildTrackJson(f, cache) } catch (e: Exception) { null }
                    }
                }
                pool.shutdown()
                pool.awaitTermination(15, java.util.concurrent.TimeUnit.MINUTES)

                val tracksArray = JSONArray()
                for (r in results) if (r != null) tracksArray.put(r)
                saveTagCache(cache, audioFiles.map { it.absolutePath }.toSet())

                val json = tracksArray.toString()
                audioScanJson = json
                audioScanAt = System.currentTimeMillis()
                audioScanRunning = false

                a.runOnUiThread { if (jsWantsAudio) deliverAudioList(json) }
            } catch (e: Exception) {
                audioScanRunning = false
                if (jsWantsAudio) a.runOnUiThread { a.notifyError("Could not scan /storage/emulated/0/Novel/Audio: ${e.message}") }
            }
        }.start()
    }

    private fun buildTrackJson(f: File, cache: java.util.concurrent.ConcurrentHashMap<String, JSONObject>): JSONObject {
        val obj = JSONObject()
        obj.put("id", f.absolutePath)
        obj.put("path", Uri.fromFile(f).toString()) // percent-encodes spaces etc. correctly
        val relativePath = f.toRelativeString(a.audioRoot).replace(File.separatorChar, '/')
        // Address the page's <audio> element uses (see serveAudio()).
        obj.put("webUrl", "https://$a.appHost/audio/" + Uri.encode(relativePath, "/"))
        // First path segment under Audio/ is the playlist; no '/' = no playlist.
        val slashIndex = relativePath.indexOf('/')
        if (slashIndex > 0) obj.put("playlist", relativePath.substring(0, slashIndex))
        else obj.put("playlist", JSONObject.NULL)

        val size = f.length()
        val modified = f.lastModified()
        val hit = cache[f.absolutePath]
        val tags: JSONObject
        if (hit != null && hit.optLong("s", -1L) == size && hit.optLong("m", -1L) == modified) {
            tags = hit.getJSONObject("t")
        } else {
            tags = JSONObject()
            readAudioTags(f, tags)
            cache[f.absolutePath] = JSONObject().put("s", size).put("m", modified).put("t", tags)
        }
        for (k in tags.keys()) obj.put(k, tags.get(k))
        return obj
    }

    /**
     * Cover art for the track at `path` (a file:// URI), as a JPEG scaled
     * to at most 512px so it is cheap to hand to the notification and the
     * WebView. Looks for embedded art first, then a cover/folder image in
     * the same folder. Results are cached in a.cacheDir/art so each file is
     * only decoded once. Returns null when there is no art.
     */
    private fun loadArtworkBytes(path: String): ByteArray? {
        return try {
            val file = resolveAudioFile(path) ?: return null
            val dir = File(a.cacheDir, "art").apply { mkdirs() }
            val key = (file.absolutePath + file.lastModified()).hashCode().toString()
            val cached = File(dir, "$key.jpg")
            val none = File(dir, "$key.none")
            if (cached.exists()) return cached.readBytes()
            if (none.exists()) return null

            var raw: ByteArray? = null
            var tagsUnreadable = false   // reading the tags failed: could be passing (file busy), so don't remember "no art"
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(file.absolutePath)
                raw = retriever.embeddedPicture
            } catch (e: Exception) {
                tagsUnreadable = true
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
                // Only a song that was read fine and has no picture is remembered as having none.
                if (!tagsUnreadable) none.createNewFile()
                return null
            }
            val scaled = a.scaleToJpeg(raw, 512)
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
        addReplayGain(f, obj)
    }

    /**
     * Adds the file's ReplayGain tags (read by ReplayGainReader, since
     * MediaMetadataRetriever cannot) as replayGainTrackDb / replayGainAlbumDb /
     * replayGainPeak / replayGainAlbumPeak. Tags that are missing are simply
     * not added, so audio-player.js leaves that track's volume alone. Runs
     * even when the retriever failed above - the file may still have tags.
     */
    private fun addReplayGain(f: File, obj: JSONObject) {
        val rg = ReplayGainReader.read(f) ?: return
        rg.trackDb?.let { obj.put("replayGainTrackDb", it) }
        rg.albumDb?.let { obj.put("replayGainAlbumDb", it) }
        rg.trackPeak?.let { obj.put("replayGainPeak", it) }
        rg.albumPeak?.let { obj.put("replayGainAlbumPeak", it) }
    }

    private fun audioMimeType(ext: String): String = when (ext.lowercase()) {
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "aac" -> "audio/aac"
        "flac" -> "audio/flac"
        "ogg" -> "audio/ogg"
        "opus" -> "audio/ogg"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }

    /**
     * Serves one music file to the page's <audio> element from
     * https://appassets.androidplatform.net/audio/<path relative to Audio/>.
     * Goes through resolveAudioFile(), so only existing audio files that really
     * lie inside Novel/Audio can be read. Supports HTTP Range requests, which
     * the WebView's media player needs for seeking. Runs on a WebView
     * background thread.
     */
    fun serveAudio(relativePath: String, headers: Map<String, String>): WebResourceResponse? {
        val file = resolveAudioFile(File(a.audioRoot, relativePath).path) ?: return a.plainResponse(404)
        return try {
            val length = file.length()
            var start = 0L
            var end = length - 1
            var status = 200
            val rangeHeader = headers.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
            val match = rangeHeader?.let { Regex("^bytes=(\\d*)-(\\d*)$").matchEntire(it.trim()) }
            if (match != null && length > 0) {
                val first = match.groupValues[1]
                val last = match.groupValues[2]
                if (first.isNotEmpty() || last.isNotEmpty()) {
                    try {
                        if (first.isEmpty()) {
                            start = maxOf(0L, length - last.toLong())      // "last N bytes"
                        } else {
                            start = first.toLong()
                            if (last.isNotEmpty()) end = minOf(last.toLong(), length - 1)
                        }
                    } catch (e: NumberFormatException) {
                        return a.plainResponse(416)
                    }
                    if (start >= length || start > end) return a.plainResponse(416)
                    status = 206
                }
            }
            val count = if (length == 0L) 0L else end - start + 1
            val input = FileInputStream(file)
            input.channel.position(start)
            val responseHeaders = mutableMapOf(
                "Accept-Ranges" to "bytes",
                "Content-Length" to count.toString()
            )
            if (status == 206) responseHeaders["Content-Range"] = "bytes $start-$end/$length"
            WebResourceResponse(
                audioMimeType(file.extension), null, status,
                if (status == 206) "Partial Content" else "OK",
                responseHeaders, LimitedInputStream(input, count)
            )
        } catch (e: Exception) {
            a.plainResponse(404)
        }
    }
}

/** Reads at most [remaining] bytes of [source] (used for HTTP Range responses). */
private class LimitedInputStream(source: InputStream, private var remaining: Long) : FilterInputStream(source) {
    override fun read(): Int {
        if (remaining <= 0) return -1
        val b = super.read()
        if (b >= 0) remaining--
        return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (remaining <= 0) return -1
        val n = super.read(b, off, minOf(len.toLong(), remaining).toInt())
        if (n > 0) remaining -= n
        return n
    }

    override fun available(): Int = minOf(super.available().toLong(), remaining).toInt()
}

package com.scell.novelreader.redesign

import android.webkit.WebResourceResponse

/**
 * The "noaudio" flavor's AudioBackend: the same members as app/src/full/.../AudioBackend.kt, all
 * doing nothing. There is no music player, no PlaybackService, no media3 and no yt-dlp in this
 * build; MainActivity still compiles against these empty calls, and the page never makes them
 * (its audio scripts are the stubs in app/src/noaudio/assets/).
 */
@Suppress("UNUSED_PARAMETER", "unused")
internal class AudioBackend(private val a: MainActivity) {
    fun warmUp() {}
    fun isBusy(): Boolean = false
    fun stageSong(jobId: String, url: String): Boolean = false
    fun placeSong(jobId: String, path: String, name: String, folder: String): Boolean = false
    fun cancelSongDownload() {}
    fun discardStagedSongs() {}

    fun isNativeActive(): Boolean = false
    fun nativeStateDebug(): String = "none"
    fun pauseNative() {}
    fun onPageFinished() {}
    fun onResume() {}
    fun onMuteChanged(muted: Boolean) {}
    fun connect() {}
    fun release() {}

    fun nativeAudioLoad(path: String, title: String, artist: String, album: String) {}
    fun nativeAudioCrossfade(
        path: String, title: String, artist: String, album: String,
        seconds: Double, outGain: Double, inGain: Double
    ) {}
    fun nativeAudioSyncState() {}
    fun nativeAudioPlay() {}
    fun nativeAudioPause() {}
    fun nativeAudioSeek(seconds: Double) {}
    fun nativeAudioSetVolume(volume: Double) {}
    fun nativeAudioSetBoostDb(db: Double) {}

    fun setSystemVolume(volume: Double) {}
    fun getSystemVolume(): Double = 0.8
    fun isBluetoothAudioConnected(): Boolean = false

    fun runScan() {}
    fun scanNow() {}
    fun scanAtStartup() {}
    fun artworkDataUri(path: String): String = ""
    fun serveAudio(relativePath: String, headers: Map<String, String>): WebResourceResponse? = null
}

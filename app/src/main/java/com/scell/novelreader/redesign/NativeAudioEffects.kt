package com.scell.novelreader.redesign

import android.media.audiofx.LoudnessEnhancer

/**
 * The positive half of replay gain for the native (ExoPlayer) engine: a
 * quiet track is turned UP with Android's LoudnessEnhancer, which attaches to
 * the player's *audio session* (the WebView engine can only turn a track
 * down). See audio-player.js → AudioFeatures.nativeEffects for the JS half,
 * which calls AndroidBridge.nativeAudioSetBoostDb.
 *
 * Design notes:
 *  - Best-effort: some devices have no LoudnessEnhancer or refuse to create
 *    one; every failure is swallowed rather than crashing playback.
 *  - The last requested boost is remembered and re-applied whenever the
 *    effect has to be recreated (new audio session, service restart).
 *  - Call everything from the main thread: [sessionIdProvider] reads the
 *    ExoPlayer, which must be touched from its application thread.
 */
class NativeAudioEffects(private val sessionIdProvider: () -> Int) {

    private var attachedSession = 0
    private var loudness: LoudnessEnhancer? = null
    private var boostDb = 0f

    /** Extra gain in dB (>= 0) on top of full scale, for positive replay-gain values. */
    fun setBoostDb(db: Float) {
        boostDb = if (db > 0f) db else 0f
        if (ensureAttached()) applyBoost()
    }

    fun release() {
        releaseEffect()
        attachedSession = 0
    }

    private fun ensureAttached(): Boolean {
        val id = try { sessionIdProvider() } catch (e: Exception) { 0 }
        if (id == 0) return false // AUDIO_SESSION_ID_GENERATE: no real session yet
        if (id == attachedSession && loudness != null) return true

        releaseEffect()
        try {
            val le = LoudnessEnhancer(id)
            le.setEnabled(true)
            loudness = le
        } catch (e: Exception) {
            loudness = null
        }
        attachedSession = id
        if (loudness != null) applyBoost()
        return loudness != null
    }

    private fun applyBoost() {
        val le = loudness ?: return
        try {
            le.setTargetGain(Math.round(boostDb * 100f))
        } catch (e: Exception) {
            // Effect went away underneath us (e.g. session torn down); next call re-attaches.
            releaseEffect()
            attachedSession = 0
        }
    }

    private fun releaseEffect() {
        try { loudness?.release() } catch (e: Exception) { /* ignore */ }
        loudness = null
    }
}

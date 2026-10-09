package com.scell.novelreader.redesign

import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.ln

/**
 * Hardware-side audio effects for the native (ExoPlayer) engine: the
 * equalizer, and the positive half of replay gain.
 *
 * Why this exists: the WebView engine's equalizer is a Web Audio graph, and
 * audio played through ExoPlayer never passes through the page's
 * AudioContext. Android's own effects attach to the player's *audio session*
 * instead, which is what this class does. See audio-player.js →
 * AudioFeatures.nativeEffects for the JS half and AndroidBridge's
 * nativeAudioSetEqualizer / nativeAudioSetBoostDb / nativeAudioEffectsRequestInfo.
 *
 * Design notes:
 *  - The UI always speaks in its fixed 10 bands (UI_HZ). A device equalizer
 *    has its own band layout (often 5), so each device band is set from the
 *    UI curve interpolated in log-frequency.
 *  - Everything is best-effort. Some devices have no Equalizer/LoudnessEnhancer
 *    or refuse to create one; every failure is swallowed and reported as
 *    "not available" rather than crashing playback.
 *  - The last requested curve/boost is remembered and re-applied whenever the
 *    effects have to be recreated (new audio session, service restart).
 *  - Call everything from the main thread: [sessionIdProvider] reads the
 *    ExoPlayer, which must be touched from its application thread.
 */
class NativeAudioEffects(private val sessionIdProvider: () -> Int) {

    private var attachedSession = 0
    private var equalizer: Equalizer? = null
    private var loudness: LoudnessEnhancer? = null

    private var uiBandsDb = FloatArray(UI_HZ.size)
    private var preampDb = 0f
    private var boostDb = 0f

    /** Sets the 10-band UI curve (dB, roughly -12..+12) plus preamp, and applies it. */
    fun setEqualizer(bandsDb: FloatArray, preamp: Float) {
        for (i in uiBandsDb.indices) {
            uiBandsDb[i] = if (i < bandsDb.size) bandsDb[i] else 0f
        }
        preampDb = preamp
        if (ensureAttached()) applyEqualizer()
    }

    /** Extra gain in dB (>= 0) on top of full scale, for positive replay-gain values. */
    fun setBoostDb(db: Float) {
        boostDb = if (db > 0f) db else 0f
        if (ensureAttached()) applyBoost()
    }

    /** JSON describing what this device can do, for the UI. */
    fun describe(): String {
        val out = JSONObject()
        val ok = ensureAttached()
        out.put("available", ok && equalizer != null)
        val eq = equalizer
        if (ok && eq != null) {
            try {
                val range = eq.getBandLevelRange()
                out.put("minDb", range[0] / 100.0)
                out.put("maxDb", range[1] / 100.0)
                val bands = JSONArray()
                val count = eq.getNumberOfBands().toInt()
                for (b in 0 until count) {
                    bands.put(eq.getCenterFreq(b.toShort()) / 1000.0)
                }
                out.put("bandsHz", bands)
            } catch (e: Exception) {
                out.put("available", false)
            }
        }
        out.put("boost", loudness != null)
        return out.toString()
    }

    fun release() {
        releaseEffects()
        attachedSession = 0
    }

    // ---------------------------------------------------------------------

    private fun ensureAttached(): Boolean {
        val id = try { sessionIdProvider() } catch (e: Exception) { 0 }
        if (id == 0) return false // AUDIO_SESSION_ID_GENERATE: no real session yet
        if (id == attachedSession && (equalizer != null || loudness != null)) return true

        releaseEffects()
        try {
            val eq = Equalizer(0, id)
            eq.setEnabled(true)
            equalizer = eq
        } catch (e: Exception) {
            equalizer = null
        }
        try {
            val le = LoudnessEnhancer(id)
            le.setEnabled(true)
            loudness = le
        } catch (e: Exception) {
            loudness = null
        }
        attachedSession = id
        if (equalizer != null) applyEqualizer()
        if (loudness != null) applyBoost()
        return equalizer != null || loudness != null
    }

    private fun applyEqualizer() {
        val eq = equalizer ?: return
        try {
            val range = eq.getBandLevelRange()
            val lo = range[0].toInt()
            val hi = range[1].toInt()
            val count = eq.getNumberOfBands().toInt()
            for (b in 0 until count) {
                val hz = eq.getCenterFreq(b.toShort()) / 1000.0
                val db = interpolateDb(hz) + preampDb
                var level = Math.round(db * 100f)
                if (level < lo) level = lo
                if (level > hi) level = hi
                eq.setBandLevel(b.toShort(), level.toShort())
            }
        } catch (e: Exception) {
            // Effect went away underneath us (e.g. session torn down); next call re-attaches.
            releaseEffects()
            attachedSession = 0
        }
    }

    private fun applyBoost() {
        val le = loudness ?: return
        try {
            le.setTargetGain(Math.round(boostDb * 100f))
        } catch (e: Exception) {
            // best effort
        }
    }

    /** UI curve value at [hz], interpolated linearly in log-frequency. */
    private fun interpolateDb(hz: Double): Float {
        val last = UI_HZ.size - 1
        if (hz <= UI_HZ[0]) return uiBandsDb[0]
        if (hz >= UI_HZ[last]) return uiBandsDb[last]
        for (i in 0 until last) {
            if (hz <= UI_HZ[i + 1]) {
                val t = ((ln(hz) - ln(UI_HZ[i])) / (ln(UI_HZ[i + 1]) - ln(UI_HZ[i]))).toFloat()
                return uiBandsDb[i] + (uiBandsDb[i + 1] - uiBandsDb[i]) * t
            }
        }
        return 0f
    }

    private fun releaseEffects() {
        try { equalizer?.release() } catch (e: Exception) { /* ignore */ }
        try { loudness?.release() } catch (e: Exception) { /* ignore */ }
        equalizer = null
        loudness = null
    }

    companion object {
        /** Must match EQ_BAND_HZ in audio-player.js. */
        private val UI_HZ = doubleArrayOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)
    }
}

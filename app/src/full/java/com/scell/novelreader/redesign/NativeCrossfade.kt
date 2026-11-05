package com.scell.novelreader.redesign

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Crossfade for the native (ExoPlayer) engine. The JS half is
 * NativeAudioEngine.beginCrossfade() in audio-player.js; it reaches this class
 * through AndroidBridge.nativeAudioCrossfade() and [PlaybackService.crossfade].
 *
 * One ExoPlayer can only hold one track, so two take turns:
 *
 *   [active]  the player the MediaSession (and so the notification, lock
 *             screen and MainActivity's MediaController) is attached to.
 *   [spare]   an idle second player, created on the first crossfade.
 *
 * A crossfade works like this (everything on the main thread):
 *   1. The spare loads the next track at volume 0 and starts it.
 *   2. The session is handed to the spare AT ONCE ([makeActive]). From then
 *      on the controller, the notification, the position/duration reports and
 *      the "ended" event all describe the NEW track — which matches the page,
 *      whose queue has already moved on. The old player is no longer observed
 *      by anyone, so its end-of-track can't trigger a second "next".
 *   3. A short timer ramps the two against each other on an equal-power curve
 *      (cos out / sin in) for the fade length, then stops the old player and
 *      keeps it as the next spare.
 *
 * Both players use the same audio session id (see PlaybackService), so the
 * loudness boost attached to that session covers both of them.
 * Only the active player handles audio focus; focus is passed over with the
 * session, otherwise the second player would take focus from the first and
 * pause it.
 *
 * The fade is ended early — the old player stopped, the new one snapped to its
 * full level — if the user pauses, seeks, or loads another track, or if audio
 * focus is lost. start() ALWAYS ends with the requested track playing: if it
 * cannot overlap (nothing is playing, or under [MIN_FADE_MS] of the old track
 * is left) it just switches, so the page's idea of the current track stays true.
 *
 * Call everything from the main thread.
 */
@OptIn(UnstableApi::class)
class NativeCrossfade(
    private var active: ExoPlayer,
    private val audioAttributes: AudioAttributes,
    /** Builds the second player: same audio session id, no audio focus handling. */
    private val createSpare: () -> ExoPlayer,
    /** Attaches the MediaSession to this player (PlaybackService wraps it in QueueAwarePlayer). */
    private val makeActive: (ExoPlayer) -> Unit
) {

    private class Fade(
        val outgoing: ExoPlayer,
        val incoming: ExoPlayer,
        val outGain: Float,
        var inGain: Float,
        val requestedMs: Long,
        val createdMs: Long
    ) {
        var startMs = -1L          // set once the incoming player is really playing
        var fadeMs = 0L
        var listener: Player.Listener? = null
    }

    private val handler = Handler(Looper.getMainLooper())
    private var spare: ExoPlayer? = null
    private var fading: Fade? = null

    /** True while two tracks are overlapping. */
    fun isActive(): Boolean = fading != null

    /**
     * The page changed the volume (slider, replay gain for the new track).
     * While fading, the ramp owns the players' volume and only needs the new
     * target for the incoming track.
     */
    fun setInGain(gain: Float) {
        fading?.inGain = gain.coerceIn(0f, 1f)
    }

    /**
     * Plays [item] from its start, crossfading from whatever is playing over
     * [seconds]. [outGain] / [inGain] are the linear levels (0..1) of the old
     * and the new track — each already includes that track's own replay gain.
     */
    fun start(item: MediaItem, seconds: Double, outGain: Double, inGain: Double) {
        finishNow()   // a crossfade is already running: settle it first

        val out = active
        val requestedMs = (seconds * 1000).toLong().coerceAtLeast(0L)
        val duration = out.duration
        val remainingMs = if (duration == C.TIME_UNSET) -1L else duration - out.currentPosition
        val canFade = requestedMs > 0 &&
            out.playWhenReady &&
            out.playbackState == Player.STATE_READY &&
            remainingMs >= MIN_FADE_MS

        if (!canFade) {
            // Nothing to overlap with: just switch tracks.
            out.setMediaItem(item)
            out.volume = inGain.toFloat().coerceIn(0f, 1f)
            out.prepare()
            out.playWhenReady = true
            return
        }

        val inc = spare ?: createSpare().also { spare = it }
        inc.volume = 0f
        inc.setMediaItem(item)
        inc.prepare()
        inc.playWhenReady = true

        val fade = Fade(
            outgoing = out,
            incoming = inc,
            outGain = outGain.toFloat().coerceIn(0f, 1f),
            inGain = inGain.toFloat().coerceIn(0f, 1f),
            requestedMs = requestedMs,
            createdMs = SystemClock.elapsedRealtime()
        )

        // Anything that means "the user is now doing something with the new
        // track" ends the overlap early.
        val l = object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!playWhenReady) finishNow()      // paused, or focus lost (a call)
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int
            ) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK) finishNow()
            }

            override fun onPlayerError(error: PlaybackException) = finishNow()
        }

        // Hand the session (and audio focus) to the incoming player. Order
        // matters: the old player lets go of focus before the new one asks for
        // it, so neither ever sees a "focus lost" and pauses itself. The
        // listener goes on before the focus request so that a refused request
        // (someone else holds focus) also ends the overlap cleanly.
        makeActive(inc)
        out.setAudioAttributes(audioAttributes, /* handleAudioFocus = */ false)
        active = inc
        spare = null
        fading = fade
        fade.listener = l
        inc.addListener(l)
        inc.setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)

        handler.post(tick)   // does nothing if the overlap was just ended above
    }

    /** Ends any crossfade right now (used before an unrelated load). Safe any time. */
    fun cancel() = finishNow()

    /** Frees the spare player. [active] belongs to the session, which releases it. */
    fun release() {
        finishNow()
        spare?.release()
        spare = null
    }

    private val tick = object : Runnable {
        override fun run() {
            val f = fading ?: return
            val now = SystemClock.elapsedRealtime()

            if (f.startMs < 0) {
                // Keep the old track at full level until the new one is really
                // playing (a few ms for a local file), then start the clock.
                val ready = f.incoming.playbackState == Player.STATE_READY
                if (!ready && now - f.createdMs < READY_WAIT_MS) {
                    handler.postDelayed(this, STEP_MS)
                    return
                }
                val d = f.outgoing.duration
                val leftMs = if (d == C.TIME_UNSET) f.requestedMs else d - f.outgoing.currentPosition
                f.fadeMs = min(f.requestedMs, leftMs)
                if (f.fadeMs < MIN_FADE_MS) {
                    finishNow()
                    return
                }
                f.startMs = now
            }

            val t = ((now - f.startMs).toFloat() / f.fadeMs).coerceIn(0f, 1f)
            val angle = t * (PI / 2).toFloat()
            f.incoming.volume = sin(angle) * f.inGain      // equal-power: sin² + cos² = 1
            f.outgoing.volume = cos(angle) * f.outGain
            if (t >= 1f) finishNow() else handler.postDelayed(this, STEP_MS)
        }
    }

    /** Finishes or abandons the overlap: old player stopped, new one at full level. */
    private fun finishNow() {
        val f = fading ?: return
        fading = null
        handler.removeCallbacks(tick)
        f.listener?.let { f.incoming.removeListener(it) }
        f.incoming.volume = f.inGain
        f.outgoing.volume = 0f
        f.outgoing.stop()
        f.outgoing.clearMediaItems()
        spare = f.outgoing
    }

    private companion object {
        const val STEP_MS = 40L          // volume update interval
        const val MIN_FADE_MS = 300L     // not worth overlapping less than this
        const val READY_WAIT_MS = 1500L  // longest we hold the old track waiting for the new one
    }
}

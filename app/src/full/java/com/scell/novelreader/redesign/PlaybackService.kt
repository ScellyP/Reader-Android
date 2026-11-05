package com.scell.novelreader.redesign

import android.app.Notification
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.graphics.Color
import android.app.NotificationManager
import android.app.PendingIntent
import androidx.core.app.NotificationCompat
import android.content.Context
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaNotification
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.collect.ImmutableList

/**
 * Hosts the actual ExoPlayer instance and its MediaSession in a bound,
 * auto-promoted foreground Service — this is what makes real background
 * playback and lock-screen/notification controls possible, neither of
 * which a WebView <audio> element can do (Android suspends WebView media
 * once the Activity is backgrounded).
 *
 * MainActivity talks to this service exclusively through a
 * androidx.media3.session.MediaController built from this service's
 * SessionToken (see MainActivity.connectNativePlayer()) — it never binds
 * to this service directly. That indirection is what lets playback keep
 * running through MainActivity being destroyed/recreated (rotation,
 * task-switching): the Service and its ExoPlayer instance carry on
 * regardless of what happens to the Activity above them.
 *
 * MediaSessionService (Media3 1.1+) automatically:
 *   - builds and updates the system media notification (play/pause,
 *     artwork, title/artist) from the MediaSession + current MediaItem's
 *     metadata — no manual NotificationCompat code needed
 *   - promotes itself to a foreground service while isPlaying is true,
 *     and demotes when playback pauses/stops
 *   - responds to lock-screen and Bluetooth/headset media-button events
 *   - requests/releases audio focus, and (with setHandleAudioBecomingNoisy
 *     below) pauses automatically when headphones are unplugged
 * We only need to configure the player correctly and keep MediaItem
 * metadata populated — the framework does the rest, EXCEPT for
 * Next/Previous, which needs QueueAwarePlayer below.
 */

/**
 * DefaultMediaNotificationProvider marks the notification dismissible
 * (swipe-away) the moment playback is paused — deliberate platform
 * behavior (matches Spotify/YouTube Music), tied directly to
 * Notification.FLAG_ONGOING_EVENT being dropped when the player isn't
 * actively playing. There's no public toggle to keep it non-dismissible
 * while paused; the supported way to change it is exactly this —
 * wrap the provider, let it build the notification normally, then
 * add the flag back before it's posted. Because the default provider's
 * createNotification() is final, this wraps (delegates to) a
 * DefaultMediaNotificationProvider and implements the
 * MediaNotification.Provider interface directly instead of subclassing.
 */
@UnstableApi
private class AlwaysOngoingMediaNotificationProvider(
    private val delegate: DefaultMediaNotificationProvider
) : MediaNotification.Provider by delegate {

    constructor(context: Context) : this(
        DefaultMediaNotificationProvider(context).apply {
            // Proper monochrome status-bar glyph (the launcher icon renders
            // as a solid blob there).
            setSmallIcon(R.drawable.ic_stat_music)
        }
    )

    // DefaultMediaNotificationProvider.createNotification() is final in
    // media3 1.4.x, so it can't be overridden by subclassing. Instead we
    // wrap the default provider (delegation) and only intercept this one
    // method; handleCustomCommand() is forwarded automatically.
    override fun createNotification(
        mediaSession: MediaSession,
        customLayout: ImmutableList<CommandButton>,
        actionFactory: MediaNotification.ActionFactory,
        onNotificationChangedCallback: MediaNotification.Provider.Callback
    ): MediaNotification {
        val built = delegate.createNotification(
            mediaSession, customLayout, actionFactory, onNotificationChangedCallback
        )
        val n = built.notification
        n.flags = n.flags or Notification.FLAG_ONGOING_EVENT

        // Modern look: tint and colourise the notification from the cover
        // art (a deep shade of its dominant colour), falling back to the
        // app's amber accent. Android 13+ restyles media notifications
        // itself; this covers older versions and the tinted accents.
        val art = mediaSession.player.mediaMetadata.artworkData
        n.color = art?.let { dominantColor(it) } ?: ACCENT_FALLBACK
        n.extras.putBoolean("android.colorized", true)
        return built
    }

    private companion object {
        const val ACCENT_FALLBACK = 0xFFE8A83E.toInt()

        /** Average colour of a tiny decode of the art, darkened so the
         * white notification text always has strong contrast. */
        fun dominantColor(bytes: ByteArray): Int? {
            return try {
                val opts = BitmapFactory.Options().apply { inSampleSize = 16 }
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
                var r = 0L; var g = 0L; var b = 0L; var count = 0L
                for (x in 0 until bmp.width) for (y in 0 until bmp.height) {
                    val c = bmp.getPixel(x, y)
                    r += Color.red(c); g += Color.green(c); b += Color.blue(c); count++
                }
                if (count == 0L) return null
                val hsv = FloatArray(3)
                Color.RGBToHSV((r / count).toInt(), (g / count).toInt(), (b / count).toInt(), hsv)
                hsv[1] = (hsv[1] * 1.1f).coerceAtMost(1f)
                hsv[2] = (hsv[2] * 0.55f).coerceIn(0.18f, 0.5f)
                Color.HSVToColor(hsv)
            } catch (e: Exception) {
                null
            }
        }
    }
}

class PlaybackService : MediaSessionService() {

    /**
     * Why this exists: JS (audio-player.js's PlaybackQueue) owns the
     * play order — shuffle, repeat, what's next — and native only ever
     * has ONE MediaItem loaded (whatever JS just told it to load; see
     * MainActivity's nativeAudioLoad()). That keeps queue logic in one
     * place instead of duplicated in Kotlin.
     *
     * The cost: ExoPlayer itself has no next/previous item to seek to,
     * so it reports COMMAND_SEEK_TO_NEXT/PREVIOUS as unavailable, and
     * Media3's automatic notification simply omits those buttons. Since
     * the brief explicitly asks for a working Next button in the
     * notification, this ForwardingPlayer wrapper overrides the
     * *reported availability* of those commands (always true) and
     * *intercepts the calls themselves* — instead of asking the
     * underlying ExoPlayer to seek to a media item that was never
     * given to it, it calls back into MainActivity, which advances the
     * JS queue and loads the new track exactly like an in-app tap on
     * the Next/Previous buttons would.
     *
     * This is the standard Media3 pattern for "an external queue
     * manager should still drive the session's transport controls".
     */
    private inner class QueueAwarePlayer(player: Player) : ForwardingPlayer(player) {
        override fun isCommandAvailable(command: Int): Boolean {
            if (isQueueNavigationCommand(command)) return true
            return super.isCommandAvailable(command)
        }

        override fun getAvailableCommands(): Player.Commands {
            return super.getAvailableCommands().buildUpon()
                .add(Player.COMMAND_SEEK_TO_NEXT)
                .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                .build()
        }

        override fun seekToNext() = queueNavigationListener?.onSkipToNext() ?: Unit
        override fun seekToNextMediaItem() = queueNavigationListener?.onSkipToNext() ?: Unit
        override fun seekToPrevious() = queueNavigationListener?.onSkipToPrevious() ?: Unit
        override fun seekToPreviousMediaItem() = queueNavigationListener?.onSkipToPrevious() ?: Unit

        private fun isQueueNavigationCommand(command: Int): Boolean {
            return command == Player.COMMAND_SEEK_TO_NEXT ||
                command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ||
                command == Player.COMMAND_SEEK_TO_PREVIOUS ||
                command == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
        }
    }

    interface QueueNavigationListener {
        fun onSkipToNext()
        fun onSkipToPrevious()
    }

    companion object {
        /**
         * A single-process app (Service and Activity both run in-process
         * here, confirmed by the absence of android:process on either
         * manifest entry) makes a plain static callback the simplest
         * correct way for the Service to reach back into MainActivity —
         * no AIDL/Messenger cross-process plumbing needed. MainActivity
         * sets this in onCreate() (once its WebView exists) and clears it
         * in onDestroy() to avoid leaking the Activity through it.
         */
        var queueNavigationListener: QueueNavigationListener? = null

        /**
         * Loudness effect (replay-gain boost) attached to the ExoPlayer's audio
         * session (see NativeAudioEffects). Same single-process reasoning as
         * queueNavigationListener: MainActivity's bridge methods reach it
         * directly. Null while the service isn't running.
         */
        @Volatile
        var effects: NativeAudioEffects? = null

        /**
         * Crossfade between tracks (see NativeCrossfade). Same single-process
         * reasoning as [effects]: MainActivity's bridge reaches it directly.
         * Null while the service isn't running. Main thread only.
         */
        @Volatile
        var crossfade: NativeCrossfade? = null

        // How long the service may sit with nothing playing before it
        // shuts itself (and its notification) down.
        private const val IDLE_STOP_MS = 10 * 60 * 1000L

        // Wear OS controllers allowed to connect to the media session (see
        // isAllowedController). Only the Google Wear OS companion app is
        // listed; add the package of any other watch app you use.
        private val WEAR_CONTROLLER_PACKAGES = setOf("com.google.android.wearable.app")
    }

    private var mediaSession: MediaSession? = null

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()

        setMediaNotificationProvider(AlwaysOngoingMediaNotificationProvider(this))

        // USAGE_MEDIA + CONTENT_TYPE_MUSIC tells the platform (and
        // other apps) this is music-like playback for audio
        // focus/ducking — it ducks briefly for a notification sound
        // rather than pausing outright, same as any music app.
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            // Pauses automatically when headphones/Bluetooth disconnect —
            // without this, playback would keep going out loud through
            // the phone speaker the moment headphones are unplugged.
            .setHandleAudioBecomingNoisy(true)
            .build()

        // The loudness boost attaches to the player's audio session. The provider
        // is called lazily, always from the main thread (see NativeAudioEffects).
        effects = NativeAudioEffects { player.audioSessionId }

        // Crossfade needs a second player. It is created on first use, shares
        // this player's audio session (so the loudness boost above covers both) and
        // does NOT handle audio focus until the session is handed to it — see
        // NativeCrossfade. The session id is read lazily: it is the one the
        // effects are attached to.
        crossfade = NativeCrossfade(
            active = player,
            audioAttributes = audioAttributes,
            createSpare = { createSparePlayer(audioAttributes, player.audioSessionId) },
            makeActive = { p -> mediaSession?.player = QueueAwarePlayer(p) }
        )

        // Tapping the notification (or the lock-screen player) brings this
        // app's own MainActivity to the front. Without a session activity
        // the system falls back to a generic media-app handler instead.
        // SINGLE_TOP + CLEAR_TOP reuses the running instance rather than
        // recreating the reader, so the reading position isn't lost.
        val openAppIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        mediaSession = MediaSession.Builder(this, QueueAwarePlayer(player))
            .setSessionActivity(openAppIntent)
            .setCallback(object : MediaSession.Callback {
                // Second gate (onGetSession is the first): a controller that
                // is not on the allow-list is turned away here as well.
                override fun onConnect(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo
                ): MediaSession.ConnectionResult =
                    if (isAllowedController(session, controller)) {
                        MediaSession.ConnectionResult.AcceptedResultBuilder(session).build()
                    } else {
                        MediaSession.ConnectionResult.reject()
                    }
            })
            .build()

        // Close the service (and remove its notification) after 10 minutes
        // with nothing playing.
        player.addListener(idleListener)
        updateIdleTimer()
    }

    // On both players: after a crossfade the session's player is the other one.
    // updateIdleTimer() always looks at whichever is in the session now.
    private val idleListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) = updateIdleTimer()
        override fun onPlaybackStateChanged(playbackState: Int) = updateIdleTimer()
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = updateIdleTimer()
    }

    /** The second player used by NativeCrossfade. */
    @OptIn(UnstableApi::class)
    private fun createSparePlayer(attributes: AudioAttributes, audioSessionId: Int): ExoPlayer =
        ExoPlayer.Builder(this)
            .setAudioAttributes(attributes, /* handleAudioFocus = */ false)
            .setHandleAudioBecomingNoisy(true)
            .build()
            .also {
                it.audioSessionId = audioSessionId
                it.addListener(idleListener)
            }

    private val idleHandler = Handler(Looper.getMainLooper())
    private val idleStopRunnable = Runnable {
        val p = mediaSession?.player
        if (p == null || !isPlaybackActive(p)) {
            getSystemService(NotificationManager::class.java)?.cancelAll()
            stopSelf()
        }
    }

    private fun isPlaybackActive(p: Player): Boolean =
        p.isPlaying || (p.playWhenReady && p.playbackState == Player.STATE_BUFFERING)

    private fun updateIdleTimer() {
        idleHandler.removeCallbacks(idleStopRunnable)
        val p = mediaSession?.player ?: return
        if (!isPlaybackActive(p)) idleHandler.postDelayed(idleStopRunnable, IDLE_STOP_MS)
    }

    /**
     * The service is exported (the system and Bluetooth/Android Auto must be
     * able to bind to it), so any app on the phone can try to connect and
     * control playback or see what is playing. Only these callers get the
     * session; everything else is refused:
     *   - this app itself (its MainActivity's MediaController);
     *   - the system's media notification / lock-screen controller;
     *   - other trusted system controllers (media buttons, Bluetooth,
     *     system UI) as decided by Media3's `isTrusted`;
     *   - Android Auto (phone-side companion and the car/automotive side);
     *   - Wear OS controllers, recognised by the package names listed in
     *     WEAR_CONTROLLER_PACKAGES below.
     */
    @OptIn(UnstableApi::class)
    private fun isAllowedController(
        session: MediaSession,
        controller: MediaSession.ControllerInfo
    ): Boolean =
        controller.packageName == packageName ||
            controller.isTrusted ||
            session.isMediaNotificationController(controller) ||
            session.isAutoCompanionController(controller) ||
            session.isAutomotiveController(controller) ||
            WEAR_CONTROLLER_PACKAGES.contains(controller.packageName)

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        val session = mediaSession ?: return null
        return if (isAllowedController(session, controllerInfo)) session else null
    }

    /**
     * Called when the user swipes the app away from recents. If nothing
     * is actively playing at that point there's no reason to keep the
     * service (and its ExoPlayer instance) alive — stop it. If
     * something IS playing, deliberately do nothing, so playback (and
     * the notification) survives the swipe, same as any standard music
     * app.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = mediaSession?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        idleHandler.removeCallbacks(idleStopRunnable)
        crossfade?.release()
        crossfade = null
        effects?.release()
        effects = null
        mediaSession?.run {
            player.release()
            release()
            mediaSession = null
        }
        super.onDestroy()
    }
}

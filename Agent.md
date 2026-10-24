# Agent.md — Developer / AI Notes

This file is for AI agents and developers working on Novel Reader.
User/install/usage docs are in [README.md](README.md).

## Project map

Key files:

- `app/src/main/assets/index.html` — main app UI.
- `app/src/main/assets/reader.js` — reading UI, gestures.
- `app/src/main/assets/audio-player.js` — audio UI, queue, engines, audio feature framework.
- `app/src/main/assets/spotify-ui.js` — Spotify-kit music panel glue: switches the library (shown as **Home**) / songs / now-playing views, mirrors player state into the mini player and "..." sheet, and builds the Home screen (greeting, quick tiles, shelves) from the player's own playlist rows, which stay in the page, hidden — every tap on a tile/card is forwarded to its row (`row.click()`), so `audio-player.js` still owns all selection logic. The panel opens on Home. The pure helpers (`greetingForHour`, `planHome`, `captionFor`) are exported for the tests. Playlist covers are remembered per playlist name (`coverUrlByName`) and put straight back on rebuilt rows (`restoreRowCovers`): a rescan rebuilds every row without a cover, and the cover pass used to skip the work when the library looked unchanged, so the thumbnails vanished. Styles are the `spotify-kit` block in `index.html`; `audio-player.js` is untouched apart from two-line queue rows.
- `app/src/main/assets/song-download.js` — the "Download songs" sheet in the music panel (button in the Library hero, sheet `#dl-sheet` in `index.html`). Paste links, pick a playlist (folder) chip or "+ New playlist", press Download; jobs run one at a time and each shows Waiting / Downloading / Done / Failed (Retry), with a Stop button. This is the page half. The contract: the page calls `AndroidBridge.downloadSong(jobId, url, folder)` (folder `""` = no playlist; returns `false` only while another job still runs) and optionally `AndroidBridge.cancelSongDownload()`; the native side answers with `window.onSongDownloadStatus(jobId, "running"|"done"|"failed", message)`, exactly one done/failed per job. Without the native hook a job fails at once with "Not connected to Termux yet". After a batch with at least one song, `NovelAudio.rescan()` refreshes the library. Playlist names are cleaned in the page (`cleanFolderName`: letters, digits, space and `_ - ( ) . & ' ,` only) and again natively and in the script; they are always separate arguments, never joined into a shell string. The pure helpers (`parseLinks`, `cleanFolderName`, `createQueue`, `shortLink`) are exported for `tests/song-download.test.js`. `audio-player.js` has two small public methods for it, `getPlaylists()` and `rescan()`.
- `app/src/main/java/.../SongDownloader.kt` — the native half of the sheet, wired up in `MainActivity.kt` (`songDownloader`, the two `@JavascriptInterface` methods `downloadSong` / `cancelSongDownload`, `register()` in `onCreate`, `release()` in `onDestroy`, and `closeRunnable` does not close the app while `isBusy()`). Each job is sent to Termux through its RUN_COMMAND service (`com.termux.app.RunCommandService`, background mode): `python -c <song_dl.py> URL [playlist]`. The script is read from the app's assets and passed as the `-c` argument, so there is no copy in shared storage that another app could change, and nothing to install by hand. Termux answers through a mutable `PendingIntent` broadcast (the `result` bundle: `stdout`, `stderr`, `exitCode`, `err`, `errmsg`); the last `RESULT {...}` line of `stdout` becomes the status sent to the page, anything else falls back to `errmsg` / the last `stderr` line. A 15-minute watchdog fails a job Termux never answers (typically `allow-external-apps` not set). **Stop:** RUN_COMMAND cannot stop a command, so `song_dl.py` keeps its process id in `$TMPDIR/song_dl.pid` and `cancel()` runs a small `sh -c 'kill -TERM "$(cat …)"'` through Termux; the script then reports `Stopped`. Needs `com.termux.permission.RUN_COMMAND` (manifest; a runtime permission that Termux defines — the first job fails with a hint, asks for it, and Retry works), Termux from F-Droid/GitHub, and the `<queries>` entry for `com.termux` that already exists. Starting another app's service is refused on Android 12+ while this app is in the background, so a queue only keeps going while the app is open (the job then fails with "Keep Novel Reader open…"). **The Kotlin was written without being compiled or run — test it on a device.**
- `app/src/main/assets/song_dl.py` — the script that downloads one song with yt-dlp (mp3, metadata and cover art embedded, one URL per run, playlist as a separate argument cleaned like `cleanFolderName`). Its last output line is always `RESULT {"status": "done"|"failed", "message": "..."}`; exit code 0/1. SIGTERM stops yt-dlp/ffmpeg and reports `Stopped`. Runs on its own too: `python song_dl.py URL "Playlist"` in Termux. Environment variable `NOVEL_AUDIO_DIR` overrides the output folder (used by the checks). Keep `clean_folder()` identical to `cleanFolderName()`; `tests/song-download.test.js` compares them.
- `app/src/main/assets/settings-file.js` — mirrors settings to `/storage/emulated/0/Novel/settings.txt`.
- `app/src/main/assets/version.js` — `APP_VERSION`.
- `app/src/main/assets/color-wheel.js` — Page/Text colour wheel.
- `app/src/main/assets/moon-theme.js` — fills the `[data-moon]` phase badges. The rest of the moon/space theme is CSS in `<style id="moon-theme">` in `index.html` (`.sky` starfield, ornaments, splash moon).
- `MainActivity.kt` — Android host, hardcoded `novelRoot` (one subfolder per novel), `connectNativePlayer()`, `runAudioScan()`.
- `PlaybackService.kt` — Media3 foreground service, `QueueAwarePlayer`, notification controls.
- `NativeAudioEffects.kt` — native loudness boost (positive replay gain).
- `AdaptiveBrightness.kt` — the "Adaptive brightness" setting: light sensor → this window's brightness (log curve, smoothed). The Kotlin was written without being compiled or run; test it on a device.
- `NativeCrossfade.kt` — native crossfade: two ExoPlayers, equal-power ramp, session hand-over.
- `ReplayGainReader.kt` — reads ReplayGain tags from the file bytes (pure `java.io`, testable on a plain JVM).
- `tests/index-html.test.js` — structure of `index.html`: no id used twice (a `<style id>` clashing with an icon id once left the Home tab icon blank), every `<use href>` and every `svgIcon()`/`makeIcon()` name has a `<symbol>`, every script file is loaded
- `tests/chapter-swipe.test.js` — the swipe-up gesture (9 checks)
- `tests/song-download.test.js` — link parsing, playlist-name cleaning (also compared with `clean_folder` in `song_dl.py` when `python3` is installed), the download queue, and that the bridge names, `song_dl.py` and the manifest permission agree (12 checks; the sheet itself needs a page and `SongDownloader.kt` needs a device, so neither is covered)
- `tests/spotify-home.test.js` — the Home screen (greeting, tile/shelf plan, tap forwarding, delete confirm, covers; 11 checks) and `tests/spotify-covers.test.js` (covers survive a rescan and are drawn at 384 px so they stay sharp; 4 checks), both on `tests/spotify-harness.js`, a small fake page for `spotify-ui.js`
- `tests/audio-gestures.test.js` — shuffle-starts-playing and `likeCurrent()` (8 checks; run with `node tests/audio-gestures.test.js`)
- `tests/audio-harness.js` — shared by the audio tests: boots `audio-player.js` with stubbed globals and a fake Android bridge
- `tests/audio-startup.test.js` — last-song restore and Bluetooth start-up (11 checks, with a fake Android bridge; run with `node tests/audio-startup.test.js`)
- `tests/audio-player.smoke.test.js` — `audio-player.js` loads under Node with stubbed globals; no playback-speed code remains (run with `node tests/audio-player.smoke.test.js`)

These are the only tests in the repo. Earlier notes mentioned tests for the audio
feature framework, crossfade and ReplayGain (JS and the Kotlin tag reader); those
files are not present, so that code
is currently unchecked by anything automated.

## Version number

> **For any AI assistant / future chat working on this project:** bumping
> the version is part of every bug fix or feature. Do it automatically in
> the same change, without being asked, and state the new version in your
> reply.

The current version is shown at the bottom of the side menu (e.g. `v1.00.00`).
It lives in one place only: `APP_VERSION` in `app/src/main/assets/version.js`,
and you change it by hand — nothing bumps it automatically.

Format: `v MAJOR . MID . MINOR`

| Part | When it changes |
| --- | --- |
| **MAJOR** (the `1`) | Stays the same until *you* decide to change it |
| **MID** (middle) | +1 for a major update (e.g. a new feature), **or** when minor bug fixes pass 99. MINOR resets to `00` |
| **MINOR** (last) | +1 for every minor bug fix |

Examples: `v1.00.00` first tracked version → `v1.00.01` one small fix →
`v1.01.00` a new feature → `v1.01.99` then one more fix rolls over to
`v1.02.00`.

**Broken builds never change the version.** If a build fails or has to be
redone, the number stays as it is; only a real shipped fix or feature bumps
it. This is separate from Android's `versionCode`/`versionName` in
`app/build.gradle`, which follows the GitHub Actions run number so each APK
installs over the last one.

## Build trigger (GitHub Actions)

`.github/workflows/build-apk.yml` has two jobs. `check` runs on every push to
`main`/`master` and decides; `build` only runs when `check` outputs
`should_build=true`. A push builds when **either** holds:

1. it is a manual run (`workflow_dispatch`), or
2. a version number matching `v<digits>.<digits>.<digits>` appears in any pushed
   commit message (e.g. `v1.04.02: fix volume keys`).

Nothing else builds: there is no `[build]` / `[skip build]` switch and tags do not
trigger it (GitHub's own `[skip ci]` still skips the whole workflow). Commit
messages are passed to the script through environment variables, never
interpolated into the shell, so keep it that way. `versionCode` is
`GITHUB_RUN_NUMBER`; skipped pushes use up numbers, which only leaves gaps.

When you give the owner a change, suggest a commit message that starts with the
new `APP_VERSION` number (e.g. `v1.04.02`) so the push builds; for docs-only or
CI-only changes, suggest a message without a version number.

## Packaging rule for generated packages

Every zip package generated for this app must contain **one top-level folder
named `novelreader`**, with the whole project inside it (`app/`, `.github/`,
`README.md`, ...). Do not use other folder names such as `Novel-Reader-2-master`.
When uploading to GitHub, copy the *contents* of `novelreader/` into the repo
root so that `app/src/main/assets/index.html` and `.github/workflows/` sit at the
top level of the repo.

## Chapter format and ordering

Chapter files are read either in the original `chapter_downloader.py`
format (title / `Source:` line / `====` separator / body; the `Source:`
line is skipped and never shown) or as plain
text files — either works.

**Chapter order** comes from the chapter number in each file's actual
title (the first line of its content — e.g. "Chapter 2004: Seeds of
Rebellion"), not from the filename or whatever order the filesystem/Files
app happens to list them in. Renaming files, an inconsistently-named
download batch, or the OS returning them in a different order won't
change reading order as long as the real title still has a number in it.
Chapters with no number in their title (a Prologue/Epilogue, say) sort
after every numbered chapter, in filename order.

## Settings file

Saved settings (appearance, music player, reading-session limits, last novel)
are mirrored to `/storage/emulated/0/Novel/settings.txt` and read back on
startup (see `app/src/main/assets/settings-file.js`). One `key = value` per
line, values as JSON; lines starting with `#` are comments. Edit it while the
app is closed; delete a line to reset that setting.

## Audio player architecture

> **NOTE:** the feature list below was **proposed, not specified.** This
> README originally said only "music player removed entirely" and
> contained no feature list, so this is a starting point to be edited
> rather than a requirement that came from anywhere. Change it freely.

The goal is a hybrid: **VLC's playback reliability with Spotify's user
experience.** Two playback engines share one UI/queue: a WebView `<audio>`
element (works everywhere, including outside the Android app) and a real
ExoPlayer instance running in a Media3 foreground service (true background
playback, lock-screen/notification controls). The app starts on the
former and switches to the latter automatically the moment it's ready —
mid-playback, at the same position, inaudibly. See `audio-player.js`'s
top-of-file comment for the architecture, and `PlaybackService.kt` /
`MainActivity.kt`'s `connectNativePlayer()` for the native half.

### Audio player feature status

**From VLC — playback that just works**

| Feature | Status |
| --- | --- |
| Broad format support (mp3, m4a/aac, flac, ogg, opus, wav) | **Working** |
| Near-gapless playback (next track pre-buffered) | **Working**¹ |
| Playback speed with pitch preservation | Removed — the speed control is gone; playback is always 1× |
| Volume normalisation (replay gain) | **Working**⁴ — off / track / album, from the ReplayGain tags in your files |
| Resume-at-position per track | Removed — every track starts at 0 (only a live engine hand-off keeps its position) |
| Remember the last song | **Working**⁶ — saved as `lastTrackId` in the audio prefs (so in `settings.txt`) every time a track starts; the next launch's first scan (`MediaLibrary.onScanned`) makes it the current song, not started, from 0. Dropped back to "All songs" if it is outside the saved playlist; ignored if the file is gone |
| Start by itself over Bluetooth | **Working**⁶ — `StartupPlayback` in `audio-player.js` waits for the first library scan *and* the native player, then, if `AndroidBridge.isBluetoothAudioConnected()` is true, plays the current song (or the first in the queue). Once per page load; skipped for an empty library or if something is already playing |
| A-B repeat | **Working** — A / B buttons under the seek bar |
| Graceful handling of unplayable files (skip, don't stall) | **Working** |

**From Spotify — how it feels to use**

| Feature | Status |
| --- | --- |
| Library scan (native folder scan + tags) | **Working** |
| Playlists via folders (a subfolder in Audio/ = a playlist) | **Working** |
| Curated playlists (hand-picked, not tied to a folder) | **Working** — "New playlist" in the Library, plus add-to-playlist |
| Visible "up next" queue | **Working** |
| Shuffle (real Fisher-Yates) + repeat (off / all / one) | **Working** — tapping shuffle (either shuffle button) while nothing plays turns it on *and* starts a random song (`setShuffle(true, false)` so a paused/remembered song is not pinned first); while playing it only reshuffles; turning it off never starts anything |
| Double-tap to like | **Working** — `reader.js` (touchend handler): two taps within 280 ms and 48 px in the middle 40% × 40% of the reading pane call `NovelAudio.likeCurrent()` (add-only) and show the `#like-pop` heart. The first tap there is held back 280 ms so the double tap doesn't also scroll the page; this delay applies only while a song is current (`hasCurrentTrack()`). **The gesture wiring in `reader.js` is not covered by a test** (only the player half is); try it on a device |
| Swipe up on the chapter switcher | **Working** — `chapter-swipe.js` (attached by `reader.js`, loaded before it): listens on the whole document; a touch that starts on `#bottom-nav` (the Previous / Next bar), or within 16 px of it, and travels up at least 30 px steeper than 50° from horizontal opens the music panel, but only while no menu is open. Judged from the last position seen, so it still works when the browser takes over the drag and cancels the touch. Covered by `tests/chapter-swipe.test.js`; the wiring in `reader.js` is not, so try it on a device |
| Swipe up on the library ("Switch novel" screen) | **Working** — the same `chapter-swipe.js`, attached a second time by `reader.js` to `#novel-picker-player-hint`, a transparent handle fixed to the bottom of the library (it only shows while the library is open). A swipe up that starts on it, or within 16 px, opens the music panel *on top of* the library: while the library is open `body.picker-open` lifts `#audio-panel` above it (z 160 vs 150). Back, the ✕ or a swipe right closes the player and returns to the library (`handleBack` closes the panel before the library). Both swipe-up openings (this one and the chapter bar) make the panel rise from the bottom: `reader.js` `setAudioEntrance(true)` adds `.from-bottom` (translateY instead of the usual translateX from the right) while the panel is still hidden; the 🎧 buttons remove it so they still slide in from the right. The chapter-bar swipe is switched off while the library is open so the two never both fire. **The wiring in `reader.js` is not covered by a test**; try it on a device |
| Now-playing bar with artwork, seek scrubber | **Working** |
| Crossfade between tracks | **Working**⁵ — 🎧 panel → Crossfade slider, 1–12 s (native engine: built, see footnote) |
| Recently played / liked tracks | **Working** — heart button on the now-playing card; "Recently played" and "Liked" in the Library |

**Reader-specific / background playback**

| Feature | Status |
| --- | --- |
| Sleep timer (fixed minutes, or end-of-track), with a fade-out | **Working** |
| Auto-pause when a reading-break reminder appears, and resume on dismiss | **Working** |
| True background playback (screen off, app switched away) | **Working** |
| System media notification (artwork, title/artist, play/pause) | **Working** |
| Notification Next/Previous buttons | **Working**³ |
| Lock-screen transport controls, Bluetooth/headset buttons | **Working** |
| Audio-focus handling (ducks/pauses for calls, other apps) | **Working** |
| Pauses automatically when headphones/Bluetooth disconnect | **Working** |

Audio files are expected in `/storage/emulated/0/Novel/Audio` (created
automatically on first scan if it doesn't exist). Tap 🎧 → "Scan the sky" to load it.

**Playlists** are just subfolders of `Audio/` — no separate playlist
file or in-app "create playlist" step. A folder's name becomes the
playlist name shown in the picker, and every audio file inside it
(nested subfolders included) belongs to that playlist:

```text
Novel/Audio/
  Lo-fi Focus/2AM.mp3        -> playlist "Lo-fi Focus"
  Lo-fi Focus/Rain.mp3       -> playlist "Lo-fi Focus"
  Podcasts/Ep1/part1.mp3     -> playlist "Podcasts" (still one level of
                                 grouping — a folder inside a playlist
                                 folder doesn't create a nested playlist)
  standalone-track.mp3       -> not in a playlist
```

The 🎧 panel's "Playlist" dropdown (hidden entirely when your library
has no subfolders, so it isn't clutter for a flat collection) switches
between "All songs" and each folder found — picking one rebuilds the
queue from just those tracks, so shuffle, repeat, and next/previous all
stay within it. A file sitting directly in `Audio/` (not in any
subfolder) still plays fine under "All songs", it just has no playlist
of its own to filter down to. While viewing "All songs" with more than
one playlist present, each row in the queue shows a small tag (shown in
capitals) naming which playlist it came from.

¹ "Near"-gapless: the next track's file is pre-buffered while the
current one plays, which removes the network/disk delay that causes
most audible gaps, but the transition is still a normal src-swap rather
than a sample-accurate crossfade-capable handoff.

² The native engine turns quiet tracks up with Android's `LoudnessEnhancer` on
ExoPlayer's audio session (`NativeAudioEffects.kt`); the WebView engine can
only turn a track down. **That native half was written without being compiled
or run** — test it on a device before relying on it.

³ ExoPlayer only ever holds one track at a time (JS owns the queue —
see `audio-player.js`'s architecture note), so it normally has no
"next item" to report and the standard notification omits those
buttons entirely. `PlaybackService.kt`'s `QueueAwarePlayer` — a
`ForwardingPlayer` that always reports Next/Previous as available and
routes taps back into the JS queue — is what makes them show up and
work despite that.

⁴ **Volume normalisation.** 🎧 panel → **Normalise**: Off / Track / Album. It
reads the ReplayGain tags already in your files (it does not analyse audio):
MP3/AAC with ID3v2 (`TXXX`) or APEv2 tags, FLAC and Ogg Vorbis/Opus comments
(Opus `R128_*_GAIN` too), and iTunes-style M4A atoms. The number next to the
selector is what is being applied to the current track; "no tag" means the file
has none and plays unchanged. Louder-than-normal tracks are turned down; a
quieter track is turned *up* only by the background (native) player, and never
past the point where its tagged peak would clip. Tag your files with a tool such
as foobar2000, MP3Gain, rsgain or beets. Tags are read when you tap **Rescan**.
`tests/replaygain.test.js` checks the gain maths; `tests/replaygain-reader/run.sh`
checks the tag reader against real files made with ffmpeg.

⁵ **Crossfade.** 🎧 panel → **Crossfade** slider: Off, or 1–12 s. The end of a
track overlaps the start of the next on an equal-power curve (loudness stays
steady through the overlap), and each track keeps its own replay-gain level. It
is skipped for repeat-one, the "stop at end of track" sleep mode, an A-B loop,
or a timed sleep that ends inside the overlap; a track shorter than twice the
setting crossfades over half its length. Pausing, seeking or choosing another
track ends the overlap at once. WebView engine: a second `<audio>` element and
two timed volume ramps. Native engine: a second ExoPlayer in `PlaybackService`
(`NativeCrossfade.kt`) that takes over the media session the moment the overlap
starts, sharing the audio session so the loudness boost covers both players. **The
Kotlin half was written without being compiled or run** — test it on a device
before relying on it.
`tests/crossfade.test.js` checks the JS side.

⁶ `isBluetoothAudioConnected()` (MainActivity.kt) looks for a Bluetooth music output in
`AudioManager.getDevices()` (A2DP, hearing aid, BLE headset/speaker; not the phone-call SCO link),
which needs no permission. **That Kotlin half was written without being compiled or run** — test
it on a device with a real Bluetooth device before relying on it.

## Audio feature framework

The optional audio features all hang off one small framework in
`audio-player.js` (section **7b. AUDIO FEATURES FRAMEWORK**), so adding or
finishing one doesn't mean threading changes through both engines.

**How it works.** The engines and queue stay feature-agnostic; they only
announce what happened, and feature *modules* react. Each module is a plain
object passed to `AudioFeatures.register()`:

```js
{
  id: 'abRepeat', label: 'A-B repeat', status: 'logic-ready',
  defaults: { a: null, b: null },   // per-feature state -> state.features[id]
  persistKeys: [],                  // optional; omit = save all, [] = save none
  trackStart(track) {}  trackEnd(track) {}  progress({positionSec, durationSec}) {}
  engineChanged(engine) {}  libraryChanged() {}
  outputGain(track) {}              // linear multiplier <= 1, folded into gain()
}
```

Every hook is optional and wrapped in try/catch, so a broken feature can
never stall playback. Per-feature state is saved inside the existing audio
prefs blob (so it is mirrored to `settings.txt` for free) and restored by
`Prefs.load()`; restore only accepts keys the module declares, with the same
type as the default. Modules are reachable as `NovelAudio.features.<id>`, and
`NovelAudio.features.describe()` lists them with their status.

**Where the hooks fire** (all one-liners in the core): `trackStart` — in each
engine's `play()` when a new track loads; `progress` — the WebView
`timeupdate` event (~4 Hz) and the native progress callback (~2 Hz, every 500 ms);
`trackEnd` — `handleTrackEnded()`; `engineChanged` — `_switchToNative()`;
`libraryChanged` — after a scan.

**Status vocabulary** — `working` (behaviour + UI), `logic-ready` (works
through the JS API, no control yet), `framework` (plumbing in place, needs
data or native support), `stub` (stores a value, nothing consumes it),
`planned` (hook exists, behaviour not written).

| Module (`NovelAudio.features.…`) | Status | What exists | Next step |
| --- | --- | --- | --- |
| `abRepeat` | working | `setA()`, `setB()`, `clear()`, `get()`; loops via `AudioEngine.seek()`; cleared on every new track; never persisted. Loop can overshoot B by up to ~0.5 s (progress rate) | A/B buttons are in place under the seek bar. Possible later: a marker on the seek bar. Frame-accurate looping would need a native `ClippingMediaSource` |
| `replayGain` | working | `setMode('off'/'track'/'album')`, `describe(track)` for the UI. Cuts go through `gain()`; boosts go to the native `LoudnessEnhancer`; honours the track/album peak so it never clips. Tags are read natively by `ReplayGainReader.kt` and added to each scanned track as `replayGainTrackDb` / `replayGainAlbumDb` / `replayGainPeak` / `replayGainAlbumPeak` | Test on a device (see footnote ⁴). Possible later: pre-amp for untagged tracks, an in-app scanner that computes gain for files with no tags |
| `crossfade` | working | `setSeconds()` (0–12, whole seconds), persisted; `curve(t)` = equal-power fade. When the track is within `seconds + 0.5 s` of its end it calls `AudioEngine.beginCrossfade(nextId, seconds)`; the engine returns `false` to be asked again next tick. On success the queue/state move to the next track immediately and the engine fades the old one out underneath. WebView: second `<audio>` + timed ramps. Native: second ExoPlayer (`NativeCrossfade.kt`) | Test the native half on a device (see footnote ⁵). Possible later: per-track fade-out points, a gapless (no-fade) mode |
| `history` | working | Newest-first, deduped, capped at 100, persisted; virtual playlist `@recent` | Done: "Recently played" appears in the Library |
| `likes` | working | `toggle(id?)`, `isLiked()`, `getIds()`; virtual playlist `@liked` | Done: heart button on the now-playing card |
| `customPlaylists` | working | `create/remove/addTracks/removeTrack/list`; virtual playlist `@list:<id>` | Done: "New playlist" editor and picker entries. Possible later: drag to reorder |
| `nativeEffects` | framework | Pushes the replay-gain boost to the native side on engine switch and track start | Verify on a device (see footnote ²) |

**Virtual playlists.** `state.activePlaylist` may be `'all'`, a folder name,
or `'@recent'`, `'@liked'`, `'@list:<id>'`. `MediaLibrary.currentSelectionIds()`
resolves the virtual ones through `AudioFeatures.selectionFor()`, dropping any
track no longer in the library, so shuffle/repeat/next/previous work on them
unchanged.

**Native bridge added for this** (Kotlin side in `NativeAudioEffects.kt`,
created and released by `PlaybackService`): `nativeAudioSetBoostDb(db)`.
`NativeAudioEffects` keeps the last boost and re-applies it if the audio
session changes or the service restarts.

**Native bridge for crossfade:** `nativeAudioCrossfade(path, title, artist, album,
seconds, outGain, inGain)` always ends with the new track playing (it just switches
if it cannot overlap) and starts playback itself. `PlaybackService.crossfade`
(`NativeCrossfade`) owns two ExoPlayers that share one audio session; only the
active one handles audio focus and sits in the `MediaSession`. During an overlap
`nativeAudioSetVolume` only updates the incoming track's target level. The progress
poll in `MainActivity` runs every 500 ms (it was 1000 ms) so the trigger is timely.

**Adding a feature:** register a module (copy `likes` for plain data, or
`abRepeat` for something that reacts to playback), list it in the table above
with an honest status, and add checks to `tests/audio-features.test.js`.

**Crossfade checks.** `tests/crossfade.test.js` covers the trigger rules, the equal-power curve, the WebView engine's two-element ramp (with a fake clock), the native bridge call, and the guards against stale progress/ended reports from the old track. Run it from the project root: `node tests/crossfade.test.js`.

**Tests.** `tests/audio-features.test.js` loads `audio-player.js` under Node
with stubbed browser globals and checks the framework (registry, persistence,
A-B loop, replay-gain maths, virtual playlists, crossfade trigger). Run it from the project root: `node tests/audio-features.test.js`.
It cannot exercise the Kotlin side or real audio.

**Colour wheel.** The Page and Text colour swatches in the Reading panel open a
colour wheel (`color-wheel.js`: hue/saturation wheel, brightness slider, hex field)
instead of the system colour dialog. The native colour inputs stay in the page as
the source of truth, so saving, recent colours and presets work as before.

## AI assistant instructions

- **Bump the version automatically** in the same change for every real bug fix or feature. State the new version in your reply. Follow `Agent.md#version-number`.
- **Broken builds never change the version.** If a build fails or is redone, leave the number alone.
- **Update `README.md`** for user-facing changes: setup, build steps, gestures, settings, visible features.
- **Update `Agent.md`** for internal changes: architecture, feature framework, native bridge, tests, versioning, packaging.
- **Keep tests updated.** Add or adjust checks in `tests/` when behaviour changes.
- **Follow the packaging rule.** Generated zips must contain one top-level folder named `novelreader`; GitHub uploads must put `app/src/main/assets/index.html` and `.github/workflows/` at repo root.
- **Suggest a commit message.** Start it with the new version (e.g. `v1.04.02: fix volume keys`) so the push builds. Docs/CI-only changes get a message with no version number, See `Agent.md#build-trigger-github-actions`.
- **Do not commit keystores.** Update signing is handled through GitHub secrets; see the "Signing and updates" section of `README.md`.
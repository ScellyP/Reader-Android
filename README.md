# Novel Reader — Android App

A native Android app version of the novel reader, with the layout bugs
(buttons disappearing/overflowing on small screens) fixed.

## What changed from the HTML template

- **Music player**: the original template's player was removed. An
  audio player is now being reintroduced as a framework — see
  "Audio player" below.
- **Chapters folder is hardcoded** to
  `/storage/emulated/0/Novel/Chapters` (internal storage → `Novel` →
  `Chapters`). The app reads directly from this fixed path using
  Android's "All files access" permission — no folder picker, no
  per-run selection. Create that folder, drop your `.txt` chapter
  files in it, grant the permission once, and the app auto-loads it
  every time it opens. Every other direct subfolder of `Novel/` is
  also picked up as its own novel in the picker — **except** `Audio/`,
  which is reserved for music (see "Audio player" below) and is never
  offered as a novel.
- **Layout fixes**: topbar buttons now shrink/scroll instead of
  disappearing off-screen; flex children have `min-width: 0` so they
  don't get clipped; the font-family dropdown is capped in width on
  narrow screens; bottom nav buttons wrap instead of overflowing.
- Dark theme only (matches your saved preference).

## Setting up your chapters folder

1. On your phone, open any file manager app.
2. Go to **Internal storage** (the root of your phone's storage, not
   an SD card).
3. Create a folder named `Novel`, then inside it a folder named
   `Chapters` — so the full path is:
   `/storage/emulated/0/Novel/Chapters`
4. Put your `.txt` chapter files directly inside `Chapters`.
5. Open the app and tap **"Grant storage access"** — Android will take
   you to a permission screen; enable **"Allow access to manage all
   files"** (or similarly worded) for Novel Reader, then go back.
6. The app will automatically read every `.txt` file in that folder,
   every time you open it — no need to pick anything again.

**Note:** because the folder is hardcoded, if you ever want to point
the app at a different location, that requires changing the path in
`MainActivity.kt` (search for `chaptersDir`) and rebuilding.

## How to build the APK

### Option A — From your phone, using GitHub Actions (no laptop needed)

1. Create a free account at [github.com](https://github.com) if you
   don't have one.
2. On github.com (use "Desktop site" in your phone browser if the
   mobile view is limited), tap **+ → New repository**, name it
   (e.g. `novel-reader`), and create it.
3. On the new repo's page, use **Add file → Upload files**. Your
   phone's file picker will open — select **all the files inside the
   unzipped `novelreader` folder** (some file-manager apps let you
   select a whole folder to drag in; if yours only lets you pick
   individual files, that's fine too, just make sure you keep the
   subfolders like `app/`, `.github/`, `gradle/` intact when
   selecting — most Android/iOS file browsers preserve folder
   structure when you drag a folder onto the GitHub upload box).
4. Scroll down, add a commit message, tap **Commit changes**. **A build
   only starts if the commit message contains a version number** such as
   `v1.04.05` (e.g. `v1.04.05: fix panel colours`). Commits without one
   are skipped, so ordinary edits never use up a build.
5. For a commit with a version number, GitHub Actions kicks off
   automatically because of the included
   `.github/workflows/build-apk.yml` — go to the repo's **Actions**
   tab to watch it. To build without a version in the message, use
   **Run workflow** there; a manual run always builds.
6. Wait 3-5 minutes for the green checkmark.
7. Open the completed run → scroll to **Artifacts** → download
   **novel-reader-release-apk** (a zip containing `app-release.apk`; this is
   the build to install and use). A second artifact, **novel-reader-debug-apk**
   (`app-debug.apk`), is built alongside it for diagnosing problems.
8. Unzip that on your phone and tap the `.apk` to install (Android
   will prompt you to allow "install unknown apps" for your browser
   or file manager the first time — that's normal for anything not
   installed via the Play Store).

If your phone's browser won't let you upload a whole folder in one
go, the most reliable phone-only alternative is the **Working Copy**
app (iOS) or **Termux + git** (Android) to push the folder as a real
git repository instead of using the web uploader.

### Option B — On a computer with Android Studio

1. Unzip this project.
2. Open Android Studio → **Open** → select the unzipped `novelreader`
   folder.
3. Let Android Studio sync Gradle (first time may download the Gradle
   wrapper + Android SDK components — needs internet).
4. Plug in your Android phone (with USB debugging enabled) or use an
   emulator, then click the green **Run ▶** button — or go to
   **Build → Build Bundle(s)/APK(s) → Build APK(s)** to get an
   installable `.apk` file you can copy to your phone.
5. The built APK will be at:
   `app/build/outputs/apk/debug/app-debug.apk` (or, for a release build via
   `./gradlew assembleRelease`, `app/build/outputs/apk/release/app-release.apk`).

## Using the app

1. Put your `.txt` chapter files in `/storage/emulated/0/Novel/Chapters`
   (see "Setting up your chapters folder" above).
2. Open the app, tap **"Grant storage access"** the first time to
   allow it to read that folder.
3. Chapters load into the sidebar automatically, sorted naturally.
   Tap one to read. Whenever the menu opens, the list scrolls so the
   chapter you're on sits near the top (for the last chapters of a
   novel it sits wherever the end of the list allows, still in view).
4. Use Prev/Next (top bar or bottom of chapter) to navigate, adjust
   font size/family in the top bar, and search chapters via the filter
   box in the sidebar.
5. Reading colours (🎨), bookmarks (🔖) and the session timer (⏱) live
   together in the sidebar header, next to the "Novels" title.

### Gestures

| Gesture | What it does |
| --- | --- |
| Tap the **top-right** quarter of the page | Scroll up |
| Tap the **bottom-right** quarter of the page | Scroll down |
| Tap anywhere on the **left half** | Nothing — left free for reading and selecting text |
| **Swipe left → right** (starting in the left half) | Open the chapter menu |
| **Swipe right → left** | Close the menu if open, otherwise next chapter |
| **Long-press** a paragraph | Bookmark that exact spot |

While any menu is open (the chapter drawer or any popup panel), page
gestures are suspended. A tap outside an open menu only closes it — it
never paginates, scrolls or changes chapter.

### Volume buttons

While reading, **Volume Up / Down scroll the page** (same distance as a tap).
They turn themselves off — and change the normal media volume instead — whenever
a menu is open (the chapter drawer or any popup panel, including the audio
player; the audio panel's volume bar follows along). You can also switch the
scrolling off for good with **Volume button scroll** in the 🎨 panel; then the
buttons always change the volume.

**Volume keys in audio player** (🎨 panel, right under Smart scroll) is on by
default: with the audio player open, the buttons change the media volume. Switch
it off and they keep scrolling the page even while the audio player is open (any
other open menu still gives them to the volume). The setting is saved in
`settings.txt` as `audioVolumeKeys`.

How far a tap-to-scroll moves the page is adjustable: 🎨 → "Tap-to-scroll
amount" (in the same panel as the reading colours), measured in lines of
the current text rather than a fixed screen fraction, so it stays
consistent across font sizes and devices.

### Reading session limit

Open it with the ⏱ button in the sidebar header. Two modes:

- **Timer** — dial in `HH:MM:SS` and press Start. Tap a card to choose
  which unit the dial edits, then drag around the ring, the same as a
  phone Clock app. The countdown only runs while the app is in the
  foreground, so time in other apps is never counted against you. It
  survives a restart, coming back paused rather than running.
- **Daily time** — a break reminder at a fixed clock time every day. It
  uses the same dial as the countdown: pick Hours and Minutes (24-hour dial,
  the centre also shows the 12-hour reading, so `00:00` reads `12:00 AM`),
  then press **Set reminder**. It only fires when the clock actually reaches
  that time while the app is open (or the first moment you return to the app
  after it passed), once per day. Picking a time that already passed today,
  re-setting it, or just opening the app never triggers it — it waits for the
  next occurrence. Switching between the two tabs never arms or disarms
  anything; only **Start** / **Set reminder** do.

### Night lock

Between **12:00 AM and 6:00 AM** the app locks itself: a full-screen
"Time to sleep" screen covers everything, music is paused, and the Android
back button just leaves the app. It lifts by itself at 6:00 AM. On Sundays,
the 1st/3rd/5th Saturdays, and the listed holidays, tapping the moon advances
its phase and spreads cracks across the lock screen. Reaching the hidden
50–100 tap target unlocks the app for one hour. The unlock is kept by the app
natively (`MoonUnlockStore.kt`): a record in app-private storage, signed with
a key in the Android Keystore and timed on the phone's monotonic clock, so
editing the page's storage or changing the phone's date/time cannot stretch the
hour. It also allows native background audio. After it expires, the night lock
returns if it is still before 6:00 AM. A restart of the phone ends an unlock in
progress, and if the record cannot be saved or verified the app stays locked.
(The 12:00 AM to 6:00 AM window itself still follows the phone's clock.) Other days show an inactive full moon. The lock
window is set by `NIGHT_LOCK_START` / `NIGHT_LOCK_END` in `reader.js` and
follows the phone's local clock. On active days, four edge impacts (one per
side) grow in randomized order with 26 rays each. Shaded triangular facets,
impact flashes, and a progress-scaled screen shake deepen the effect; reaching
100% inverts the screen and leaves contrasting crack lines.

## Audio player

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

**From VLC — playback that just works**

| Feature | Status |
| --- | --- |
| Broad format support (mp3, m4a/aac, flac, ogg, opus, wav) | **Working** |
| Near-gapless playback (next track pre-buffered) | **Working**¹ |
| Playback speed with pitch preservation | Removed — the speed control is gone; playback is always 1× |
| 10-band equalizer + preamp | **Working**² (native engine: built, see footnote) |
| Volume normalisation (replay gain) | **Working**⁴ — off / track / album, from the ReplayGain tags in your files |
| Resume-at-position per track | Removed — every track starts at 0 (only a live engine hand-off keeps its position) |
| A-B repeat | **Working** — tap **A** then **B** under the seek bar to loop that section; ✕ clears it |
| Graceful handling of unplayable files (skip, don't stall) | **Working** |

**From Spotify — how it feels to use**

| Feature | Status |
| --- | --- |
| Library scan (native folder scan + tags) | **Working** |
| Playlists via folders (a subfolder in Audio/ = a playlist) | **Working** |
| Curated playlists (hand-picked, not tied to a folder) | **Working** — add the playing track from the add-to-playlist button, create a playlist from the picker's *New playlist* row, tap the bin twice to delete (rename is JS-only for now) |
| Visible "up next" queue | **Working** |
| Shuffle (real Fisher-Yates) + repeat (off / all / one) | **Working** |
| Now-playing bar with artwork, seek scrubber | **Working** |
| Crossfade between tracks | **Working**⁵ — 🎧 panel → Crossfade slider, 1–12 s (native engine: built, see footnote) |
| Recently played / liked tracks | **Working** — heart button on the now-playing card; *Recently played* and *Liked* sit in the playlist picker |

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
automatically on first scan if it doesn't exist). Tap 🎧 → "Scan
folder" to load it, then 🎧 → "Equalizer ▾" for the 10-band EQ.

**Playlists** are just subfolders of `Audio/` — no separate playlist
file or in-app "create playlist" step. A folder's name becomes the
playlist name shown in the picker, and every audio file inside it
(nested subfolders included) belongs to that playlist:

```
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

² The WebView engine's equalizer is a real 10-band Web Audio graph
(`<audio>` element → 10 peaking `BiquadFilterNode`s → preamp `GainNode` →
destination). Audio played through the native background engine never
passes through the page's `AudioContext`, so the native engine uses
Android's own `android.media.audiofx.Equalizer` on ExoPlayer's audio
session instead (`NativeAudioEffects.kt`). Devices expose their own band
layout (commonly 5 bands), so the 10 UI bands are interpolated onto
whatever the device has, in log-frequency. Both engines share the same
curve (`state.eqBands`), so switching engines keeps the sound. **This
native half was written without being compiled or run** — test it on a
device before relying on it; if a device has no equalizer effect the app
says so in the music panel's note line.

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
starts, sharing the audio session so the equalizer covers both players. **The
Kotlin half was written without being compiled or run** — test it on a device
(a demo build from a feature branch is ideal) before relying on it.
`tests/crossfade.test.js` checks the JS side.

## Audio feature framework

The optional audio features all hang off one small framework in
`audio-player.js` (section **7b. AUDIO FEATURES FRAMEWORK**), so adding or
finishing one doesn't mean threading changes through both engines.

**How it works.** The engines and queue stay feature-agnostic; they only
announce what happened, and feature *modules* react. Each module is a plain
object passed to `AudioFeatures.register()`:

```js
{
  id: 'abRepeat', label: 'A-B repeat', status: 'working',
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
| `abRepeat` | logic-ready | `setA()`, `setB()`, `clear()`, `get()`; loops via `AudioEngine.seek()`; cleared on every new track; never persisted. Loop can overshoot B by up to ~0.5 s (progress rate) | A/B buttons + a marker on the seek bar. Frame-accurate looping would need a native `ClippingMediaSource` |
| `replayGain` | working | `setMode('off'/'track'/'album')`, `describe(track)` for the UI. Cuts go through `gain()`; boosts go to the native `LoudnessEnhancer`; honours the track/album peak so it never clips. Tags are read natively by `ReplayGainReader.kt` and added to each scanned track as `replayGainTrackDb` / `replayGainAlbumDb` / `replayGainPeak` / `replayGainAlbumPeak` | Test on a device (see footnote ⁴). Possible later: pre-amp for untagged tracks, an in-app scanner that computes gain for files with no tags |
| `crossfade` | working | `setSeconds()` (0–12, whole seconds), persisted; `curve(t)` = equal-power fade. When the track is within `seconds + 0.5 s` of its end it calls `AudioEngine.beginCrossfade(nextId, seconds)`; the engine returns `false` to be asked again next tick. On success the queue/state move to the next track immediately and the engine fades the old one out underneath. WebView: second `<audio>` + timed ramps. Native: second ExoPlayer (`NativeCrossfade.kt`) | Test the native half on a device (see footnote ⁵). Possible later: per-track fade-out points, a gapless (no-fade) mode |
| `history` | logic-ready | Newest-first, deduped, capped at 100, persisted; virtual playlist `@recent` | Playlist picker entry |
| `likes` | logic-ready | `toggle(id?)`, `isLiked()`, `getIds()`; virtual playlist `@liked` | Heart button on the now-playing card (needs an `i-heart` icon in the sprite) |
| `customPlaylists` | logic-ready | `create/rename/remove/addTracks/removeTrack/list`; virtual playlist `@list:<id>` | Editor UI + picker entries |
| `nativeEffects` | framework | Pushes the EQ curve + preamp + replay-gain boost to the native side on engine switch, track start and every slider change | Verify on a device (see footnote ²) |

**Virtual playlists.** `state.activePlaylist` may be `'all'`, a folder name,
or `'@recent'`, `'@liked'`, `'@list:<id>'`. `MediaLibrary.currentSelectionIds()`
resolves the virtual ones through `AudioFeatures.selectionFor()`, dropping any
track no longer in the library, so shuffle/repeat/next/previous work on them
unchanged. `AudioFeatures.listVirtualPlaylists()` returns what a picker should
offer. The existing folder dropdown does not list them yet.

**Native bridge added for this** (Kotlin side in `NativeAudioEffects.kt`,
created and released by `PlaybackService`): `nativeAudioSetEqualizer(bandsJson,
preampDb)`, `nativeAudioSetBoostDb(db)`, and `nativeAudioEffectsRequestInfo()`,
which answers asynchronously through `window.onNativeAudioEffectsInfo(json)`.
`NativeAudioEffects` keeps the last curve and re-applies it if the audio
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
A-B loop, replay-gain maths, virtual playlists, crossfade trigger, native EQ
fallback). Run it from the project root: `node tests/audio-features.test.js`.
It cannot exercise the Kotlin side or real audio.

**Moon-lock checks.** `tests/moon-lock.test.js` checks eligible dates, moon
phases, tap completion, four-side impact geometry, 26-ray density, random web
staggering, facet progression, screen shake, and terminal contrast. Run it from
the project root: `node tests/moon-lock.test.js`.

**Colour wheel.** The Page and Text colour swatches in the Reading panel open a
colour wheel (`color-wheel.js`: hue/saturation wheel, brightness slider, hex field)
instead of the system colour dialog. The native colour inputs stay in the page as
the source of truth, so saving, recent colours and presets work as before.

**Shattered-glass renderer.** The moon-lock glass is drawn by
`app/src/main/assets/shatter-glass.js`: a dependency-free Canvas 2D module that
builds a seeded, irregular low-poly glass layout (Delaunay facets around four
staggered impact points plus long branching cracks) once per lock session, then
only redraws when tap progress changes (the existing 40-step quantisation).
The last 18% of progress turns the glass into a plain inverse-colour fill
(cracks fade out, no lines in the final frame).
If the module or canvas is unavailable, `moon-lock.js` falls back to its older
layered renderer. Run `node tests/shatter-glass.test.js` for its geometry checks.

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

`settings.txt` sits in shared storage, so it is treated as untrusted input. Only
known settings are read, each value must have the right type and stay inside
the same range as the matching control in the app (for example font size 13-32),
and anything else on a line is ignored: that setting simply keeps its current
value. At most 5,000 lines are read, and a file larger than 256 KB is ignored
and rewritten from the app's current settings.

If the app crashes, the stack trace is saved to `crash_log.txt` in the app's own
folder, `/storage/emulated/0/Android/data/com.scell.novelreader.redesign/files/`
(not in `Novel/`, where other apps could read it). Many file managers can still
open that folder; on newer Android versions some can't, and then the file needs
a computer (adb).

## Screen timeout

The screen stays on while you're using the app and is released to the normal
system timeout after 15 minutes with no touch input.

## Background / auto-close

The player runs as a normal Media3 service: its notification shows while a
track is loaded. With nothing playing for 10 minutes the service stops and its
notification is removed. The app itself also closes after 10 minutes with no
touch or key input — but never while music is active, whether it is
playing on the native player or the WebView fallback player; it simply
re-checks 10 minutes later. Swiping the app away stops it
unless music is playing.

If Android kills the WebView's renderer process while the app sits in the
background (usually after the phone has been locked for a while), the app drops
the dead WebView and rebuilds its screen instead of closing; if the renderer
dies again within 5 seconds of a rebuild, the app closes rather than looping.

## How the page is loaded (WebView lock-down)

The app page is not opened from `file://`. `MainActivity.kt` serves it from
`https://appassets.androidplatform.net/assets/index.html` through
`WebViewAssetLoader` and the WebView has file and content access switched off.
Local music reaches the page's `<audio>` element from the same origin under
`/audio/<path inside Audio/>`, served by `serveAudio()` (real audio files
inside `Novel/Audio` only, with Range support for seeking). The page carries a
Content-Security-Policy (own files only; no network, frames or workers), every
request to another host is refused, and navigation away from the app page is
blocked: a tapped http/https link opens in the external browser, anything else
is dropped.

Because the page's origin changed from `file://` to `https://`, its saved page
data (stored per origin) starts empty after updating to this version. Data that
is mirrored to `Novel/settings.txt` comes back (appearance, music settings,
reading-session limits, last novel and last chapter per novel). Not mirrored,
so reset once: bookmarks, per-chapter scroll positions, chapter "deleted"
marks and a running reading-session timer.

## Backup

Android's automatic backup stays on, but `res/xml/backup_rules.xml` (Android 11
and older) and `res/xml/data_extraction_rules.xml` (Android 12+, cloud backup
and device transfer) exclude everything private: the moon-lock unlock record,
the page's saved data (`app_webview`) and all other app-private preferences,
files and databases. Your own files are not part of app data: chapters, music
and `settings.txt` live in `Novel/` on shared storage.

## Release build

GitHub Actions builds `app-release.apk` (the one to install) and `app-debug.apk`
on every run, both signed with the same key. The release build is shrunk by R8
(unused code removed, the rest optimised) but not obfuscated, so crash logs stay
readable; the rules are in `app/proguard-rules.pro` and keep the WebView bridge
methods the page calls by name. Resource shrinking is not enabled.

## Updating the installed app

Builds are signed with a fixed key that is supplied through GitHub secrets
(see `UPDATE_SIGNING.md`; no keystore is kept in the repo) and the
version code is the GitHub Actions run number, so each new APK installs as an
update over the previous one (data is kept). The very first build with this
key cannot update an app installed from an older build signed with a different
key: uninstall once, then every later build updates in place. Settings are
restored from `Novel/settings.txt` after that one-time reinstall.

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

## Library (novel selector)

The app opens on a library screen: one card per novel, cover on top and the
novel's name underneath (plus the chapter you're on, if any). The cover is an
image inside that novel's own folder, e.g.
`/storage/emulated/0/Novel/Shadow Slave/cover.jpg`. Looked-for names (jpg, jpeg,
png or webp): `cover`, `folder`, `front`, `poster`, `thumbnail`, `thumb`, `art`,
`image`; if none match, the first image file in the folder is used. Novels with
no image get a placeholder with the first letter. Use **Switch novel** in the
chapter list to come back to the library.

## Packaging rule for generated packages

Every zip package generated for this app must contain **one top-level folder
named `novelreader`**, with the whole project inside it (`app/`, `.github/`,
`README.md`, ...). Do not use other folder names such as `Novel-Reader-2-master`.
When uploading to GitHub, copy the *contents* of `novelreader/` into the repo
root so that `app/src/main/assets/index.html` and `.github/workflows/` sit at the
top level of the repo.

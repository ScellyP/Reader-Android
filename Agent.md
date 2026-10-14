# Agents.md — Developer / AI Notes

This file is for AI agents and developers working on Novel Reader.
User/install/usage docs are in [README.md](README.md).

## Project map

Key files:

- `app/src/main/assets/index.html` — main app UI.
- `app/src/main/assets/reader.js` — reading UI, gestures, night-lock constants (`NIGHT_LOCK_START`, `NIGHT_LOCK_END`).
- `app/src/main/assets/audio-player.js` — audio UI, queue, engines, audio feature framework.
- `app/src/main/assets/spotify-ui.js` — Spotify-kit music panel glue: switches the library / songs / now-playing views, mirrors player state into the mini player and "..." sheet. Styles are the `spotify-kit` block in `index.html`; `audio-player.js` is untouched apart from two-line queue rows.
- `app/src/main/assets/settings-file.js` — mirrors settings to `/storage/emulated/0/Novel/settings.txt`.
- `app/src/main/assets/version.js` — `APP_VERSION`.
- `app/src/main/assets/color-wheel.js` — Page/Text colour wheel.
- `app/src/main/assets/moon-lock.js` — Moonlit Lock (night-lock) UI; shows the real moon phase via `moonPhaseInfo()` / `moonPhasePath()`.
- `app/src/main/assets/moon-theme.js` — fills the `[data-moon]` phase badges (uses `NovelMoonLock.moonPhaseInfo/moonPhasePath`). The rest of the moon/space theme is CSS in `<style id="moon-theme">` in `index.html` (`.sky` starfield, ornaments, splash moon).
- `app/src/main/assets/shatter-glass.js` — Canvas 2D shattered-glass renderer.
- `MainActivity.kt` — Android host, hardcoded `chaptersDir`, `connectNativePlayer()`, `listAudioFiles()`.
- `PlaybackService.kt` — Media3 foreground service, `QueueAwarePlayer`, notification controls.
- `NativeAudioEffects.kt` — native equalizer/boost bridge.
- `NativeCrossfade.kt` — native crossfade: two ExoPlayers, equal-power ramp, session hand-over.
- `ReplayGainReader.kt` — reads ReplayGain tags from the file bytes (pure `java.io`, testable on a plain JVM).
- `MoonUnlockStore.kt` — native signed night-lock unlock store.
- `tests/audio-features.test.js`
- `tests/crossfade.test.js`
- `tests/replaygain.test.js`, `tests/replaygain-reader/` (see footnote ⁴)
- `tests/moon-lock.test.js`
- `tests/moon-puzzle.test.js` — puzzle rules for the Moonlit Lock (run with `node tests/moon-puzzle.test.js`)
- `tests/shatter-glass.test.js`

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

`.github/workflows/build-apk.yml` has two jobs. `gate` runs on every push and
decides; `build` only runs when `gate` outputs `build=true`. A push builds when
**any** of these holds (checked in this order):

1. manual run (`workflow_dispatch`), or a pushed tag starting with `v`;
2. otherwise, `[skip build]` in any pushed commit message -> **no build**
   (beats rules 3 and 4);
3. `[build]` in any pushed commit message;
4. a version number matching `v<digits>.<digits>.<digits>` in any pushed commit
   message (e.g. `v1.04.02: fix volume keys`).

Commit messages are passed to the script through environment variables, never
interpolated into the shell, so keep it that way. `versionCode` is still
`GITHUB_RUN_NUMBER`; skipped pushes use up numbers, which only leaves gaps.

When you give the owner a change, suggest a commit message that starts with the
new `APP_VERSION` number (e.g. `v1.04.02`; a suffix like `-alpha` is optional) so
the push builds; for docs-only or CI-only changes, suggest a message without a version
number (or with `[skip build]`).

## Demo builds (feature branches)

Demo builds have their **own workflow file**, separate from the normal one:

| File | Runs on | Builds | Artifacts |
| --- | --- | --- | --- |
| `.github/workflows/build-apk.yml` | pushes to `main`/`master` | the normal app | `novel-reader-*-apk` |
| `.github/workflows/build-demo-apk.yml` | pushes to every other branch (e.g. `crossfade-replaygain`), or a manual run | the **demo app** | `novel-reader-demo-*-apk` |

The demo workflow sets `NR_DEMO=true`; `app/build.gradle` then adds
`applicationIdSuffix ".demo"` (`com.scell.novelreader.redesign.demo`),
`versionNameSuffix "-demo"` and the label "Novel Reader (Demo)" (manifest
placeholder `appLabel`). It installs **next to** the normal app. Both files use
the same commit-message rule (a `vX.Y.Z` in the message, or run by hand from the
Actions tab). Branch builds never touch `main`'s workflow or artifacts, and a
newer push to a branch cancels that branch's older running demo build.

- Demo APK files are named `novel-reader-demo-release.apk` / `novel-reader-demo-debug.apk` (never `app-release.apk`). The demo workflow checks with `aapt2` that the built APK really has the `.demo` id and fails the build if not, so a demo can never silently try to update the normal app.
- The demo is a separate app to Android: it needs its own "All files access"
  grant and has its own private data (moon-unlock record, WebView storage).
- Shared storage (`Novel/`, `Novel/Audio/`) is shared, but the demo reads and
  writes `Novel/settings-demo.txt`, never `settings.txt`. First launch seeds it
  with a copy of `settings.txt`. Delete `settings-demo.txt` to re-seed.
- `AndroidBridge.isDemoBuild()` lets the page know; `version.js` appends
  " · demo" to the version label.
- GitHub runs the workflow file as it exists **on the pushed branch**, so the
  branch must contain `build-demo-apk.yml` (create it from `main` after this
  change lands). Merging into `main` is safe: `main` only runs `build-apk.yml`.

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
| 10-band equalizer + preamp | **Working**² (native engine: built, see footnote) |
| Volume normalisation (replay gain) | **Working**⁴ — off / track / album, from the ReplayGain tags in your files |
| Resume-at-position per track | Removed — every track starts at 0 (only a live engine hand-off keeps its position) |
| A-B repeat | **Working** — A / B buttons under the seek bar |
| Graceful handling of unplayable files (skip, don't stall) | **Working** |

**From Spotify — how it feels to use**

| Feature | Status |
| --- | --- |
| Library scan (native folder scan + tags) | **Working** |
| Playlists via folders (a subfolder in Audio/ = a playlist) | **Working** |
| Curated playlists (hand-picked, not tied to a folder) | **Working** — "New playlist" in the Library, plus add-to-playlist |
| Visible "up next" queue | **Working** |
| Shuffle (real Fisher-Yates) + repeat (off / all / one) | **Working** |
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
automatically on first scan if it doesn't exist). Tap 🎧 → "Scan the sky" to load it, then 🎧 → "Equalizer ▾" for the 10-band EQ.

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
| `customPlaylists` | working | `create/rename/remove/addTracks/removeTrack/list`; virtual playlist `@list:<id>` | Done: "New playlist" editor and picker entries. Possible later: drag to reorder |
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

**Moonlit Lock puzzle.** On non-holiday days (`!isCheatDay`) the lock offers a moon-phase sliding puzzle (`puzzleShuffle`, `puzzleMove`, `puzzleSolved` in `moon-lock.js`). Solving it calls `grantUnlock('puzzle')`, which uses the native `AndroidBridge.moonUnlockGrantPuzzle()` (fixed 30 minutes, see `moonPuzzleUnlockMs` in `MainActivity.kt`); holidays keep the 1-hour tap unlock. The hidden test run also offers the puzzle and never saves an unlock.

**Moonlit Lock checks.** (The lock was renamed from "moon lock"; file and `NovelMoonLock` names are unchanged.) The moon icon uses `moonPhaseInfo(date)` (real phase from sun/moon longitudes) and `moonPhasePath(fraction, cx, cy, r)`; tap count no longer changes the icon. Add checks for these to the test below. `tests/moon-lock.test.js` checks eligible dates, moon
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

## AI assistant instructions

- **Bump the version automatically** in the same change for every real bug fix or feature. State the new version in your reply. Follow `Agents.md#version-number`.
- **Broken builds never change the version.** If a build fails or is redone, leave the number alone.
- **Update `README.md`** for user-facing changes: setup, build steps, gestures, settings, visible features.
- **Update `Agents.md`** for internal changes: architecture, feature framework, native bridge, tests, versioning, packaging.
- **Keep tests updated.** Add or adjust checks in `tests/` when behaviour changes.
- **Follow the packaging rule.** Generated zips must contain one top-level folder named `novelreader`; GitHub uploads must put `app/src/main/assets/index.html` and `.github/workflows/` at repo root.
- **Suggest a commit message.** Start it with the new version (e.g. `v1.04.02: fix volume keys`) so the push builds. Docs/CI-only changes get a message with no version number, or `[skip build]`. See `Agent.md#build-trigger-github-actions`.
- **Do not commit keystores.** Update signing is handled through GitHub secrets; see the "Signing and updates" section of `README.md`.
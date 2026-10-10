# Agents.md — Developer / AI Notes

This file is for AI agents and developers working on Novel Reader.
User/install/usage docs are in [README.md](README.md).

## Project map

Key files:

- `app/src/main/assets/index.html` — main app UI.
- `app/src/main/assets/reader.js` — reading UI, gestures, night-lock constants (`NIGHT_LOCK_START`, `NIGHT_LOCK_END`).
- `app/src/main/assets/audio-player.js` — audio UI, queue, engines, audio feature framework.
- `app/src/main/assets/settings-file.js` — mirrors settings to `/storage/emulated/0/Novel/settings.txt`.
- `app/src/main/assets/version.js` — `APP_VERSION`.
- `app/src/main/assets/color-wheel.js` — Page/Text colour wheel.
- `app/src/main/assets/moon-lock.js` — night-lock UI.
- `app/src/main/assets/shatter-glass.js` — Canvas 2D shattered-glass renderer.
- `MainActivity.kt` — Android host, hardcoded `chaptersDir`, `connectNativePlayer()`, `listAudioFiles()`.
- `PlaybackService.kt` — Media3 foreground service, `QueueAwarePlayer`, notification controls.
- `NativeAudioEffects.kt` — native equalizer/boost bridge.
- `MoonUnlockStore.kt` — native signed night-lock unlock store.
- `tests/audio-features.test.js`
- `tests/moon-lock.test.js`
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
| Volume normalisation (replay gain) | Framework — cuts and boosts are wired; needs the scanner to read ReplayGain tags |
| Resume-at-position per track | Removed — every track starts at 0 (only a live engine hand-off keeps its position) |
| A-B repeat | Logic ready — works through the JS API; no buttons yet |
| Audio delay / sync adjustment | Stub — stores an offset; nothing uses it yet |
| Graceful handling of unplayable files (skip, don't stall) | **Working** |

**From Spotify — how it feels to use**

| Feature | Status |
| --- | --- |
| Library scan (native folder scan + tags) | **Working** |
| Playlists via folders (a subfolder in Audio/ = a playlist) | **Working** |
| Curated playlists (hand-picked, not tied to a folder) | Logic ready — create/rename/delete/add in JS; no editor UI yet |
| Visible "up next" queue | **Working** |
| Shuffle (real Fisher-Yates) + repeat (off / all / one) | **Working** |
| Now-playing bar with artwork, seek scrubber | **Working** |
| Crossfade between tracks | Planned — the trigger hook exists; neither engine implements the overlap yet |
| Recently played / liked tracks | Logic ready — recorded and persisted, selectable as virtual playlists; no buttons yet |

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
`timeupdate` event (~4 Hz) and the native progress callback (~2 Hz);
`trackEnd` — `handleTrackEnded()`; `engineChanged` — `_switchToNative()`;
`libraryChanged` — after a scan.

**Status vocabulary** — `working` (behaviour + UI), `logic-ready` (works
through the JS API, no control yet), `framework` (plumbing in place, needs
data or native support), `stub` (stores a value, nothing consumes it),
`planned` (hook exists, behaviour not written).

| Module (`NovelAudio.features.…`) | Status | What exists | Next step |
| --- | --- | --- | --- |
| `abRepeat` | logic-ready | `setA()`, `setB()`, `clear()`, `get()`; loops via `AudioEngine.seek()`; cleared on every new track; never persisted. Loop can overshoot B by up to ~0.5 s (progress rate) | A/B buttons + a marker on the seek bar. Frame-accurate looping would need a native `ClippingMediaSource` |
| `replayGain` | framework | `setMode('off'/'track'/'album')`. Cuts go through `gain()`; boosts go to the native `LoudnessEnhancer`; honours `replayGainPeak` so it never clips | `MainActivity.listAudioFiles()` must read ReplayGain tags (ID3 `TXXX`, Vorbis comments) and add `replayGainTrackDb` / `replayGainAlbumDb` / `replayGainPeak` to each track. Until then it changes nothing |
| `audioDelay` | stub | `setOffsetMs()` (±2000), persisted | Needs a consumer (lyrics/video sync, or latency-compensated progress) |
| `crossfade` | planned | `setSeconds()` (0–12), persisted; calls `AudioEngine.beginCrossfade(nextId, seconds)` once when the track is inside the window | Implement `beginCrossfade` — WebView: second `<audio>` + two gain ramps; native: a second ExoPlayer |
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

**Adding a feature:** register a module (copy `likes` for plain data, or
`abRepeat` for something that reacts to playback), list it in the table above
with an honest status, and add checks to `tests/audio-features.test.js`.

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

## AI assistant instructions

- **Bump the version automatically** in the same change for every real bug fix or feature. State the new version in your reply. Follow `Agents.md#version-number`.
- **Broken builds never change the version.** If a build fails or is redone, leave the number alone.
- **Update `README.md`** for user-facing changes: setup, build steps, gestures, settings, visible features.
- **Update `Agents.md`** for internal changes: architecture, feature framework, native bridge, tests, versioning, packaging.
- **Keep tests updated.** Add or adjust checks in `tests/` when behaviour changes.
- **Follow the packaging rule.** Generated zips must contain one top-level folder named `novelreader`; GitHub uploads must put `app/src/main/assets/index.html` and `.github/workflows/` at repo root.
- **Suggest a commit message.** Start it with the new version (e.g. `v1.04.02: fix volume keys`) so the push builds. Docs/CI-only changes get a message with no version number, or `[skip build]`. See `Agent.md#build-trigger-github-actions`.
- **Do not commit keystores.** Update signing is handled through GitHub secrets; see the "Signing and updates" section of `README.md`.
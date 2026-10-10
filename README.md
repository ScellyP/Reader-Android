# Novel Reader — Android App

A native Android app version of the novel reader, with the layout bugs
(buttons disappearing/overflowing on small screens) fixed.

> **Developer/AI notes** — architecture, audio feature framework, version
> bump rules, tests and packaging rules — are in [Agents.md](Agents.md).

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
4. Scroll down, add a commit message, tap **Commit changes**.
5. GitHub Actions kicks off automatically because of the included
   `.github/workflows/build-apk.yml` — go to the repo's **Actions**
   tab to watch it (or trigger manually there via **Run workflow**).
6. Wait 3-5 minutes for the green checkmark.
7. Open the completed run → scroll to **Artifacts** → download
   **novel-reader-debug-apk** (a zip containing `app-debug.apk`).
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
   `app/build/outputs/apk/debug/app-debug.apk`

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

### Sleep lock

Between **12:00 AM and 6:00 AM** the app locks itself: a full-screen
"Time to sleep" screen covers everything, music is paused, and the Android
back button just leaves the app. It lifts by itself at 6:00 AM. The lock
window follows the phone's local clock.

## Audio player

The audio player is a hybrid: **VLC's playback reliability with Spotify's
user experience.** Two playback engines share one UI/queue: a WebView
`<audio>` element (works everywhere, including outside the Android app)
and a real ExoPlayer instance running in a Media3 foreground service
(true background playback, lock-screen/notification controls). The app
starts on the former and switches to the latter automatically the moment
it's ready — mid-playback, at the same position, inaudibly.

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

### Feature status

**Working today**

| Feature | Status |
| --- | --- |
| Library scan (native folder scan + tags) | ✅ Working |
| Playlists via folders (a subfolder in `Audio/` = a playlist) | ✅ Working |
| Visible "up next" queue | ✅ Working |
| Shuffle (real Fisher-Yates) + repeat (off / all / one) | ✅ Working |
| Now-playing bar with artwork, seek scrubber | ✅ Working |
| Broad format support (mp3, m4a/aac, flac, ogg, opus, wav) | ✅ Working |
| Near-gapless playback (next track pre-buffered) | ✅ Working |
| 10-band equalizer + preamp | ✅ Working (native engine built — see below) |
| Sleep timer (fixed minutes, or end-of-track), with a fade-out | ✅ Working |
| Auto-pause when a reading-break reminder appears, and resume on dismiss | ✅ Working |
| True background playback (screen off, app switched away) | ✅ Working |
| System media notification (artwork, title/artist, play/pause) | ✅ Working |
| Notification Next/Previous buttons | ✅ Working |
| Lock-screen transport controls, Bluetooth/headset buttons | ✅ Working |
| Audio-focus handling (ducks/pauses for calls, other apps) | ✅ Working |
| Pauses automatically when headphones/Bluetooth disconnect | ✅ Working |
| Graceful handling of unplayable files (skip, don't stall) | ✅ Working |

**Removed**

| Feature | Status |
| --- | --- |
| Playback speed with pitch preservation | ❌ Removed — always 1× |
| Resume-at-position per track | ❌ Removed — every track starts at 0 (only a live engine hand-off keeps its position) |

**Planned / in progress**

| Feature | Status | What's missing |
| --- | --- | --- |
| Crossfade between tracks | 🟡 Planned | The trigger hook exists, but neither engine implements the overlap. |
| Volume normalisation (ReplayGain) | 🟡 Framework | `MainActivity.listAudioFiles()` needs to read the ReplayGain tags. Until then it changes nothing. |
| Audio delay / sync adjustment | 🟡 Stub | It only stores an offset and nothing uses it. |
| A-B repeat | 🟡 Logic ready | The logic works, but there are no buttons or seek-bar markers. |
| Search | 🟡 Logic ready | The logic is ready, but there is no search box. |
| Likes | 🟡 Logic ready | Recorded, but there is no heart button. |
| Recently played | 🟡 Logic ready | Recorded, but there is no picker entry for `@recent`. |
| Custom playlist editor | 🟡 Logic ready | Create, rename and delete work in JS, but there is no editor UI. |
| Native equalizer | 🟡 Needs device test | The Kotlin was written without being compiled or run, so it needs a device test. |
| Release pipeline | 🔴 Not started | `UPDATE_SIGNING.md` describes `app-release.apk` and signing secrets, but the workflow only runs `assembleDebug` and has no secrets handling. |

> Full internal architecture, engine details, native bridge, footnotes and
> tests are in [Agents.md](Agents.md#audio-player-architecture).

## Security features to add

The following are known gaps to close. None of these are fixed yet.

1. **Chapter `Source:` line runs as HTML.** `reader.js` puts `ch.source`
   into `innerHTML`. A crafted `.txt` file could run script with access to
   `AndroidBridge`. Build the link with DOM calls and allow only `http` or
   `https`.
2. **Signing keys and passwords are in the repo.** Both keystores are
   included, and `build.gradle` has the password `novelreader` in plain
   text. Move them to GitHub secrets and rotate the key.
3. **Bridge accepts any file path.** `getArtwork` and `nativeAudioLoad`
   take any path, and the app holds all-files access. Restrict paths to
   `Novel/Audio` after resolving them.
4. **Playback service has no caller check.** `PlaybackService` is
   `exported="true"` and `onGetSession` returns the session to anyone.
   Validate the controller's package.
5. **Sleep lock and unlock are easy to bypass.** The unlock time sits in
   plain `localStorage`, and the lock relies on the phone clock. Changing
   the clock or clearing app data defeats it. Track time with
   `SystemClock.elapsedRealtime()` and keep the unlock state on the native
   side.
6. **WebView is too open.** Switch to `WebViewAssetLoader` instead of
   `file://`, turn off `allowFileAccess`, and add a Content-Security-Policy.
   Also add `shouldOverrideUrlLoading` so links open only in the external
   browser.
7. **`allowBackup="true"`.** Set it to `false`, or add backup rules.
8. **`settings.txt` and `crash_log.txt` sit in shared storage.** Any app
   with storage access can edit or read them, and the file overrides saved
   settings on startup. Validate values on load, and move the crash log into
   app-private storage.
9. **Release build has `minifyEnabled false`.** Turn on R8 and ship a
   release build, not debug.

## Settings file

Saved settings (appearance, music player, reading-session limits, last novel)
are mirrored to `/storage/emulated/0/Novel/settings.txt` and read back on
startup (see `app/src/main/assets/settings-file.js`). One `key = value` per
line, values as JSON; lines starting with `#` are comments. Edit it while the
app is closed; delete a line to reset that setting.

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

## Updating the installed app

Builds are signed with a fixed key that is supplied through GitHub secrets
(see `UPDATE_SIGNING.md`; no keystore is kept in the repo) and the
version code is the GitHub Actions run number, so each new APK installs as an
update over the previous one (data is kept). The very first build with this
key cannot update an app installed from an older build signed with a different
key: uninstall once, then every later build updates in place. Settings are
restored from `Novel/settings.txt` after that one-time reinstall.

## Library (novel selector)

The app opens on a library screen: one card per novel, cover on top and the
novel's name underneath (plus the chapter you're on, if any). The cover is an
image inside that novel's own folder, e.g.
`/storage/emulated/0/Novel/Shadow Slave/cover.jpg`. Looked-for names (jpg, jpeg,
png or webp): `cover`, `folder`, `front`, `poster`, `thumbnail`, `thumb`, `art`,
`image`; if none match, the first image file in the folder is used. Novels with
no image get a placeholder with the first letter. Use **Switch novel** in the
chapter list to come back to the library.

## Version number

The current version is shown at the bottom of the side menu (e.g. `v1.00.00`).
It lives in `app/src/main/assets/version.js` as `APP_VERSION`. For the version
bump rules used by maintainers/AI, see [Agents.md](Agents.md#version-number).
# Novel Reader — Android App

A native Android app for reading novels stored as `.txt` chapter files, with a
built-in music player, reading colours, bookmarks and a reading-session timer.
Everything stays on your phone: no account, no internet needed.

**Contents**

- [Quick start](#quick-start)
- [Download the APK](#download-the-apk)
- [Updating the app](#updating-the-app)
- [Setting up your chapters folder](#setting-up-your-chapters-folder)
- [Using the app](#using-the-app)
- [Audio player](#audio-player)
- [Library (novel selector)](#library-novel-selector)
- [Settings, screen timeout and auto-close](#settings-file)
- [Version number](#version-number)
- [Security features to add](#security-features-to-add)
- [For developers](#for-developers)

## Quick start

1. [Download the APK](#download-the-apk) from the repo's **Actions** tab.
2. Install it.
3. Create `Novel/Chapters` on your phone's internal storage and put your
   `.txt` chapters in it.
4. Open the app, tap **Grant storage access**, and start reading.

## Download the APK

You don't need a computer, and you don't need to set anything up. The latest
build is already waiting in the repo's Actions tab.

You need a free GitHub account, signed in on your phone's browser: GitHub only
lets signed-in users download build files.

1. Open the repository on [GitHub](https://github.com/ScellyP/Reader-Android).
   Use **Desktop site** in your phone browser if the mobile view hides buttons.
2. Tap the **Actions** tab.
3. In the left sidebar, tap the workflow named **Build APK**. You will see a
   list of runs, newest first.
4. Pick the newest run with a **green checkmark** ✅. If the top one is still
   yellow, it's building: wait a few minutes and refresh.
5. Open that run and scroll to the **Artifacts** section at the bottom.
6. Tap **novel-reader-debug-apk**. Your browser saves a `.zip`.
7. Open your file manager, go to **Downloads**, and unzip it. Inside is
   `app-debug.apk`.
8. Tap `app-debug.apk` to install. Android will ask you to allow
   **"install unknown apps"** for your browser or file manager the first time.
   Allow it, then finish the install.

**Can't see an Artifacts section?** That run didn't produce an APK (it was a
small change that skipped the build) or its files have expired. Go back and
pick a different green run.

## Updating the app

To update, repeat the steps above with the newest green run and install the APK
over the old one. Your chapters, bookmarks and settings stay.

If Android refuses to install it as an update, uninstall the app once and
install again. Your settings come back from `Novel/settings.txt`.

## Setting up your chapters folder

1. On your phone, open any file manager app.
2. Go to **Internal storage** (the root of your phone's storage, not
   an SD card).
3. Create a folder named `Novel`, then inside it a folder named
   `Chapters`, so the full path is:
   `/storage/emulated/0/Novel/Chapters`
4. Put your `.txt` chapter files directly inside `Chapters`.
5. Open the app and tap **"Grant storage access"**. Android will take
   you to a permission screen; enable **"Allow access to manage all
   files"** (or similarly worded) for Novel Reader, then go back.
6. The app reads every `.txt` file in that folder each time you open it, so
   there is nothing to pick again.

**Note:** the folder is hardcoded. To point the app somewhere else, change the
path in `MainActivity.kt` (search for `chaptersDir`) and rebuild.

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

### Chapter files and order

Chapter files can be plain `.txt`, or the `chapter_downloader.py` format (a
title line, an optional `Source:` line, a `====` separator, then the text).
Reading order comes from the chapter number in each file's **title** (the first
line, e.g. `Chapter 2004: Seeds of Rebellion`), not from the file name, so
renaming files or a differently sorted Files app won't shuffle your novel.
Chapters with no number (a Prologue or Epilogue) go after all numbered ones, in
file-name order.

### First launch

The app asks for **notification access** on Android 13+ (so the music
notification can show) and for **all-files access** via the *Grant storage
access* button. A short splash plays, then a "Your library is loading" screen
shows until your chapters are ready.

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
never paginates, scrolls, or changes chapter.

### Volume buttons

While reading, **Volume Up / Down scroll the page** (same distance as a tap).
They turn themselves off — and change the normal media volume instead — whenever
a menu is open (the chapter drawer or any popup panel, including the audio
player; the audio panel's volume bar follows along). You can also switch the
scrolling off for good with **Volume button scroll** in the 🎨 panel; then the
buttons always change the volume.

**Volume keys in audio player** (🎨 panel, right under Smart scroll) is on by
default: with the audio player open, the buttons change the media volume. Switch
it off, and they keep scrolling the page even while the audio player is open (any
other open menu still gives them to the volume). The setting is saved in
`settings.txt` as `audioVolumeKeys`.

How far a tap-to-scroll moves the page is adjustable: 🎨 → **Tap scroll** (in the same panel as the reading colours), measured in lines of
the current text rather than a fixed screen fraction, so it stays
consistent across font sizes and devices.

### Reading panel (🎨)

Open it with the 🎨 button in the sidebar header. The font family is chosen
separately from the dropdown in the top bar.

| Control | What it does |
| --- | --- |
| **Preset** (Dark / Light) | One-tap colour schemes for the page and text |
| **Page** / **Text** | Open a colour wheel (hue and saturation, brightness slider, hex field). The six most recent colours for each are kept as swatches under it |
| **Line height** | Space between lines (1.2 to 2.6) |
| **Letter spacing** | Space between letters (-0.5 to 3) |
| **Page turn** | How long the page-flip animation takes when you change chapter (0.2 s to 3 s); jumping several chapters flips a little longer |
| **Smart scroll** | Off by default. A tap scrolls just far enough to bring the paragraph cut off at the screen edge fully into view, so you never stop mid-sentence. While it is on, **Tap scroll** is greyed out |
| **Volume keys in audio player** | See [Volume buttons](#volume-buttons) |
| **Volume button scroll** | See [Volume buttons](#volume-buttons) |
| **Tap scroll** | How many lines a tap moves the page (3 to 30) |
| **Reset to default** | Puts the reading settings back to their defaults |

The menu and button colours follow your page and text colours. While you drag
any slider in this panel (or the reading-timer panel), everything else fades
out so you can see the text change underneath; letting go brings it back.

### Bookmarks (🔖)

Bookmarks are kept per novel. Open the panel with the 🔖 button in the sidebar
header, then tap **Bookmark this chapter** to save the chapter you're on, or
**press and hold any paragraph** while reading to save that exact spot. Saved
bookmarks are listed in the panel.

### End of a novel

When you reach the last chapter, an **Open Termux to fetch new chapters**
button appears under the chapter. It opens the Termux app if it is installed
(for running a chapter downloader); otherwise the app tells you Termux isn't
installed.

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
automatically on first scan if it doesn't exist). Tap 🎧 → **Rescan** to load
it. Once a track is loaded, a 🎧 shortcut also appears in the top bar, between
the next-chapter button and the font dropdown. The panel has the playlist
list, shuffle, previous/play/next, repeat, a seek bar and a volume slider.

> **Currently hidden:** the **Sleep timer** and the **Equalizer** controls are
> switched off in the music panel (the code is kept, so they can be shown
> again). The feature tables below describe what is built, not what is
> visible today.

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
| 10-band equalizer + preamp | ✅ Built, ⚠️ hidden in the panel |
| Sleep timer (fixed minutes, or end-of-track), with a fade-out | ✅ Built, ⚠️ hidden in the panel |
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
| A-B repeat | 🟡 Currently Testing | The logic works, but there are no buttons or seek-bar markers. |
| Likes | 🟡 Currently Testing | Recorded, but there is no heart button. |
| Audio delay/sync adjustment | 🟡 Currently Testing | It only stores an offset and nothing uses it. |
| Crossfade between tracks | 🟡 Under Development | The trigger hook exists, but neither engine implements the overlap. |
| Volume normalisation (ReplayGain) | 🟡 Under Development | `MainActivity.listAudioFiles()` needs to read the ReplayGain tags. Until then it changes nothing. |
| Recently played | 🟡 Under Development | Recorded, but there is no picker entry for `@recent`. |
| Custom playlist editor | 🟡 Logic ready | Playlist Editor UI Is still being worked on. |
| Search box for the music library | ⚪ Not added | Only the chapter list has a search box today. |
| Heart / A-B buttons, Recently played and Liked in the playlist picker | ⚪ Not added | The logic is there; none of these has a button or picker entry yet. |

## Library (novel selector)

The app opens on a library screen: one card per novel, cover on top and the
novel's name underneath (plus the chapter you're on, if any). The cover is an
image inside that novel's own folder, e.g.
`/storage/emulated/0/Novel/Shadow Slave/cover.jpg`. Looked-for names (jpg, jpeg,
png or webp): `cover`, `folder`, `front`, `poster`, `thumbnail`, `thumb`, `art`,
`image`; if none match, the first image file in the folder is used. Novels with
no image get a placeholder with the first letter. Use **Switch novel** in the
chapter list to come back to the library.

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

## Version number

The current version is shown at the bottom of the side menu (e.g. `v1.04.01`).
It lives in one place, `APP_VERSION` in `app/src/main/assets/version.js`, and is
changed by hand: MAJOR stays until you decide to change it, MID goes up for a
new feature, MINOR goes up for each bug fix. A failed or redone build never
changes it.

Use the same number in your commit message (e.g. `v1.04.02: fix volume keys`)
when you want that commit built; see [When does a build run?](#when-does-a-build-run).
This number is separate from Android's `versionCode`, which follows the
Actions run number. The full rules are in [Agent.md](Agent.md#version-number).

## Security features to add

The following are known gaps to close. None of these are fixed yet.

1. **Chapter `Source:` line runs as HTML.** `reader.js` puts `ch.source`
   into `innerHTML`. A crafted `.txt` file could run script with access to
   `AndroidBridge`. Build the link with DOM calls and allow only `http` or
   `https`.
2. **Keep keystores out of the repo.** Signing now comes from GitHub
   secrets (see [Signing and updates](#signing-and-updates)) and `*.keystore`
   is git-ignored, but older keystore files may still sit in your local copy
   or in git history. Make sure none were ever committed; if one was, rotate
   the key.
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

## For developers

Architecture, the audio feature framework, the native bridge, versioning rules,
packaging rules and notes for AI assistants are in [Agent.md](Agent.md).

### When does a build run?

Pushing to GitHub does **not** build the app every time. The workflow first
runs a quick check and only starts the real build when the push is opted in:

| What you do | Builds? |
| --- | --- |
| Commit message contains a version number, e.g. `v1.04.02: fix volume keys` | ✅ Yes |
| Commit message contains `[build]`, e.g. `tweak splash [build]` | ✅ Yes |
| Push a git tag starting with `v`, e.g. `v1.04.02` | ✅ Yes |
| **Actions → Build APK → Run workflow** (manual) | ✅ Yes |
| Any other commit (e.g. `fix typo in readme`) | ❌ No |
| Commit message contains `[skip build]` | ❌ No, even with a version number |

Notes:

- A version number means the form `v1.04.02` (a `v`, then three numbers
  separated by dots). `1.04.02` without the `v` does not count.
- If you push several commits at once, any one of their messages can opt the
  push in.
- A push that doesn't build still shows a short **Build APK** run with a green
  check; the build step is marked *skipped* and no APK is produced. Open the
  run's summary to see why.
- Putting `[skip ci]` in a message skips the whole workflow, which is GitHub's
  own switch.

### Signing and updates

Android only installs a new APK as an *update* (keeping your data) when it is
signed with the same key as the installed one and its version code is higher.
Both are handled for you:

- **Same key:** the workflow signs with a key stored in GitHub secrets. No
  keystore is kept in the repo.
- **Higher version code:** the version code is the GitHub Actions run number, so
  every build is higher than the last. Skipped pushes still use up a run
  number, so version codes may have gaps; that is harmless.

**One-time setup** (repo → **Settings → Secrets and variables → Actions →
New repository secret**). Create four secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | your keystore file, base64-encoded (`base64 -w0 my.keystore` on Linux; `base64 -i my.keystore` on macOS) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the key alias |
| `ANDROID_KEY_PASSWORD` | the key password |

If any of the four is missing, the build falls back to Android's debug key and
shows a warning. That APK installs fine, but it can't update an app installed
from a build signed with the real key.

The first build with a new key can't update an app installed from an older
build signed with a different key: uninstall once, and every later build
updates in place. Your settings come back from `Novel/settings.txt` after that
reinstall.


### Building the APK yourself

If you'd rather build on a computer with Android Studio:

1. Unzip the project and open it in Android Studio (**Open** → select the
   project folder).
2. Let Android Studio sync Gradle (needs internet the first time).
3. Click **Run ▶**, or go to **Build → Build Bundle(s)/APK(s) → Build APK(s)**.
4. The APK will be at `app/build/outputs/apk/debug/app-debug.apk`.

This APK is signed with Android's default debug key, so it can't update an app
installed from a GitHub build. You would have to uninstall and reinstall each
time.

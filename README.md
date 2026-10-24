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
- [Download songs](#download-songs)
- [Library (novel selector)](#library-novel-selector)
- [Settings, screen timeout and auto-close](#settings-file)
- [Version number](#version-number)
- [Security](#security)
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
3. Open the app once and allow storage access: it creates the `Novel`
   folder (and `Novel/Audio` for music) for you on first launch, so you
   don't have to. Then, inside `Novel`, make a folder named `Chapters`, so
   the full path is: `/storage/emulated/0/Novel/Chapters`
4. Put your `.txt` chapter files directly inside `Chapters`.
5. Open the app and tap **"Grant storage access"**. Android will take
   you to a permission screen; enable **"Allow access to manage all
   files"** (or similarly worded) for Novel Reader, then go back.
6. The app reads every `.txt` file in that folder each time you open it, so
   there is nothing to pick again.

**Note:** the folder is hardcoded. To point the app somewhere else, change the
path in `MainActivity.kt` (search for `novelRoot`) and rebuild.

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
| **Double-tap** the middle of the page | Add the current song to **Liked** (a heart pops up). It only adds, never removes, so a stray double tap can't undo a like; the heart button in the player still toggles. Works for a paused song too, and does nothing when no song is loaded |

When a song is loaded, a tap in the middle of the page waits about a quarter of a
second before it scrolls, so that a double tap doesn't scroll as well. Taps
elsewhere scroll straight away.

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
| **Adaptive brightness** | Off by default. The screen follows the phone's light sensor: full brightness in strong light, dimmest in a dark room, with smooth changes in between. It only changes this app's brightness, not the phone's setting, and switching it off hands brightness back to the phone. Saved in `settings.txt` as `adaptiveBrightness`. If the phone has no light sensor the switch stays off. |
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

### Moon and space theme

The whole app is dressed for the night sky: a moonrise splash, twinkling
stars (with an occasional shooting star) behind the library, loading screen,
break reminder, a crescent-and-star rule under each chapter
title and above Previous / Next, an orbiting mark while the library loads, a
planet for novels without a cover, and a small live moon-phase badge in the
library heading and the status strip. Stars and ornaments follow your reading
colours and switch off when Android's "reduce motion" is on.

The music player is themed too: songs without cover art get a moonlit-sky
cover, today's real moon and its phase sit at the top of the music player's
Home screen, playlists are "Constellations" and the rescan button is "Scan the
sky". The
current chapter is marked with a crescent, slider thumbs glow like a little
moon, and the app icon and the music notification icon are a crescent moon.

## Audio player

The audio player is a hybrid: **VLC's playback reliability with Spotify's
user experience.** Two playback engines share one UI/queue: a WebView
`<audio>` element (works everywhere, including outside the Android app)
and a real ExoPlayer instance running in a Media3 foreground service
(true background playback, lock-screen/notification controls). The app
starts on the former and switches to the latter automatically the moment
it's ready — mid-playback, at the same position, inaudibly.

Audio files are expected in `/storage/emulated/0/Novel/Audio` (created
automatically on first scan if it doesn't exist). Tap 🎧 → **Scan the sky** to load
it. Once a track is loaded, a 🎧 shortcut also appears in the top bar, between
the next-chapter button and the font dropdown. The panel has the playlist
list, shuffle, previous/play/next, repeat, a seek bar and a volume slider.

**Mute pauses the music.** If the media volume goes to 0 (volume keys, the
system volume panel or the slider) the music pauses, and it carries on when
you turn the volume back up. Only a pause caused by muting is undone: if you
paused it yourself, raising the volume won't start it again.

**Swipe to close.** Swipe the music panel from left to right to close it, the
same as its ✕ button. Dragging the sliders, scrolling the lists and the track
options sheet are not affected.

> **Note:** the **Sleep timer** row is hidden in the music panel itself; the
> timer is set from the "..." sheet instead.

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
| Shuffle (real Fisher-Yates) + repeat (off / all / one). Tapping shuffle while nothing is playing also starts the music: a random song, then the rest in shuffled order. While a song plays it only reshuffles what comes next, and switching shuffle off never starts anything | ✅ Working |
| Now-playing bar with artwork, seek scrubber | ✅ Working |
| Broad format support (mp3, m4a/aac, flac, ogg, opus, wav) | ✅ Working |
| Near-gapless playback (next track pre-buffered) | ✅ Working |
| Sleep timer (fixed minutes, or end-of-track), with a fade-out | ✅ Built (set from the "..." sheet) |
| Auto-pause when a reading-break reminder appears, and resume on dismiss | ✅ Working |
| True background playback (screen off, app switched away) | ✅ Working |
| System media notification (artwork, title/artist, play/pause) | ✅ Working |
| Notification Next/Previous buttons | ✅ Working |
| Lock-screen transport controls, Bluetooth/headset buttons | ✅ Working |
| Audio-focus handling (ducks/pauses for calls, other apps) | ✅ Working |
| Pauses automatically when headphones/Bluetooth disconnect | ✅ Working |
| Pauses when the volume is muted and resumes when it is raised | ✅ Implemented |
| Swipe the music panel left-to-right to close it | ✅ Implemented |
| Graceful handling of unplayable files (skip, don't stall) | ✅ Working |
| A-B repeat (A / B buttons under the seek bar) | ✅ Implemented |
| Likes (heart button on the now-playing card, plus a "Liked" playlist) | ✅ Implemented |
| Recently played (entry in the playlist picker) | ✅ Implemented |
| Remembers the last song: the song that was playing when the app was closed comes back as the current song on the next launch (press Play to start it, from the beginning, not from where it stopped) | ✅ Implemented |
| Starts playing by itself when the app is opened with a Bluetooth audio device connected (headphones, speaker, car): the remembered song, or the first one in the library. Once per launch | ✅ Implemented |
| Custom playlist editor ("New playlist" in the Library) | ✅ Implemented |
| Crossfade between tracks (1-12 s slider in the music panel) | ✅ Implemented |
| Volume normalisation (ReplayGain: off / track / album) | ✅ Implemented |

**Removed**

| Feature | Status |
| --- | --- |
| Playback speed with pitch preservation | ❌ Removed — always 1× |
| Resume-at-position per track | ❌ Removed — every track starts at 0 (only a live engine hand-off keeps its position) |

**Planned / in progress**

| Feature | Status | What's missing |
| --- | --- | --- |
| Audio delay/sync adjustment | 🟡 Currently Testing | It only stores an offset and nothing uses it. |
| Search box for the music library | ⚪ Not added | Only the chapter list has a search box today. |

### The music player's Home screen

The 🎧 panel opens on **Home**, laid out like a streaming app's home tab:

- A greeting that follows the time of day (Good morning / afternoon / evening / night),
  with today's moon, the Constellations and Stars counts, and **Scan the sky** in a slim
  strip under it.
- **Quick-access tiles**: the first six playlists as small cover-and-name tiles, two
  per row.
- **Made for you**: a shelf of big covers for All songs, Recently played and Liked.
- **Constellations**: a shelf for your folders and your own playlists, ending in a
  **New playlist** card. Your own playlists have a small bin button (tap twice to delete).

Shelves scroll sideways. Tapping any tile or card opens that playlist's song list. The
bottom bar is **Home / Songs / Now playing**.

**Swipe up on Previous / Next** (the chapter switcher under the chapter text, or just
above or below it) to open the music player.

## Download songs

The music player's Home screen has a **Download songs** button. Paste one or more
links (one per line, up to 50), choose where they go (no playlist, an existing
playlist, or **+ New playlist**), and press **Download**. Songs are downloaded one
after another as mp3 files with their tags and cover art, saved into
`Novel/Audio` (or the playlist's folder inside it), and the library refreshes by
itself when the batch ends. Each link shows *Waiting*, *Downloading*, *Done* or
*Failed* (with the reason and a **Retry** button); **Stop** cancels the rest.

The download itself is done by [Termux](https://termux.dev) with yt-dlp, so this
needs a one-time setup. Use Termux from **F-Droid** or its **GitHub releases**
(the Play Store version is too old to take commands from other apps):

1. In Termux run:

   ```text
   termux-setup-storage
   pkg update
   pkg install -y python ffmpeg
   pip install -U yt-dlp
   mkdir -p ~/.termux
   echo "allow-external-apps=true" >> ~/.termux/termux.properties
   termux-reload-settings
   ```

2. Open Novel Reader and press Download once. It asks for **Run commands in
   Termux environment**; allow it (the first link fails with a hint, tap **Retry**).
   If Android doesn't show the question, switch it on in the phone's
   Settings → Apps → Novel Reader → Permissions.

Notes:

- Keep Novel Reader open while it downloads. Android doesn't let an app in the
  background start Termux, so a long list only keeps going while the app is on screen.
- If links that used to work start failing, update yt-dlp: `pip install -U yt-dlp`.
- Playlist names may use letters, numbers, spaces and `_ - ( ) . & ' ,`; anything else
  is removed, and the sheet shows the name it will really use.
- The script is built into the app, so there is nothing to copy. The same script
  also runs by hand: `python song_dl.py URL "Playlist name"`.

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

## Security

How the app limits what the page, other apps and files on the phone can do:

- **The page is served from an https origin**
  (`https://appassets.androidplatform.net/`) through `WebViewAssetLoader`, not
  `file://`. The WebView has file and content access switched off, blocks mixed
  content, and the page carries a strict Content-Security-Policy (no network
  access at all). Links the user taps open in the external browser; any other
  navigation is dropped.
- **The JavaScript bridge only touches the music folder for audio.** A path
  from the page is accepted only if it resolves to a real audio file inside
  `Novel/Audio` (`resolveAudioFile()` in `MainActivity.kt`).
- **The playback service checks who connects.** `PlaybackService.onGetSession`
  only hands the media session to this app, the system, and known notification,
  car and Wear OS controllers.
- **`settings.txt` is untrusted input.** Only known keys are read, every value
  is checked for type and range, and a file over 256 KB is ignored.
- **The crash log is private.** It is written to the app's own folder under
  `Android/data/`, not to the shared `Novel/` folder.
- **Backups leave app data out.** `allowBackup` is on, but the backup and
  device-transfer rules exclude the app's private data.
- **Release builds use R8** (`minifyEnabled true`), without renaming, so crash
  logs stay readable.
- **Signing keys are not in the repo.** They come from GitHub secrets, and
  `*.keystore` / `*.jks` are git-ignored.

Known gaps:

1. **`settings.txt` sits in shared storage.** Any app with all-files access can
   read it or edit it (edits are validated when the app reads it back).
2. **Check your git history for keystores.** Older keystore files may still be in
   your local copy or in history; if one was ever committed, rotate the key.

## For developers

Architecture, the audio feature framework, the native bridge, versioning rules,
packaging rules and notes for AI assistants are in [Agent.md](Agent.md).

### When does a build run?

Pushing to GitHub does **not** build the app every time. The workflow first
runs a quick check and only starts the real build when the push is opted in:

| What you do | Builds? |
| --- | --- |
| Commit message contains a version number, e.g. `v1.04.02: fix volume keys` | ✅ Yes |
| **Actions → Build APK → Run workflow** (manual) | ✅ Yes |
| Any other commit (e.g. `fix typo in readme`) | ❌ No |

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
- Only pushes to `main`/`master` build; other branches never do.

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

#!/usr/bin/env python3
"""
song_dl.py - download one song with yt-dlp into the Novel Reader music library.

Run in Termux:
    python song_dl.py URL                 -> /storage/emulated/0/Novel/Audio/
    python song_dl.py URL "Lo-fi Focus"   -> /storage/emulated/0/Novel/Audio/Lo-fi Focus/
    python song_dl.py --name "My title" URL ["Playlist"]
                                          -> saved as "My title.mp3", with that title tag too
    python song_dl.py --title URL         -> only looks up the song's name (nothing is saved)
    python song_dl.py --stage URL         -> downloads into Audio/.staging/<run>/ (the app's music
                                             scan skips folders starting with a dot); RESULT message = the file's path
    python song_dl.py --place FILE [--name NAME] [Playlist]
                                          -> moves a staged FILE into Audio/[Playlist]/, saved as
                                             NAME.mp3 with NAME as its title tag; RESULT message = the new path

The options come first, before the link. A playlist called "--title" is therefore
still just a playlist name.

Matches the contract in Agent.md for the "Download songs" tab (a step-by-step wizard: paste,
download, rename, choose a playlist, then the song is moved there and played):
  * one URL per run (--stage and --place are separate runs; the page may run a download and a
    placement at the same time, so each run keeps its own pid file)
  * --title prints the song's name as RESULT {"status": "done", "message": "<name>"}
    so the page can show it and let the user change it before saving
  * the playlist (folder) name is a separate argument, never part of a shell string
  * the playlist name is cleaned exactly like song-download.js cleanFolderName
  * the LAST line printed is always machine readable:
        RESULT {"status": "done"|"failed", "message": "..."}
    and the exit code is 0 for done, 1 for failed.
  * SIGTERM / Ctrl+C stops yt-dlp and ffmpeg and reports "failed: Stopped".
  * the running script's process id is kept in $TMPDIR/song_dl.<pid>.pid, so the app can
    send it SIGTERM when you leave the tab (Termux's RUN_COMMAND cannot stop a command).

Audio settings are the same as downloader.sh option [1]: best audio, converted
to mp3 (quality 0), metadata and cover art embedded, single video only.

One-time setup (same as downloader.sh):
    termux-setup-storage
    pkg install -y python ffmpeg
    pip install -U yt-dlp
"""

import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile

AUDIO_ROOT = os.environ.get("NOVEL_AUDIO_DIR", "/storage/emulated/0/Novel/Audio")
# Downloads wait here until they are named and given a playlist. Inside Audio/ (so the app can
# read the cover art), but the app's scan skips any folder whose name starts with a dot.
STAGING_ROOT = os.environ.get("NOVEL_STAGING_DIR") or os.path.join(AUDIO_ROOT, ".staging")

_proc = None          # running yt-dlp process, so the signal handler can stop it
_stopped = False

# Where the app's Stop button finds this script (see MainActivity / SongDownloader.kt).
PID_FILE = os.path.join(os.environ.get("TMPDIR") or tempfile.gettempdir(), "song_dl.%d.pid" % os.getpid())


def finish(status, message, code, raw=False):
    """Print the machine-readable last line and exit. A raw message (a file path) is passed on
    exactly as it is; any other message is tidied and cut to 300 characters."""
    if raw:
        message = str(message).replace("\r", " ").replace("\n", " ")
    else:
        message = " ".join(str(message).split())[:300]
    print("RESULT " + json.dumps({"status": status, "message": message}), flush=True)
    sys.exit(code)


def clean_folder(name):
    """Same rule as song-download.js cleanFolderName: letters, digits, space
    and _ - ( ) . & ' , only. Leading/trailing dots are dropped so '..' can
    never escape the Audio folder."""
    name = re.sub(r"[^A-Za-z0-9 _\-().&',]", "", name or "")
    name = re.sub(r"\s+", " ", name).strip().strip(".").strip()
    return name[:60]


def clean_song_name(name):
    """Same rule as cleanSongName in song-download.js: control characters become spaces,
    the characters a file name cannot hold (/ \\ : * ? " < > |) are dropped, spaces are
    tidied, leading/trailing dots go, at most 120 characters. Any language is fine."""
    name = re.sub(r"[\x00-\x1f\x7f]", " ", name or "")
    name = re.sub(r'[\\/:*?"<>|]', "", name)
    name = re.sub(r"\s+", " ", name).strip().strip(".").strip()
    return name[:120]


def write_pid():
    """Remember our process id for the Stop button; forget it again on exit."""
    try:
        with open(PID_FILE, "w") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        return

    def forget():
        try:
            with open(PID_FILE) as fh:
                if fh.read().strip() != str(os.getpid()):
                    return          # a newer run owns the file now
            os.remove(PID_FILE)
        except OSError:
            pass

    atexit.register(forget)


def on_signal(signum, _frame):
    global _stopped
    _stopped = True
    if _proc is not None and _proc.poll() is None:
        try:
            os.killpg(_proc.pid, signal.SIGTERM)  # yt-dlp and its ffmpeg children
        except (ProcessLookupError, PermissionError):
            pass


TITLE_TIMEOUT = 90     # seconds to wait for a song's name before giving up


def failure_reason(err, code):
    """The most useful line yt-dlp wrote to stderr."""
    errors = [l.strip() for l in (err or "").splitlines() if l.strip()]
    reason = next((l for l in reversed(errors) if l.startswith("ERROR:")),
                  errors[-1] if errors else "yt-dlp failed (exit %s)" % code)
    return re.sub(r"^ERROR:\s*", "", reason)


def look_up_title(url):
    """--title: print the song's name as the RESULT message, save nothing, and exit."""
    global _proc
    cmd = ["yt-dlp", "--no-playlist", "--skip-download", "--no-warnings", "-q",
           "--print", "title", "--", url]
    _proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, start_new_session=True)
    try:
        out, err = _proc.communicate(timeout=TITLE_TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(_proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        _proc.communicate()
        finish("failed", "Reading the song's name took too long. Check the link and your connection.", 1)
    if _stopped:
        finish("failed", "Stopped", 1)
    title = next((l.strip() for l in (out or "").splitlines() if l.strip()), "")
    if _proc.returncode == 0 and title:
        finish("done", title, 0)
    if _proc.returncode == 0:
        finish("failed", "That link has no song name.", 1)
    print("If this keeps failing, update yt-dlp: pip install -U yt-dlp", file=sys.stderr)
    finish("failed", failure_reason(err, _proc.returncode), 1)


def retag_title(path, title, workdir):
    """Makes the file's title tag match the name it was saved under (the app lists songs by
    their title tag, not by file name). The cover art and other tags are kept. Returns True
    when the tag was changed; on any failure the file is left exactly as it was."""
    global _proc
    out = os.path.join(workdir, "retag" + os.path.splitext(path)[1])
    part = path + ".part"       # not an audio extension, so the app's scan ignores it
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", path,
           "-map", "0", "-c", "copy", "-id3v2_version", "3",
           "-metadata", "title=" + title, out]
    try:
        _proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        if _proc.wait() != 0 or not os.path.isfile(out):
            return False
        shutil.copyfile(out, part)
        os.replace(part, path)
        return True
    except OSError:
        return False
    finally:
        try:
            os.remove(part)
        except OSError:
            pass


def download_to(dest, output, url, retag_name=""):
    """Runs yt-dlp (best audio -> mp3, tags and cover art embedded) into [dest].
    Returns (exit code, saved file path or "", stderr text, whether the title tag was set)."""
    global _proc
    # Half-finished downloads (.webm, .part, thumbnails) go to a temp folder, so
    # the app's music scan never sees them inside Novel/Audio.
    tmp = tempfile.mkdtemp(prefix="song_dl_")
    retagged, saved, err, code = True, "", "", 1
    try:
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "-f", "bestaudio",
            "-x", "--audio-format", "mp3", "--audio-quality", "0",
            "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg",
            "--trim-filenames", "180",
            "-P", "home:" + dest,
            "-P", "temp:" + tmp,
            output,
            "--no-progress", "--no-warnings", "-q",
            "--print", "after_move:filepath", "--no-simulate",
            "--", url,                      # "--" so a link can never act as an option
        ]
        _proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 universal_newlines=True, start_new_session=True)
        out, err = _proc.communicate()
        code = _proc.returncode

        lines = [l.strip() for l in (out or "").splitlines() if l.strip()]
        saved = lines[-1] if lines else ""
        if retag_name and code == 0 and not _stopped and saved and os.path.isfile(saved):
            retagged = retag_title(saved, retag_name, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return code, saved, err, retagged


def stage_song(url):
    """--stage: download into its own folder under the staging area; the RESULT message is the
    file's full path. Nothing appears in the library until place_song() moves it."""
    try:
        os.makedirs(STAGING_ROOT, exist_ok=True)
        run_dir = tempfile.mkdtemp(prefix="s_", dir=STAGING_ROOT)
    except OSError as exc:
        finish("failed", "Can't create %s (%s). Run termux-setup-storage and "
                         "allow storage access." % (STAGING_ROOT, exc.strerror or exc), 1)
    code, saved, err, _ = download_to(run_dir, "--output=%(title)s.%(ext)s", url)
    if _stopped:
        shutil.rmtree(run_dir, ignore_errors=True)
        finish("failed", "Stopped", 1)
    if code == 0 and saved and os.path.isfile(saved):
        finish("done", saved, 0, raw=True)
    shutil.rmtree(run_dir, ignore_errors=True)
    print("If this keeps failing, update yt-dlp: pip install -U yt-dlp", file=sys.stderr)
    finish("failed", failure_reason(err, code), 1)


def place_song(path, name, folder):
    """--place: give a staged song its name (file name and title tag) and move it into its
    playlist folder (or Audio/ itself). The RESULT message is the song's new full path.
    A song that is already there under that name is never overwritten."""
    root = os.path.realpath(STAGING_ROOT)
    real = os.path.realpath(path)
    if not real.startswith(root + os.sep) or not os.path.isfile(real):
        finish("failed", "That song is no longer there. Download it again.", 1)

    ext = os.path.splitext(real)[1]
    stem = name or os.path.splitext(os.path.basename(real))[0]
    dest = os.path.join(AUDIO_ROOT, folder) if folder else AUDIO_ROOT
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as exc:
        finish("failed", "Can't create %s (%s). Run termux-setup-storage and "
                         "allow storage access." % (dest, exc.strerror or exc), 1)
    target = os.path.join(dest, stem + ext)
    if os.path.exists(target):
        finish("failed", "A song called \u201c%s\u201d is already in %s. Change the name." %
               (stem, folder if folder else "All songs"), 1)

    if name:
        tmp = tempfile.mkdtemp(prefix="song_dl_")
        try:
            retagged = retag_title(real, name, tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        if _stopped:
            finish("failed", "Stopped", 1)
        if not retagged:
            finish("failed", "Could not change the song's title (ffmpeg failed).", 1)

    try:
        try:
            os.replace(real, target)            # same storage: an instant move
        except OSError:
            shutil.move(real, target)
    except OSError as exc:
        finish("failed", "Could not move the song (%s)." % (exc.strerror or exc), 1)
    try:
        os.rmdir(os.path.dirname(real))         # the song's own now-empty staging folder
    except OSError:
        pass
    finish("done", target, 0, raw=True)


def main(argv):
    global _proc

    # Options come first; the first thing that is not an option is the link (or, with --place,
    # the optional playlist).
    usage = "Usage: song_dl.py [--title | --stage | --place FILE] [--name NAME] URL [playlist]"
    args = list(argv[1:])
    title_only = stage_only = False
    place_path = ""
    name = ""
    while args and args[0] in ("--title", "--stage", "--place", "--name"):
        flag = args.pop(0)
        if flag == "--title":
            title_only = True
        elif flag == "--stage":
            stage_only = True
        elif not args:
            finish("failed", usage, 2)
        elif flag == "--name":
            name = clean_song_name(args.pop(0))
        else:
            place_path = args.pop(0)

    if place_path:
        if len(args) > 1 or title_only or stage_only:
            finish("failed", usage, 2)
        signal.signal(signal.SIGTERM, on_signal)
        signal.signal(signal.SIGINT, on_signal)
        write_pid()
        if shutil.which("ffmpeg") is None and name:
            finish("failed", "ffmpeg is not installed. Run: pkg install ffmpeg", 1)
        place_song(place_path, name, clean_folder(args[0]) if args else "")      # exits

    if len(args) < 1 or len(args) > (1 if (stage_only or title_only) else 2):
        print(__doc__, file=sys.stderr)
        finish("failed", usage, 2)

    url = args[0].strip()
    folder = clean_folder(args[1]) if len(args) == 2 else ""

    if not re.match(r"^https?://\S+$", url):
        finish("failed", "That doesn't look like a web link.", 1)

    for tool in (("yt-dlp",) if title_only else ("yt-dlp", "ffmpeg")):
        if shutil.which(tool) is None:
            fix = "pip install -U yt-dlp" if tool == "yt-dlp" else "pkg install ffmpeg"
            finish("failed", "%s is not installed. Run: %s" % (tool, fix), 1)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    write_pid()

    if title_only:
        look_up_title(url)          # prints RESULT and exits
    if stage_only:
        stage_song(url)             # prints RESULT and exits

    dest = os.path.join(AUDIO_ROOT, folder) if folder else AUDIO_ROOT
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as exc:
        finish("failed", "Can't create %s (%s). Run termux-setup-storage and "
                         "allow storage access." % (dest, exc.strerror or exc), 1)
    if not os.access(dest, os.W_OK):
        finish("failed", "No write access to %s. Run termux-setup-storage." % dest, 1)

    # With --name the file is saved under that name ("%" is doubled: yt-dlp templates use it).
    # "--output=..." as one piece so a name starting with "-" can never act as an option.
    output = ("--output=" + name.replace("%", "%%") + ".%(ext)s") if name else "--output=%(title)s.%(ext)s"

    code, saved, err, retagged = download_to(dest, output, url, name)

    if _stopped:
        finish("failed", "Stopped", 1)

    where = folder if folder else "Audio"

    if code == 0 and saved and os.path.isfile(saved):
        note = "" if retagged else " (the title tag could not be changed)"
        finish("done", "Saved %s to %s%s" % (os.path.basename(saved), where, note), 0)

    # yt-dlp leaves an existing file alone and may print nothing for it.
    if code == 0 and name and os.path.isfile(os.path.join(dest, name + ".mp3")):
        finish("done", "%s.mp3 is already in %s" % (name, where), 0)

    print("If this keeps failing, update yt-dlp: pip install -U yt-dlp", file=sys.stderr)
    finish("failed", failure_reason(err, code), 1)


if __name__ == "__main__":
    main(sys.argv)

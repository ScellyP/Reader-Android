#!/usr/bin/env python3
"""
song_dl.py - download one song with yt-dlp into the Novel Reader music library.

Run in Termux:
    python song_dl.py URL                 -> /storage/emulated/0/Novel/Audio/
    python song_dl.py URL "Lo-fi Focus"   -> /storage/emulated/0/Novel/Audio/Lo-fi Focus/

Matches the contract in Agent.md for the "Download songs" sheet:
  * one URL per run (the page queues jobs and runs them one at a time)
  * the playlist (folder) name is a separate argument, never part of a shell string
  * the playlist name is cleaned exactly like song-download.js cleanFolderName
  * the LAST line printed is always machine readable:
        RESULT {"status": "done"|"failed", "message": "..."}
    and the exit code is 0 for done, 1 for failed.
  * SIGTERM / Ctrl+C stops yt-dlp and ffmpeg and reports "failed: Stopped".
  * the running script's process id is kept in $TMPDIR/song_dl.pid, so the app's
    Stop button can send it SIGTERM (Termux's RUN_COMMAND cannot stop a command).

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

_proc = None          # running yt-dlp process, so the signal handler can stop it
_stopped = False

# Where the app's Stop button finds this script (see MainActivity / SongDownloader.kt).
PID_FILE = os.path.join(os.environ.get("TMPDIR") or tempfile.gettempdir(), "song_dl.pid")


def finish(status, message, code):
    """Print the machine-readable last line and exit."""
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


def main(argv):
    global _proc

    if len(argv) < 2 or len(argv) > 3:
        print(__doc__, file=sys.stderr)
        finish("failed", "Usage: song_dl.py URL [playlist]", 2)

    url = argv[1].strip()
    folder = clean_folder(argv[2]) if len(argv) == 3 else ""

    if not re.match(r"^https?://\S+$", url):
        finish("failed", "That doesn't look like a web link.", 1)

    for tool in ("yt-dlp", "ffmpeg"):
        if shutil.which(tool) is None:
            fix = "pip install -U yt-dlp" if tool == "yt-dlp" else "pkg install ffmpeg"
            finish("failed", "%s is not installed. Run: %s" % (tool, fix), 1)

    dest = os.path.join(AUDIO_ROOT, folder) if folder else AUDIO_ROOT
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as exc:
        finish("failed", "Can't create %s (%s). Run termux-setup-storage and "
                         "allow storage access." % (dest, exc.strerror or exc), 1)
    if not os.access(dest, os.W_OK):
        finish("failed", "No write access to %s. Run termux-setup-storage." % dest, 1)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    write_pid()

    # Half-finished downloads (.webm, .part, thumbnails) go to a temp folder, so
    # the app's music scan never sees them inside Novel/Audio.
    tmp = tempfile.mkdtemp(prefix="song_dl_")
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
            "-o", "%(title)s.%(ext)s",
            "--no-progress", "--no-warnings", "-q",
            "--print", "after_move:filepath", "--no-simulate",
            "--", url,                      # "--" so a link can never act as an option
        ]
        _proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 universal_newlines=True, start_new_session=True)
        out, err = _proc.communicate()
        code = _proc.returncode
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if _stopped:
        finish("failed", "Stopped", 1)

    lines = [l.strip() for l in (out or "").splitlines() if l.strip()]
    saved = lines[-1] if lines else ""

    if code == 0 and saved and os.path.isfile(saved):
        name = os.path.basename(saved)
        where = folder if folder else "Audio"
        finish("done", "Saved %s to %s" % (name, where), 0)

    errors = [l.strip() for l in (err or "").splitlines() if l.strip()]
    reason = next((l for l in reversed(errors) if l.startswith("ERROR:")),
                  errors[-1] if errors else "yt-dlp failed (exit %s)" % code)
    reason = re.sub(r"^ERROR:\s*", "", reason)
    print("If this keeps failing, update yt-dlp: pip install -U yt-dlp", file=sys.stderr)
    finish("failed", reason, 1)


if __name__ == "__main__":
    main(sys.argv)

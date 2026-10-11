#!/bin/sh
# Builds tagged test files with ffmpeg (+ python3 mutagen for iTunes-style m4a)
# and prints what ReplayGainReader.kt finds in each. Needs: ffmpeg, kotlinc, java.
# Run from the project root:  sh tests/replaygain-reader/run.sh
set -e
D=$(mktemp -d)
ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=2" -y "$D/base.wav"
ffmpeg -loglevel error -y -i "$D/base.wav" -metadata "replaygain_track_gain=-6.50 dB" -metadata "replaygain_track_peak=0.988553" -metadata "replaygain_album_gain=-5.25 dB" -id3v2_version 3 "$D/id3v23.mp3"
ffmpeg -loglevel error -y -i "$D/base.wav" -metadata "REPLAYGAIN_TRACK_GAIN=-3.00 dB" "$D/t.flac"
ffmpeg -loglevel error -y -i "$D/base.wav" -c:a libvorbis -metadata "REPLAYGAIN_TRACK_GAIN=-7.00 dB" "$D/t.ogg"
ffmpeg -loglevel error -y -i "$D/base.wav" -c:a libopus -metadata "R128_TRACK_GAIN=-512" "$D/t.opus"
ffmpeg -loglevel error -y -i "$D/base.wav" -c:a aac -movflags use_metadata_tags -metadata "replaygain_track_gain=-8.20 dB" "$D/t.m4a"
ffmpeg -loglevel error -y -i "$D/base.wav" -c:a libmp3lame "$D/untagged.mp3"
kotlinc app/src/main/java/com/scell/novelreader/redesign/ReplayGainReader.kt tests/replaygain-reader/Main.kt -include-runtime -d "$D/rg.jar"
java -cp "$D/rg.jar" MainKt "$D"
echo "Expected: id3v23 -6.5/-5.25, t.flac -3, t.ogg -7, t.opus +3 (R128 -512 -> -2 + 5), t.m4a -8.2, untagged null, base.wav null"

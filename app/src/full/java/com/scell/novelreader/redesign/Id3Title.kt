package com.scell.novelreader.redesign

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * Changes the title tag of an MP3 without ffmpeg: the app lists songs by their title tag
 * (`readAudioTags` in MainActivity), so a song that is saved under a new name needs the same
 * title inside the file. Pure `java.io`, so it also runs (and is tested) on a plain JVM.
 *
 * Only the title frame (TIT2) of the ID3v2.3 / v2.4 tag at the start of the file is replaced.
 * Every other frame (cover art, artist, ...) and the audio are copied byte for byte, and a
 * trailing ID3v1 tag, if there is one, gets the new title too. The source file is never changed:
 * the result is written to a second file, so a failure leaves the song exactly as it was.
 *
 * Not supported (an [IOException] says so; yt-dlp/ffmpeg never write these): ID3v2.2, tags with
 * unsynchronisation applied to the whole tag, and damaged tags.
 */
object Id3Title {

    @Throws(IOException::class)
    fun copyWithTitle(src: File, dst: File, title: String) {
        RandomAccessFile(src, "r").use { raf ->
            val length = raf.length()
            var major = 3
            var audioStart = 0L
            val keptFrames = ByteArrayOutputStream()

            if (length >= 10) {
                val header = ByteArray(10)
                raf.readFully(header)
                if (header[0] == 'I'.code.toByte() && header[1] == 'D'.code.toByte() && header[2] == '3'.code.toByte()) {
                    major = header[3].toInt()
                    if (major != 3 && major != 4) throw IOException("ID3v2.$major tags are not supported")
                    val flags = header[5].toInt() and 0xFF
                    if (flags and 0x80 != 0) throw IOException("unsynchronised ID3 tags are not supported")
                    val size = syncsafe(header, 6)
                    if (size < 0 || 10L + size > length) throw IOException("the ID3 tag is damaged")
                    val body = ByteArray(size)
                    raf.readFully(body)
                    val footer = if (major == 4 && flags and 0x10 != 0) 10 else 0
                    audioStart = 10L + size + footer

                    var pos = 0
                    if (flags and 0x40 != 0) {                  // an extended header: skip (and drop) it
                        if (body.size < 4) throw IOException("the ID3 tag is damaged")
                        val ext = if (major == 4) syncsafe(body, 0) else bigEndian(body, 0) + 4
                        if (ext < 4 || ext > body.size) throw IOException("the ID3 tag is damaged")
                        pos = ext
                    }
                    while (pos + 10 <= body.size) {
                        if (body[pos].toInt() == 0) break          // padding: no more frames
                        val id = String(body, pos, 4, Charsets.ISO_8859_1)
                        val frameSize = if (major == 4) syncsafe(body, pos + 4) else bigEndian(body, pos + 4)
                        if (frameSize < 0 || pos + 10L + frameSize > body.size) throw IOException("the ID3 tag is damaged")
                        if (id != "TIT2") keptFrames.write(body, pos, 10 + frameSize)
                        pos += 10 + frameSize
                    }
                }
            }

            val titleFrame = if (title.isEmpty()) ByteArray(0) else titleFrame(title, major)
            val bodySize = titleFrame.size + keptFrames.size()

            dst.outputStream().buffered().use { out ->
                out.write(byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), major.toByte(), 0, 0))
                out.write(syncsafeBytes(bodySize))
                out.write(titleFrame)
                keptFrames.writeTo(out)

                // The audio, up to a trailing ID3v1 tag (128 bytes starting with "TAG") if there is one.
                var audioEnd = length
                var v1: ByteArray? = null
                if (length - audioStart >= 128) {
                    val tail = ByteArray(128)
                    raf.seek(length - 128)
                    raf.readFully(tail)
                    if (tail[0] == 'T'.code.toByte() && tail[1] == 'A'.code.toByte() && tail[2] == 'G'.code.toByte()) {
                        v1 = tail
                        audioEnd = length - 128
                    }
                }
                raf.seek(audioStart)
                val buffer = ByteArray(64 * 1024)
                var left = audioEnd - audioStart
                while (left > 0) {
                    val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                    if (n < 0) throw IOException("the file ended unexpectedly")
                    out.write(buffer, 0, n)
                    left -= n
                }
                if (v1 != null) {
                    // ID3v1: the title is bytes 3..32, Latin-1, padded with zeros.
                    for (i in 3 until 33) v1[i] = 0
                    val text = title.map { if (it.code <= 0xFF) it.code.toByte() else '?'.code.toByte() }
                    for (i in 0 until minOf(30, text.size)) v1[3 + i] = text[i]
                    out.write(v1)
                }
            }
        }
    }

    /** A TIT2 frame: Latin-1 when every character fits, otherwise UTF-16 with a byte-order mark. */
    private fun titleFrame(title: String, major: Int): ByteArray {
        val payload = ByteArrayOutputStream()
        if (title.all { it.code <= 0xFF }) {
            payload.write(0)
            payload.write(title.toByteArray(Charsets.ISO_8859_1))
        } else {
            payload.write(1)
            payload.write(0xFF)
            payload.write(0xFE)
            payload.write(title.toByteArray(Charsets.UTF_16LE))
        }
        val size = payload.size()
        val frame = ByteArrayOutputStream()
        frame.write("TIT2".toByteArray(Charsets.ISO_8859_1))
        frame.write(if (major == 4) syncsafeBytes(size) else bigEndianBytes(size))
        frame.write(0)
        frame.write(0)
        payload.writeTo(frame)
        return frame.toByteArray()
    }

    private fun syncsafe(b: ByteArray, at: Int): Int {
        var value = 0
        for (i in 0 until 4) {
            val v = b[at + i].toInt() and 0xFF
            if (v and 0x80 != 0) return -1                      // not a valid size
            value = (value shl 7) or v
        }
        return value
    }

    private fun bigEndian(b: ByteArray, at: Int): Int {
        var value = 0L
        for (i in 0 until 4) value = (value shl 8) or (b[at + i].toLong() and 0xFF)
        return if (value > Int.MAX_VALUE) -1 else value.toInt()
    }

    private fun syncsafeBytes(n: Int) = byteArrayOf(
        ((n shr 21) and 0x7F).toByte(), ((n shr 14) and 0x7F).toByte(),
        ((n shr 7) and 0x7F).toByte(), (n and 0x7F).toByte(),
    )

    private fun bigEndianBytes(n: Int) = byteArrayOf(
        ((n shr 24) and 0xFF).toByte(), ((n shr 16) and 0xFF).toByte(),
        ((n shr 8) and 0xFF).toByte(), (n and 0xFF).toByte(),
    )
}

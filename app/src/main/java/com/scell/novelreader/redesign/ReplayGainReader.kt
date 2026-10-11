package com.scell.novelreader.redesign

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile

/**
 * Reads ReplayGain loudness tags straight out of an audio file.
 *
 * Why this exists: MediaMetadataRetriever (what the library scan uses for
 * title/artist/album) cannot return ReplayGain tags, so they are read here
 * from the file's own bytes. This file uses only java.io - nothing from
 * Android - so it can be tested on a plain JVM.
 *
 * Formats (found by looking at the first bytes, not the file extension):
 *   MP3 / AAC with ID3v2   TXXX frames "replaygain_track_gain" etc. (v2.2-2.4)
 *   MP3 with APEv2         items "REPLAYGAIN_TRACK_GAIN" etc. (mp3gain, foobar)
 *   FLAC                   VORBIS_COMMENT block
 *   Ogg Vorbis / Ogg Opus  comment header packet; Opus R128_*_GAIN also read
 *   M4A / MP4              iTunes "----" free-form atoms
 *   WAV and anything else  no tags -> null
 *
 * Every failure (truncated file, junk tag, huge tag) is caught and gives
 * null: a file whose tags cannot be read just plays at its normal level.
 */
object ReplayGainReader {

    /** Gains are in dB; peaks are linear (1.0 = full scale). Any field may be null. */
    data class Result(
        val trackDb: Double?,
        val albumDb: Double?,
        val trackPeak: Double?,
        val albumPeak: Double?
    )

    private const val MAX_COMMENT_BYTES = 8 * 1024 * 1024
    private const val MAX_SMALL_FRAME = 16 * 1024

    /** Returns the tags found in [file], or null if it has no usable ReplayGain data. */
    fun read(file: File): Result? {
        return try {
            RandomAccessFile(file, "r").use { raf ->
                val tags = LinkedHashMap<String, String>()
                val head = ByteArray(12)
                val n = readUpTo(raf, head)
                when {
                    n >= 3 && head.startsWithAscii("ID3") -> {
                        readId3(raf, tags)
                        readApe(raf, tags)
                    }
                    n >= 4 && head.startsWithAscii("fLaC") -> readFlac(raf, tags)
                    n >= 4 && head.startsWithAscii("OggS") -> readOgg(raf, tags)
                    n >= 12 && head.startsWithAscii("ftyp", 4) -> readMp4(raf, tags)
                    else -> readApe(raf, tags) // MP3 with no ID3v2 header
                }
                toResult(tags)
            }
        } catch (e: Exception) {
            null
        }
    }

    // ---------------------------------------------------------------- result

    /** Turns the collected tag map (lower-case keys) into a [Result]. */
    internal fun toResult(tags: Map<String, String>): Result? {
        val trackDb = parseGainDb(tags["replaygain_track_gain"])
            ?: parseR128(tags["r128_track_gain"])
        val albumDb = parseGainDb(tags["replaygain_album_gain"])
            ?: parseR128(tags["r128_album_gain"])
        val trackPeak = parsePeak(tags["replaygain_track_peak"])
        val albumPeak = parsePeak(tags["replaygain_album_peak"])
        if (trackDb == null && albumDb == null) return null
        return Result(trackDb, albumDb, trackPeak, albumPeak)
    }

    private val numberRegex = Regex("[-+]?(\\d+\\.?\\d*|\\.\\d+)")

    /** "-6.50 dB", "+1.2dB", "-6,5" -> number; junk or absurd values -> null. */
    internal fun parseGainDb(text: String?): Double? {
        if (text == null) return null
        val m = numberRegex.find(text.replace(',', '.')) ?: return null
        val v = m.value.toDoubleOrNull() ?: return null
        return if (v.isFinite() && Math.abs(v) <= 60.0) v else null
    }

    /** Opus R128_*_GAIN: signed Q7.8 dB against -23 LUFS; ReplayGain's reference is -18 LUFS. */
    internal fun parseR128(text: String?): Double? {
        val q = text?.trim()?.toIntOrNull() ?: return null
        val db = q / 256.0 + 5.0
        return if (Math.abs(db) <= 60.0) db else null
    }

    internal fun parsePeak(text: String?): Double? {
        if (text == null) return null
        val m = numberRegex.find(text.replace(',', '.')) ?: return null
        val v = m.value.toDoubleOrNull() ?: return null
        return if (v.isFinite() && v > 0.0 && v <= 64.0) v else null
    }

    // ------------------------------------------------------------------ ID3

    private fun readId3(raf: RandomAccessFile, tags: MutableMap<String, String>) {
        raf.seek(0)
        val h = ByteArray(10)
        raf.readFully(h)
        val ver = h[3].toInt()
        if (ver !in 2..4) return
        val flags = h[5].toInt() and 0xFF
        val end = 10L + synchsafe(h, 6)
        var pos = 10L
        if (ver >= 3 && (flags and 0x40) != 0) { // extended header
            val eh = ByteArray(4)
            raf.seek(pos)
            raf.readFully(eh)
            pos += if (ver == 4) synchsafe(eh, 0).toLong() else be32(eh, 0).toLong() + 4
        }
        val tagUnsync = (flags and 0x80) != 0
        val idLen = if (ver == 2) 3 else 4
        val hdrLen = if (ver == 2) 6 else 10
        val fh = ByteArray(hdrLen)

        while (pos + hdrLen <= end && pos + hdrLen <= raf.length()) {
            raf.seek(pos)
            raf.readFully(fh)
            if (fh[0].toInt() == 0) break // padding
            val id = String(fh, 0, idLen, Charsets.ISO_8859_1)
            if (!id.all { it in 'A'..'Z' || it in '0'..'9' }) break
            val size = when (ver) {
                2 -> (be24(fh, 3)).toLong()
                3 -> be32(fh, 4).toLong()
                else -> synchsafe(fh, 4).toLong()
            }
            val body = pos + hdrLen
            if (size < 0 || body + size > end) break

            if ((id == "TXXX" || id == "TXX") && size in 2..MAX_SMALL_FRAME.toLong()) {
                val f2 = if (ver >= 3) fh[9].toInt() and 0xFF else 0
                val compressedOrEncrypted =
                    if (ver == 4) (f2 and 0x0C) != 0 else if (ver == 3) (f2 and 0xC0) != 0 else false
                if (!compressedOrEncrypted) {
                    var bytes = ByteArray(size.toInt())
                    raf.seek(body)
                    raf.readFully(bytes)
                    val frameUnsync = ver == 4 && (f2 and 0x02) != 0
                    if (tagUnsync || frameUnsync) bytes = removeUnsync(bytes)
                    var skip = 0
                    if (ver == 4 && (f2 and 0x40) != 0) skip += 1 // grouping byte
                    if (ver == 4 && (f2 and 0x01) != 0) skip += 4 // data length indicator
                    if (ver == 3 && (f2 and 0x20) != 0) skip += 1 // grouping byte
                    if (skip < bytes.size) {
                        parseTxxx(bytes.copyOfRange(skip, bytes.size), tags)
                    }
                }
            }
            pos = body + size
        }
    }

    private fun parseTxxx(b: ByteArray, tags: MutableMap<String, String>) {
        if (b.size < 2) return
        val enc = b[0].toInt()
        val wide = enc == 1 || enc == 2
        var i = 1
        // find the description's terminator (one null byte, or an aligned pair for UTF-16)
        var termAt = -1
        if (wide) {
            while (i + 1 < b.size) {
                if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && (i - 1) % 2 == 0) { termAt = i; break }
                i++
            }
        } else {
            while (i < b.size) {
                if (b[i].toInt() == 0) { termAt = i; break }
                i++
            }
        }
        if (termAt < 0) return
        val desc = decodeText(enc, b, 1, termAt)
        val valueStart = termAt + if (wide) 2 else 1
        val value = decodeText(enc, b, valueStart, b.size)
        if (desc.isNotBlank()) tags.putIfAbsent(desc.trim().lowercase(), value.trim { it <= ' ' })
    }

    private fun decodeText(enc: Int, b: ByteArray, from: Int, to: Int): String {
        if (from >= to) return ""
        val cs = when (enc) {
            0 -> Charsets.ISO_8859_1
            1 -> Charsets.UTF_16 // honours a BOM, big-endian without one
            2 -> Charsets.UTF_16BE
            else -> Charsets.UTF_8
        }
        return String(b, from, to - from, cs).trimEnd('\u0000')
    }

    private fun removeUnsync(b: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(b.size)
        var i = 0
        while (i < b.size) {
            out.write(b[i].toInt())
            if ((b[i].toInt() and 0xFF) == 0xFF && i + 1 < b.size && b[i + 1].toInt() == 0) i++
            i++
        }
        return out.toByteArray()
    }

    // ------------------------------------------------------------------ APE

    /** APEv2 footer at the end of the file (before an optional 128-byte ID3v1 tag). */
    private fun readApe(raf: RandomAccessFile, tags: MutableMap<String, String>) {
        val len = raf.length()
        for (off in longArrayOf(32L, 32L + 128L)) {
            if (len < off) continue
            val f = ByteArray(32)
            raf.seek(len - off)
            raf.readFully(f)
            if (!f.startsWithAscii("APETAGEX")) continue
            val size = le32(f, 12) // items + footer, header not counted
            val count = le32(f, 16)
            if (size < 32 || size > 1024 * 1024 || count < 0) return
            val start = len - off - (size - 32)
            if (start < 0) return
            val data = ByteArray(size - 32)
            raf.seek(start)
            raf.readFully(data)
            var p = 0
            for (n in 0 until count) {
                if (p + 8 > data.size) return
                val vs = le32(data, p)
                val flags = le32(data, p + 4)
                p += 8
                var k = p
                while (k < data.size && data[k].toInt() != 0) k++
                if (k >= data.size) return
                val key = String(data, p, k - p, Charsets.ISO_8859_1).lowercase()
                p = k + 1
                if (vs < 0 || p + vs > data.size) return
                if (((flags shr 1) and 3) == 0) { // text item, not binary
                    tags.putIfAbsent(key, String(data, p, vs, Charsets.UTF_8).trim { it <= ' ' })
                }
                p += vs
            }
            return
        }
    }

    // ----------------------------------------------------------------- FLAC

    private fun readFlac(raf: RandomAccessFile, tags: MutableMap<String, String>) {
        raf.seek(4)
        while (true) {
            val h = raf.readUnsignedByte()
            val last = (h and 0x80) != 0
            val type = h and 0x7F
            val len = (raf.readUnsignedByte() shl 16) or (raf.readUnsignedByte() shl 8) or raf.readUnsignedByte()
            if (type == 4) {
                if (len > MAX_COMMENT_BYTES) return
                val b = ByteArray(len)
                raf.readFully(b)
                parseVorbisComments(b, 0, tags)
                return
            }
            raf.seek(raf.filePointer + len)
            if (last) return
        }
    }

    /** Vorbis-comment layout, shared by FLAC, Ogg Vorbis and Ogg Opus. */
    private fun parseVorbisComments(b: ByteArray, start: Int, tags: MutableMap<String, String>) {
        var p = start
        if (p + 4 > b.size) return
        val vendorLen = le32(b, p)
        p += 4
        if (vendorLen < 0 || p + vendorLen > b.size) return
        p += vendorLen
        if (p + 4 > b.size) return
        val count = le32(b, p)
        p += 4
        var i = 0
        while (i < count && p + 4 <= b.size) {
            val l = le32(b, p)
            p += 4
            if (l < 0 || p + l > b.size) break
            val s = String(b, p, l, Charsets.UTF_8)
            p += l
            val eq = s.indexOf('=')
            if (eq > 0) tags.putIfAbsent(s.substring(0, eq).lowercase(), s.substring(eq + 1).trim())
            i++
        }
    }

    // ------------------------------------------------------------------ Ogg

    private fun readOgg(raf: RandomAccessFile, tags: MutableMap<String, String>) {
        raf.seek(0)
        val packet = ByteArrayOutputStream()
        var packetNo = 0
        val hdr = ByteArray(27)
        var pages = 0
        while (pages < 128 && raf.filePointer + 27 <= raf.length()) {
            raf.readFully(hdr)
            if (!hdr.startsWithAscii("OggS")) return
            val nseg = hdr[26].toInt() and 0xFF
            val seg = ByteArray(nseg)
            raf.readFully(seg)
            var dataLen = 0
            for (s in seg) dataLen += s.toInt() and 0xFF
            val data = ByteArray(dataLen)
            raf.readFully(data)
            pages++
            var off = 0
            for (s in seg) {
                val l = s.toInt() and 0xFF
                packet.write(data, off, l)
                off += l
                if (packet.size() > MAX_COMMENT_BYTES) return
                if (l < 255) { // a packet ends on a segment shorter than 255
                    val pk = packet.toByteArray()
                    packet.reset()
                    packetNo++
                    if (packetNo == 2) { // 1 = identification header, 2 = comments
                        if (pk.size > 7 && pk[0].toInt() == 3 && String(pk, 1, 6, Charsets.ISO_8859_1) == "vorbis") {
                            parseVorbisComments(pk, 7, tags)
                        } else if (pk.size > 8 && String(pk, 0, 8, Charsets.ISO_8859_1) == "OpusTags") {
                            parseVorbisComments(pk, 8, tags)
                        }
                        return
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ MP4

    private fun readMp4(raf: RandomAccessFile, tags: MutableMap<String, String>) {
        walkMp4(raf, 0L, raf.length(), arrayOf("moov", "udta", "meta"), 0, tags)
    }

    private fun walkMp4(
        raf: RandomAccessFile, start: Long, end: Long,
        path: Array<String>, depth: Int, tags: MutableMap<String, String>
    ) {
        var pos = start
        while (pos + 8 <= end) {
            raf.seek(pos)
            var size = raf.readInt().toLong() and 0xFFFFFFFFL
            val tb = ByteArray(4)
            raf.readFully(tb)
            val type = String(tb, Charsets.ISO_8859_1)
            var hdr = 8L
            if (size == 1L) { size = raf.readLong(); hdr = 16L } else if (size == 0L) size = end - pos
            if (size < hdr || pos + size > end) return
            if (type == path[depth]) {
                if (depth == path.size - 1) {
                    readMeta(raf, pos + hdr + 4, pos + size, tags) // meta is a "full box": +4 for version/flags
                } else {
                    walkMp4(raf, pos + hdr, pos + size, path, depth + 1, tags)
                }
                return
            }
            pos += size
        }
    }

    /**
     * The contents of a `meta` box. Two tag styles exist and both are read:
     *  - iTunes style (iTunes, foobar2000, mp4gain, mutagen): `ilst` holds
     *    free-form `----` atoms with `name` and `data` children;
     *  - QuickTime style (ffmpeg's use_metadata_tags): a `keys` box lists the
     *    tag names and each `ilst` item is numbered by its 1-based key index.
     */
    private fun readMeta(raf: RandomAccessFile, start: Long, end: Long, tags: MutableMap<String, String>) {
        val keys = ArrayList<String>()
        var pos = start
        while (pos + 8 <= end) {
            raf.seek(pos)
            val size = raf.readInt().toLong() and 0xFFFFFFFFL
            val tb = ByteArray(4)
            raf.readFully(tb)
            val type = String(tb, Charsets.ISO_8859_1)
            if (size < 8 || pos + size > end) return
            if (type == "keys" && size <= 256 * 1024) {
                val body = ByteArray((size - 8).toInt())
                raf.readFully(body)
                if (body.size >= 8) {
                    val count = be32(body, 4)
                    var p = 8
                    for (i in 0 until count) {
                        if (p + 8 > body.size) break
                        val s = be32(body, p)
                        if (s < 8 || p + s > body.size) break
                        keys.add(String(body, p + 8, s - 8, Charsets.UTF_8))
                        p += s
                    }
                }
            } else if (type == "ilst") {
                readIlst(raf, pos + 8, pos + size, keys, tags)
            }
            pos += size
        }
    }

    private fun readIlst(
        raf: RandomAccessFile, start: Long, end: Long,
        keys: List<String>, tags: MutableMap<String, String>
    ) {
        var pos = start
        while (pos + 8 <= end) {
            raf.seek(pos)
            val size = raf.readInt().toLong() and 0xFFFFFFFFL
            val tb = ByteArray(4)
            raf.readFully(tb)
            val type = String(tb, Charsets.ISO_8859_1)
            if (size < 8 || pos + size > end) return
            if (size <= 64 * 1024) {
                val isFreeForm = type == "----"
                val keyIndex = if (isFreeForm) 0 else be32(tb, 0)
                if (isFreeForm || (keyIndex >= 1 && keyIndex <= keys.size)) {
                    val body = ByteArray((size - 8).toInt())
                    raf.readFully(body)
                    var name: String? = if (isFreeForm) null else keys[keyIndex - 1]
                    var value: String? = null
                    var p = 0
                    while (p + 8 <= body.size) {
                        val s = be32(body, p)
                        val t = String(body, p + 4, 4, Charsets.ISO_8859_1)
                        if (s < 8 || p + s > body.size) break
                        if (t == "name" && isFreeForm && s >= 12) name = String(body, p + 12, s - 12, Charsets.UTF_8)
                        if (t == "data" && s >= 16) value = String(body, p + 16, s - 16, Charsets.UTF_8)
                        p += s
                    }
                    if (name != null && value != null) {
                        tags.putIfAbsent(name.trim().lowercase(), value.trim())
                    }
                }
            }
            pos += size
        }
    }

    // -------------------------------------------------------------- helpers

    private fun readUpTo(raf: RandomAccessFile, buf: ByteArray): Int {
        var n = 0
        while (n < buf.size) {
            val r = raf.read(buf, n, buf.size - n)
            if (r < 0) break
            n += r
        }
        return n
    }

    private fun ByteArray.startsWithAscii(s: String, offset: Int = 0): Boolean {
        if (size < offset + s.length) return false
        for (i in s.indices) if (this[offset + i].toInt() != s[i].code) return false
        return true
    }

    private fun synchsafe(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0x7F) shl 21) or ((b[o + 1].toInt() and 0x7F) shl 14) or
            ((b[o + 2].toInt() and 0x7F) shl 7) or (b[o + 3].toInt() and 0x7F)

    private fun be32(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xFF) shl 24) or ((b[o + 1].toInt() and 0xFF) shl 16) or
            ((b[o + 2].toInt() and 0xFF) shl 8) or (b[o + 3].toInt() and 0xFF)

    private fun be24(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xFF) shl 16) or ((b[o + 1].toInt() and 0xFF) shl 8) or (b[o + 2].toInt() and 0xFF)

    private fun le32(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8) or
            ((b[o + 2].toInt() and 0xFF) shl 16) or ((b[o + 3].toInt() and 0xFF) shl 24)
}

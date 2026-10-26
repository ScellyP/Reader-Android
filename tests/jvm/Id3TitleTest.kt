// Plain-JVM checks for Id3Title.kt (no Android needed). Run by tests/kotlin-jvm.test.js, or by hand:
//   kotlinc app/src/main/java/com/scell/novelreader/redesign/Id3Title.kt tests/jvm/Id3TitleTest.kt -include-runtime -d /tmp/id3.jar
//   java -cp /tmp/id3.jar com.scell.novelreader.redesign.Id3TitleTestKt
package com.scell.novelreader.redesign

import java.io.ByteArrayOutputStream
import java.io.File

private var failures = 0

private fun check(name: String, block: () -> Unit) {
    try {
        block()
        println("ok - $name")
    } catch (e: Throwable) {
        failures++
        println("not ok - $name: ${e.message}")
    }
}

private fun expect(cond: Boolean, msg: String) { if (!cond) throw AssertionError(msg) }

private fun syncsafe(n: Int) = byteArrayOf(((n shr 21) and 0x7F).toByte(), ((n shr 14) and 0x7F).toByte(), ((n shr 7) and 0x7F).toByte(), (n and 0x7F).toByte())
private fun be32(n: Int) = byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())

private fun frame(id: String, payload: ByteArray, major: Int): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(id.toByteArray())
    out.write(if (major == 4) syncsafe(payload.size) else be32(payload.size))
    out.write(0); out.write(0)
    out.write(payload)
    return out.toByteArray()
}

private fun latin1(text: String) = byteArrayOf(0) + text.toByteArray(Charsets.ISO_8859_1)

/** An MP3-like file: ID3v2 tag (title, artist, cover), some "audio", optionally an ID3v1 tag. */
private fun makeSong(file: File, major: Int, title: String, padding: Int = 0, v1: Boolean = false, audio: ByteArray = ByteArray(5000) { (it * 7).toByte() }) {
    val body = ByteArrayOutputStream()
    body.write(frame("TIT2", latin1(title), major))
    body.write(frame("TPE1", latin1("Some Artist"), major))
    body.write(frame("APIC", byteArrayOf(0) + "image/jpeg".toByteArray() + byteArrayOf(0, 3, 0) + ByteArray(300) { (it % 251).toByte() }, major))
    body.write(ByteArray(padding))
    val out = ByteArrayOutputStream()
    out.write(byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), major.toByte(), 0, 0))
    out.write(syncsafe(body.size()))
    out.write(body.toByteArray())
    out.write(audio)
    if (v1) {
        val tag = ByteArray(128)
        "TAG".toByteArray().copyInto(tag)
        title.toByteArray(Charsets.ISO_8859_1).copyInto(tag, 3)
        out.write(tag)
    }
    file.writeBytes(out.toByteArray())
}

/** (frame id -> payload) of the ID3v2 tag, plus where the audio starts. */
private fun readTag(bytes: ByteArray): Pair<Map<String, ByteArray>, Int> {
    val major = bytes[3].toInt()
    var size = 0
    for (i in 6..9) size = (size shl 7) or (bytes[i].toInt() and 0x7F)
    val frames = LinkedHashMap<String, ByteArray>()
    var pos = 10
    while (pos + 10 <= 10 + size && bytes[pos].toInt() != 0) {
        val id = String(bytes, pos, 4, Charsets.ISO_8859_1)
        var n = 0
        for (i in 4..7) n = if (major == 4) (n shl 7) or (bytes[pos + i].toInt() and 0x7F) else (n shl 8) or (bytes[pos + i].toInt() and 0xFF)
        frames[id] = bytes.copyOfRange(pos + 10, pos + 10 + n)
        pos += 10 + n
    }
    return frames to (10 + size)
}

private fun titleOf(frames: Map<String, ByteArray>): String {
    val p = frames["TIT2"] ?: return ""
    return when (p[0].toInt()) {
        0 -> String(p, 1, p.size - 1, Charsets.ISO_8859_1)
        1 -> String(p, 3, p.size - 3, Charsets.UTF_16LE)
        else -> throw AssertionError("unexpected encoding ${p[0]}")
    }
}

fun main() {
    val dir = File(System.getProperty("java.io.tmpdir"), "id3test_" + System.nanoTime()).apply { mkdirs() }

    for (major in listOf(3, 4)) {
        check("v2.$major: the title changes, every other frame and the audio stay byte for byte") {
            val src = File(dir, "in$major.mp3"); val dst = File(dir, "out$major.mp3")
            val audio = ByteArray(9000) { (it * 13).toByte() }
            makeSong(src, major, "Old title", padding = 64, audio = audio)
            Id3Title.copyWithTitle(src, dst, "New title")
            val (before, _) = readTag(src.readBytes())
            val bytes = dst.readBytes()
            val (after, audioAt) = readTag(bytes)
            expect(titleOf(after) == "New title", "title is '${titleOf(after)}'")
            expect(after["TPE1"]!!.contentEquals(before["TPE1"]!!), "artist changed")
            expect(after["APIC"]!!.contentEquals(before["APIC"]!!), "cover art changed")
            expect(bytes.copyOfRange(audioAt, bytes.size).contentEquals(audio), "audio changed")
            expect(bytes[3].toInt() == major, "version changed")
            expect(src.readBytes().size > 0 && titleOf(readTag(src.readBytes()).first) == "Old title", "the source was touched")
        }
    }

    check("a title outside Latin-1 is stored as UTF-16 and reads back") {
        val src = File(dir, "u.mp3"); val dst = File(dir, "u_out.mp3")
        makeSong(src, 3, "x")
        val title = "夜に駆ける – Yoru ni Kakeru 🎵"
        Id3Title.copyWithTitle(src, dst, title)
        expect(titleOf(readTag(dst.readBytes()).first) == title, "got '${titleOf(readTag(dst.readBytes()).first)}'")
    }

    check("an ID3v1 tag at the end gets the new title (30 bytes, Latin-1) and the audio before it is untouched") {
        val src = File(dir, "v1.mp3"); val dst = File(dir, "v1_out.mp3")
        val audio = ByteArray(4000) { (it * 3).toByte() }
        makeSong(src, 3, "Old", v1 = true, audio = audio)
        Id3Title.copyWithTitle(src, dst, "A fairly long new title that is more than thirty bytes")
        val bytes = dst.readBytes()
        val v1 = bytes.copyOfRange(bytes.size - 128, bytes.size)
        expect(String(v1, 0, 3) == "TAG", "no v1 tag")
        expect(String(v1, 3, 30, Charsets.ISO_8859_1) == "A fairly long new title that i", "v1 title '${String(v1, 3, 30, Charsets.ISO_8859_1)}'")
        val (_, audioAt) = readTag(bytes)
        expect(bytes.copyOfRange(audioAt, bytes.size - 128).contentEquals(audio), "audio changed")
    }

    check("a file with no ID3 tag gets one, and its bytes follow unchanged") {
        val src = File(dir, "bare.mp3"); val dst = File(dir, "bare_out.mp3")
        val audio = ByteArray(3000) { (it * 5 + 1).toByte() }
        src.writeBytes(audio)
        Id3Title.copyWithTitle(src, dst, "Fresh")
        val bytes = dst.readBytes()
        val (frames, audioAt) = readTag(bytes)
        expect(titleOf(frames) == "Fresh", "title")
        expect(bytes.copyOfRange(audioAt, bytes.size).contentEquals(audio), "audio changed")
    }

    check("a tag without a title frame gets one") {
        val src = File(dir, "notitle.mp3"); val dst = File(dir, "notitle_out.mp3")
        val body = frame("TPE1", latin1("Someone"), 3)
        src.writeBytes(byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), 3, 0, 0) + syncsafe(body.size) + body + ByteArray(100))
        Id3Title.copyWithTitle(src, dst, "Added")
        val frames = readTag(dst.readBytes()).first
        expect(titleOf(frames) == "Added" && frames.containsKey("TPE1"), "frames: ${frames.keys}")
    }

    check("a damaged or unsupported tag is refused and nothing is written over the source") {
        val src = File(dir, "bad.mp3"); val dst = File(dir, "bad_out.mp3")
        src.writeBytes(byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), 3, 0, 0, 0, 0, 0x7F, 0x7F) + ByteArray(20))
        var refused = false
        try { Id3Title.copyWithTitle(src, dst, "x") } catch (e: java.io.IOException) { refused = true }
        expect(refused, "should have thrown")
        val v22 = File(dir, "v22.mp3")
        v22.writeBytes(byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), 2, 0, 0, 0, 0, 0, 10) + ByteArray(40))
        refused = false
        try { Id3Title.copyWithTitle(v22, File(dir, "v22_out.mp3"), "x") } catch (e: java.io.IOException) { refused = true }
        expect(refused, "ID3v2.2 should be refused")
    }

    // A real file made by ffmpeg the way yt-dlp makes it (id3v2.3 + cover), when ffmpeg is installed.
    val real = System.getenv("REAL_MP3")
    if (real != null && File(real).isFile()) {
        check("a real yt-dlp-style mp3: only the title changes") {
            val src = File(real); val dst = File(dir, "real_out.mp3")
            Id3Title.copyWithTitle(src, dst, "Renamed in the app")
            val (before, bAudio) = readTag(src.readBytes())
            val bytes = dst.readBytes()
            val (after, aAudio) = readTag(bytes)
            expect(titleOf(after) == "Renamed in the app", "title '${titleOf(after)}'")
            for ((id, payload) in before) if (id != "TIT2") expect(after[id] != null && after[id]!!.contentEquals(payload), "$id changed")
            expect(bytes.copyOfRange(aAudio, bytes.size - (if (String(bytes, bytes.size - 128, 3) == "TAG") 128 else 0)).size > 0, "no audio")
            println("   (real file: ${before.keys} -> ${after.keys}; audio starts ${bAudio} -> ${aAudio})")
        }
    }

    dir.deleteRecursively()
    if (failures > 0) { println("$failures check(s) failed"); System.exit(1) }
    println("all checks passed")
}

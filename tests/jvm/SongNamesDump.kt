// Used by tests/kotlin-jvm.test.js: reads lines "<kind> <hex of the UTF-8 input>" from the file given as
// the first argument and prints "<hex of the result>" for each, so the Kotlin rules can be compared
// with the JavaScript ones without a JSON library.
package com.scell.novelreader.redesign

import java.io.File

private fun unhex(h: String): String =
    String(ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }, Charsets.UTF_8)

private fun hex(s: String): String = s.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }

fun main(args: Array<String>) {
    for (line in File(args[0]).readLines()) {
        val (kind, h) = line.split(" ").let { it[0] to (it.getOrNull(1) ?: "") }
        val input = unhex(h)
        val out = when (kind) {
            "folder" -> SongNames.cleanFolder(input)
            "song" -> SongNames.cleanSongName(input)
            else -> throw IllegalArgumentException(kind)
        }
        println(hex(out))
    }
}

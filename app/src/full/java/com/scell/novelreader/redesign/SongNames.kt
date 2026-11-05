package com.scell.novelreader.redesign

/**
 * The text rules of the "Download songs" wizard, kept apart from SongDownloader.kt so they run
 * (and are tested) on a plain JVM. `cleanFolder` and `cleanSongName` must give exactly the answers
 * of `cleanFolderName` and `cleanSongName` in song-download.js: tests/kotlin-jvm.test.js compares them.
 */
object SongNames {
    private val badFolderChars = Regex("[^A-Za-z0-9 _\\-().&',]")
    private val spaces = Regex("\\s+")
    private val webLink = Regex("^https?://\\S+$", RegexOption.IGNORE_CASE)
    private val controlChars = Regex("[\\u0000-\\u001f\\u007f]")
    private val badNameChars = Regex("[\\\\/:*?\"<>|]")

    /** Playlist (folder) name: letters, digits, space and `_ - ( ) . & ' ,` only, at most 60 characters. */
    fun cleanFolder(name: String?): String =
        (name ?: "")
            .replace(badFolderChars, "")
            .replace(spaces, " ")
            .trim()
            .trim('.')
            .trim()
            .take(60)

    fun isWebLink(url: String?): Boolean = url != null && webLink.matches(url)

    /** Song name: control characters become spaces, `\ / : * ? " < > |` are dropped, at most 120 characters. */
    fun cleanSongName(name: String?): String {
        val tidy = (name ?: "")
            .replace(controlChars, " ")
            .replace(badNameChars, "")
            .replace(spaces, " ")
            .trim()
            .trim('.')
            .trim()
        // Counted as whole characters (never cutting an emoji in half).
        val cut = if (tidy.codePointCount(0, tidy.length) > 120) tidy.offsetByCodePoints(0, 120) else tidy.length
        return tidy.substring(0, cut)
    }

    /**
     * The most useful line of what yt-dlp wrote to stderr: the last "ERROR:" line, else the last
     * line, tidied and cut to 300 characters.
     */
    fun failureReason(stderr: String?): String {
        val lines = (stderr ?: "").lines().map { it.trim() }.filter { it.isNotEmpty() }
        val line = lines.lastOrNull { it.startsWith("ERROR:") } ?: lines.lastOrNull() ?: ""
        return line.removePrefix("ERROR:").trim().replace(spaces, " ").take(300)
    }
}

# R8 rules for release builds (minifyEnabled true in app/build.gradle).

# Shrink and optimise, but do not rename classes or methods: the stack traces
# written to crash_log.txt stay readable without a mapping file.
-dontobfuscate

# Keep the line information that makes those stack traces useful.
-keepattributes SourceFile,LineNumberTable

# The page calls the methods of the WebView bridge (AndroidBridge) by name from
# JavaScript, so R8 must never remove or rename a @JavascriptInterface method.
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# youtubedl-android (the bundled yt-dlp used by "Download songs"). Its own rules file is not
# applied to apps that use it, so the ones it asks for are repeated here.
-keep class com.yausername.** { *; }
-keep class org.apache.commons.compress.archivers.zip.** { *; }
# Jackson (used by the library for video info) mentions classes Android does not have.
-dontwarn java.beans.**
-dontwarn org.w3c.dom.bind.v1.**
-dontwarn org.codehaus.**

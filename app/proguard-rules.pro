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

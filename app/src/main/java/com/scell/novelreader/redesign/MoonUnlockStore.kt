package com.scell.novelreader.redesign

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * Where the moon-lock's one-hour unlock lives.
 *
 * It used to be a plain number in the WebView's localStorage, measured on the
 * phone's wall clock, so it could be edited or stretched by changing the clock.
 * Now:
 *  - it is kept in this app's private storage (not in the page),
 *  - the record is signed with an HMAC key that lives in the Android Keystore,
 *    so a record that was edited, copied from elsewhere or invented fails the
 *    check and counts as "not unlocked",
 *  - the hour is measured on the monotonic clock (SystemClock.elapsedRealtime),
 *    which does not move when the phone's date or time is changed.
 *
 * The monotonic clock restarts at every reboot, so a record made before a
 * reboot cannot be measured afterwards (the boot counter or the clock going
 * backwards gives it away) and counts as expired. Anything unreadable, unsigned
 * or inconsistent also counts as locked: the store fails closed.
 */
class MoonUnlockStore(context: Context) {

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Starts a new unlock lasting [durationMs]. Returns false if it could not be saved safely. */
    @Synchronized
    fun grant(durationMs: Long): Boolean {
        return try {
            val start = SystemClock.elapsedRealtime()
            val payload = "${bootCount()}|$start|${start + durationMs}"
            val saved = prefs.edit()
                .putString(KEY_RECORD, payload)
                .putString(KEY_MAC, sign(payload))
                .commit()
            if (!saved) clear()
            saved
        } catch (e: Exception) {
            clear()
            false
        }
    }

    /** Milliseconds of unlock left, or 0 when there is none (or it cannot be trusted). */
    @Synchronized
    fun remainingMs(): Long {
        return try {
            val payload = prefs.getString(KEY_RECORD, null) ?: return 0L
            val mac = prefs.getString(KEY_MAC, null) ?: return 0L
            val expected = sign(payload)
            if (!MessageDigest.isEqual(expected.toByteArray(), mac.toByteArray())) {
                clear()
                return 0L
            }
            val parts = payload.split("|")
            if (parts.size != 3) { clear(); return 0L }
            val boot = parts[0].toInt()
            val start = parts[1].toLong()
            val end = parts[2].toLong()
            val now = SystemClock.elapsedRealtime()
            // Another boot, or a clock that is behind the moment of the grant:
            // the record belongs to an earlier run of the phone.
            if (boot != bootCount() || now < start || end <= start) { clear(); return 0L }
            if (now >= end) { clear(); return 0L }
            end - now
        } catch (e: Exception) {
            0L
        }
    }

    @Synchronized
    fun clear() {
        try {
            prefs.edit().remove(KEY_RECORD).remove(KEY_MAC).commit()
        } catch (e: Exception) {
            // Nothing more to do; an unreadable record already counts as locked.
        }
    }

    private fun bootCount(): Int =
        try {
            Settings.Global.getInt(appContext.contentResolver, Settings.Global.BOOT_COUNT, -1)
        } catch (e: Exception) {
            -1
        }

    private fun sign(payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(signingKey())
        return Base64.encodeToString(mac.doFinal(payload.toByteArray()), Base64.NO_WRAP)
    }

    private fun signingKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val PREFS_NAME = "moon_unlock"
        const val KEY_RECORD = "record"
        const val KEY_MAC = "mac"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "novelreader_moon_unlock_v1"
    }
}

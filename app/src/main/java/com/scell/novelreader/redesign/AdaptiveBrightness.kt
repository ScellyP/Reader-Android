package com.scell.novelreader.redesign

import android.app.Activity
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.WindowManager
import kotlin.math.abs
import kotlin.math.ln

/**
 * Sets this app's screen brightness from the phone's ambient light sensor: the screen goes as
 * bright as it can in strong light and all the way down in a dark room. It only touches this
 * window's brightness, never the phone's system setting, and switching it off hands brightness
 * back to the system.
 *
 * The brightness follows the light on a log scale (the eye does too): [DARK_LUX] and below is 0,
 * [BRIGHT_LUX] and above is full, and the readings are smoothed so a passing shadow doesn't make
 * the screen flicker. Listening runs only while the app is on screen.
 *
 * Switched by the "Adaptive brightness" setting through AndroidBridge.setAdaptiveBrightness().
 * Everything here runs on the main thread.
 */
class AdaptiveBrightness(private val activity: Activity) : SensorEventListener {

    private val sensorManager = activity.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val lightSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT)

    private var enabled = false
    private var onScreen = false
    private var listening = false
    private var smoothed = NONE        // smoothed brightness, 0..1
    private var applied = NONE         // last value given to the window

    /** False on phones without a light sensor. */
    val isSupported: Boolean get() = lightSensor != null

    fun setEnabled(on: Boolean) {
        enabled = on
        if (on) startListening() else { stopListening(); handBackToSystem() }
    }

    fun onResume() { onScreen = true; startListening() }

    fun onPause() { onScreen = false; stopListening() }

    private fun startListening() {
        if (!enabled || !onScreen || listening || lightSensor == null) return
        listening = sensorManager.registerListener(this, lightSensor, SensorManager.SENSOR_DELAY_NORMAL)
    }

    private fun stopListening() {
        if (!listening) return
        sensorManager.unregisterListener(this)
        listening = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        val target = brightnessForLux(event.values[0])
        smoothed = if (smoothed == NONE) target else smoothed + (target - smoothed) * SMOOTHING
        setWindowBrightness(smoothed)
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}

    private fun brightnessForLux(lux: Float): Float =
        if (lux <= DARK_LUX) 0f else (ln(lux / DARK_LUX) / ln(BRIGHT_LUX / DARK_LUX)).coerceIn(0f, 1f)

    private fun setWindowBrightness(level: Float) {
        if (abs(level - applied) < MIN_STEP && level != 0f && level != 1f) return
        val params = activity.window.attributes
        params.screenBrightness = level
        activity.window.attributes = params
        applied = level
    }

    private fun handBackToSystem() {
        smoothed = NONE
        applied = NONE
        val params = activity.window.attributes
        params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        activity.window.attributes = params
    }

    private companion object {
        const val NONE = -1f
        const val DARK_LUX = 3f          // about a dark bedroom: the screen is at its dimmest
        const val BRIGHT_LUX = 10_000f   // about daylight in the shade: the screen is at full
        const val SMOOTHING = 0.25f      // share of the gap closed per reading (about 5 per second)
        const val MIN_STEP = 0.01f       // ignore changes smaller than this
    }
}

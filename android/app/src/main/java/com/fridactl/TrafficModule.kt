package com.fridactl

import android.content.Intent
import android.net.VpnService
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray

class TrafficModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "TrafficModule"

    // ── VPN permission check ───────────────────────────────────────────────────
    @ReactMethod
    fun prepareVpn(promise: Promise) {
        try {
            val intent = VpnService.prepare(ctx)
            if (intent == null) {
                // Already granted
                promise.resolve("granted")
            } else {
                // Need to launch activity — caller handles this via the intent
                promise.resolve("needs_permission")
            }
        } catch (e: Exception) {
            promise.reject("VPN_PREPARE_ERROR", e.message)
        }
    }

    // ── Start capture ──────────────────────────────────────────────────────────
    @ReactMethod
    fun startCapture(targetPackage: String, promise: Promise) {
        try {
            // Check if VPN permission is granted
            val vpnIntent = VpnService.prepare(ctx)
            if (vpnIntent != null) {
                promise.reject("VPN_PERMISSION", "VPN permission not granted. Please allow VPN in the dialog first.")
                return
            }

            val intent = Intent(ctx, TrafficVpnService::class.java).apply {
                action = TrafficVpnService.ACTION_START
                putExtra(TrafficVpnService.EXTRA_PKG, targetPackage)
            }
            ctx.startService(intent)

            // Register live packet callback → emit RN event
            TrafficVpnService.onPacketCallback = { entry ->
                try {
                    val params = Arguments.createMap().apply {
                        putDouble("ts", entry.timestamp.toDouble())
                        putString("protocol", entry.protocol)
                        putString("src", entry.srcIp)
                        putString("dst", entry.dstIp)
                        putString("host", KnownPorts.resolve(entry.dstPort) ?: entry.dstIp)
                        putInt("port", entry.dstPort)
                        putInt("len", entry.length)
                        putString("dir", entry.direction)
                    }
                    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("onTrafficPacket", params)
                } catch (_: Exception) {}
            }

            promise.resolve("started")
        } catch (e: Exception) {
            promise.reject("START_ERROR", e.message)
        }
    }

    // ── Stop capture ───────────────────────────────────────────────────────────
    @ReactMethod
    fun stopCapture(promise: Promise) {
        try {
            TrafficVpnService.onPacketCallback = null
            val intent = Intent(ctx, TrafficVpnService::class.java).apply {
                action = TrafficVpnService.ACTION_STOP
            }
            ctx.startService(intent)
            promise.resolve("stopped")
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", e.message)
        }
    }

    // ── Get buffered packets ───────────────────────────────────────────────────
    @ReactMethod
    fun getPackets(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            TrafficVpnService.capturedPackets.takeLast(500).forEach { entry ->
                val map = Arguments.createMap().apply {
                    putDouble("ts", entry.timestamp.toDouble())
                    putString("protocol", entry.protocol)
                    putString("src", entry.srcIp)
                    putString("dst", entry.dstIp)
                    putString("host", KnownPorts.resolve(entry.dstPort) ?: entry.dstIp)
                    putInt("port", entry.dstPort)
                    putInt("len", entry.length)
                    putString("dir", entry.direction)
                }
                arr.pushMap(map)
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("GET_ERROR", e.message)
        }
    }

    // ── Clear buffer ───────────────────────────────────────────────────────────
    @ReactMethod
    fun clearPackets(promise: Promise) {
        TrafficVpnService.capturedPackets.clear()
        promise.resolve("cleared")
    }

    // ── Status ─────────────────────────────────────────────────────────────────
    @ReactMethod
    fun isCapturing(promise: Promise) {
        promise.resolve(TrafficVpnService.isRunning.get())
    }

    // ── Export as JSON string ──────────────────────────────────────────────────
    @ReactMethod
    fun exportJson(promise: Promise) {
        try {
            val ja = JSONArray()
            TrafficVpnService.capturedPackets.forEach { ja.put(it.toJson()) }
            promise.resolve(ja.toString(2))
        } catch (e: Exception) {
            promise.reject("EXPORT_ERROR", e.message)
        }
    }

    // Required for RN event emitter
    @ReactMethod
    fun addListener(eventName: String) {}
    @ReactMethod
    fun removeListeners(count: Int) {}
}

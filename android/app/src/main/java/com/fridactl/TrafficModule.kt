package com.fridactl

import android.content.Intent
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject

class TrafficModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "TrafficModule"

    private fun emit(event: String, params: WritableMap) {
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, params)
        } catch (_: Exception) {}
    }

    // ── VPN permission ─────────────────────────────────────────────────────────
    @ReactMethod
    fun prepareVpn(promise: Promise) {
        val activity = ctx.currentActivity as? MainActivity
        if (activity == null) { promise.reject("NO_ACTIVITY", "Activity not available"); return }
        activity.requestVpnPermission { granted ->
            if (granted) promise.resolve("granted")
            else promise.reject("VPN_DENIED", "VPN permission denied by user")
        }
    }

    // ── Start capture (VPN + HTTP Proxy + optional Frida hook) ─────────────────
    @ReactMethod
    fun startCapture(targetPackage: String, promise: Promise) {
        val activity = ctx.currentActivity as? MainActivity
        if (activity == null) { promise.reject("NO_ACTIVITY", "Activity not available"); return }

        activity.requestVpnPermission { granted ->
            if (!granted) { promise.reject("VPN_DENIED", "VPN permission denied"); return@requestVpnPermission }

            activity.runOnUiThread {
                try {
                    // Register raw packet callback
                    TrafficVpnService.onPacketCallback = { entry ->
                        val params = Arguments.createMap().apply {
                            putDouble("ts", entry.timestamp.toDouble())
                            putString("protocol", entry.protocol)
                            putString("src", entry.srcIp)
                            putString("dst", entry.dstIp)
                            putString("host", KnownPorts.resolve(entry.dstPort) ?: entry.dstIp)
                            putInt("port", entry.dstPort)
                            putInt("len", entry.length)
                            putString("dir", entry.direction)
                            putString("type", "packet")
                        }
                        emit("onTrafficPacket", params)
                    }

                    // Register HTTP proxy callbacks
                    HttpProxyServer.onRequest = { req ->
                        val params = Arguments.createMap().apply {
                            putDouble("id", req.id.toDouble())
                            putDouble("ts", req.ts.toDouble())
                            putString("method", req.method)
                            putString("url", req.url)
                            putString("host", req.host)
                            putString("path", req.path)
                            putString("body", req.body)
                            putString("source", req.source)
                            putString("type", "http_request")
                            // headers as JSON string
                            val hObj = JSONObject()
                            req.headers.forEach { (k, v) -> hObj.put(k, v) }
                            putString("headers", hObj.toString())
                        }
                        emit("onHttpRequest", params)
                    }

                    HttpProxyServer.onResponse = { res ->
                        val params = Arguments.createMap().apply {
                            putDouble("requestId", res.requestId.toDouble())
                            putDouble("ts", res.ts.toDouble())
                            putInt("statusCode", res.statusCode)
                            putString("statusText", res.statusText)
                            putString("body", res.body)
                            putString("source", res.source)
                            putString("type", "http_response")
                            val hObj = JSONObject()
                            res.headers.forEach { (k, v) -> hObj.put(k, v) }
                            putString("headers", hObj.toString())
                        }
                        emit("onHttpResponse", params)
                    }

                    val intent = Intent(ctx, TrafficVpnService::class.java).apply {
                        action = TrafficVpnService.ACTION_START
                        putExtra(TrafficVpnService.EXTRA_PKG, targetPackage)
                    }
                    activity.startService(intent)
                    promise.resolve("started")
                } catch (e: Exception) {
                    promise.reject("START_ERROR", e.message)
                }
            }
        }
    }

    // ── Inject Frida hook for HTTPS ────────────────────────────────────────────
    @ReactMethod
    fun injectFridaHook(targetPackage: String, promise: Promise) {
        if (targetPackage.isEmpty()) {
            promise.reject("NO_PKG", "Target package required for Frida hook")
            return
        }
        try {
            // Read hook script from assets
            val script = ctx.assets.open("traffic_hook.js")
                .bufferedReader().readText()

            // Write script to temp file
            val scriptPath = ctx.filesDir.absolutePath + "/traffic_hook.js"
            java.io.File(scriptPath).writeText(script)

            // Use existing rootBridge shell to run frida
            val fridaPath = ctx.filesDir.absolutePath + "/../files/frida-server"
            // frida-inject approach: inject script into running process
            val cmd = "frida-inject -p \$(pidof $targetPackage 2>/dev/null || " +
                      "frida -U -n $targetPackage --no-pause -q 2>/dev/null | head -1) " +
                      "-s $scriptPath 2>&1 &"

            // Simpler: use frida CLI directly
            val fridaCmd = "frida -U -f $targetPackage -l $scriptPath --no-pause 2>&1 &"

            com.topjohnwu.superuser.Shell.cmd(fridaCmd).submit { result ->
                if (result.isSuccess) {
                    promise.resolve("frida_hook_injected")
                } else {
                    // Try attach mode (app already running)
                    val attachCmd = "frida -U -n $targetPackage -l $scriptPath --no-pause 2>&1 &"
                    com.topjohnwu.superuser.Shell.cmd(attachCmd).submit { r2 ->
                        if (r2.isSuccess) promise.resolve("frida_hook_attached")
                        else promise.reject("FRIDA_ERROR", r2.out.joinToString("\n"))
                    }
                }
            }
        } catch (e: Exception) {
            promise.reject("FRIDA_HOOK_ERROR", e.message)
        }
    }

    // ── Process Frida message (called from ScriptScreen pipeline) ──────────────
    @ReactMethod
    fun processFridaMessage(jsonMsg: String, promise: Promise) {
        try {
            val obj  = JSONObject(jsonMsg)
            val type = obj.optString("type")
            val data = obj.optJSONObject("data") ?: run { promise.resolve("ignored"); return }

            when (type) {
                "request" -> {
                    val req = HttpRequest(
                        id      = data.optLong("id", System.currentTimeMillis()),
                        ts      = data.optLong("ts", System.currentTimeMillis()),
                        method  = data.optString("method", "GET"),
                        url     = data.optString("url"),
                        host    = data.optString("host"),
                        path    = data.optString("path"),
                        headers = parseHeadersJson(data.optString("headers")),
                        body    = data.optString("body"),
                        source  = "frida"
                    )
                    if (HttpProxyServer.requests.size >= 500) HttpProxyServer.requests.removeAt(0)
                    HttpProxyServer.requests.add(req)
                    HttpProxyServer.onRequest?.invoke(req)
                }
                "response" -> {
                    val res = HttpResponse(
                        requestId  = data.optLong("requestId", 0),
                        ts         = data.optLong("ts", System.currentTimeMillis()),
                        statusCode = data.optInt("statusCode", 0),
                        statusText = data.optString("statusText"),
                        headers    = parseHeadersJson(data.optString("headers")),
                        body       = data.optString("body"),
                        source     = "frida"
                    )
                    if (HttpProxyServer.responses.size >= 500) HttpProxyServer.responses.removeAt(0)
                    HttpProxyServer.responses.add(res)
                    HttpProxyServer.onResponse?.invoke(res)
                }
                "hook_status" -> {
                    val params = Arguments.createMap().apply {
                        putBoolean("okhttp",  data.optBoolean("okhttp"))
                        putBoolean("httpurl", data.optBoolean("httpurl"))
                        putDouble("ts", data.optDouble("ts"))
                    }
                    emit("onFridaHookStatus", params)
                }
            }
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("PROCESS_ERROR", e.message)
        }
    }

    private fun parseHeadersJson(s: String): Map<String, String> {
        val map = mutableMapOf<String, String>()
        try {
            val obj = JSONObject(s)
            obj.keys().forEach { k -> map[k] = obj.optString(k) }
        } catch (_: Exception) {}
        return map
    }

    // ── Stop capture ───────────────────────────────────────────────────────────
    @ReactMethod
    fun stopCapture(promise: Promise) {
        try {
            TrafficVpnService.onPacketCallback = null
            HttpProxyServer.onRequest  = null
            HttpProxyServer.onResponse = null
            val intent = Intent(ctx, TrafficVpnService::class.java).apply {
                action = TrafficVpnService.ACTION_STOP
            }
            ctx.startService(intent)
            promise.resolve("stopped")
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", e.message)
        }
    }

    // ── Get buffered raw packets ───────────────────────────────────────────────
    @ReactMethod
    fun getPackets(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            TrafficVpnService.capturedPackets.takeLast(500).forEach { entry ->
                arr.pushMap(Arguments.createMap().apply {
                    putDouble("ts", entry.timestamp.toDouble())
                    putString("protocol", entry.protocol)
                    putString("src", entry.srcIp)
                    putString("dst", entry.dstIp)
                    putString("host", KnownPorts.resolve(entry.dstPort) ?: entry.dstIp)
                    putInt("port", entry.dstPort)
                    putInt("len", entry.length)
                    putString("dir", entry.direction)
                })
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("GET_ERROR", e.message)
        }
    }

    // ── Get HTTP requests ──────────────────────────────────────────────────────
    @ReactMethod
    fun getHttpRequests(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            HttpProxyServer.requests.takeLast(200).forEach { req ->
                arr.pushMap(Arguments.createMap().apply {
                    putDouble("id", req.id.toDouble())
                    putDouble("ts", req.ts.toDouble())
                    putString("method", req.method)
                    putString("url", req.url)
                    putString("host", req.host)
                    putString("path", req.path)
                    putString("body", req.body)
                    putString("source", req.source)
                    val hObj = JSONObject(); req.headers.forEach { (k,v) -> hObj.put(k,v) }
                    putString("headers", hObj.toString())
                    // Find matching response
                    val res = HttpProxyServer.responses.lastOrNull { it.requestId == req.id }
                    if (res != null) {
                        putInt("statusCode", res.statusCode)
                        putString("statusText", res.statusText)
                        putString("resBody", res.body)
                        val rObj = JSONObject(); res.headers.forEach { (k,v) -> rObj.put(k,v) }
                        putString("resHeaders", rObj.toString())
                    }
                })
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("GET_HTTP_ERROR", e.message)
        }
    }

    // ── Clear ──────────────────────────────────────────────────────────────────
    @ReactMethod
    fun clearPackets(promise: Promise) {
        TrafficVpnService.capturedPackets.clear()
        HttpProxyServer.clear()
        promise.resolve("cleared")
    }

    // ── Status ─────────────────────────────────────────────────────────────────
    @ReactMethod
    fun isCapturing(promise: Promise) {
        promise.resolve(TrafficVpnService.isRunning.get())
    }

    // ── Export ─────────────────────────────────────────────────────────────────
    @ReactMethod
    fun exportJson(promise: Promise) {
        try {
            val root = JSONObject()
            // Raw packets
            val pkts = JSONArray()
            TrafficVpnService.capturedPackets.forEach { pkts.put(JSONObject(it.toJson())) }
            root.put("packets", pkts)
            // HTTP
            val reqs = JSONArray()
            HttpProxyServer.requests.forEach { req ->
                val obj = JSONObject().apply {
                    put("id", req.id); put("ts", req.ts)
                    put("method", req.method); put("url", req.url)
                    put("host", req.host); put("path", req.path)
                    put("body", req.body); put("source", req.source)
                    val hObj = JSONObject(); req.headers.forEach { (k,v) -> hObj.put(k,v) }
                    put("headers", hObj)
                    val res = HttpProxyServer.responses.lastOrNull { it.requestId == req.id }
                    if (res != null) {
                        put("statusCode", res.statusCode)
                        put("statusText", res.statusText)
                        put("resBody", res.body)
                        val rObj = JSONObject(); res.headers.forEach { (k,v) -> rObj.put(k,v) }
                        put("resHeaders", rObj)
                    }
                }
                reqs.put(obj)
            }
            root.put("http", reqs)
            promise.resolve(root.toString(2))
        } catch (e: Exception) {
            promise.reject("EXPORT_ERROR", e.message)
        }
    }

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}

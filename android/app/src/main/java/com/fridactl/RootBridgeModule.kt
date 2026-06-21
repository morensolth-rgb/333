package com.fridactl

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.topjohnwu.superuser.Shell
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

class RootBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "RootBridge"

    // Track whether a download is in progress (survives context reloads)
    private var downloadInProgress = false

    // Lifecycle — clean up receiver when React context tears down
    override fun initialize() {
        super.initialize()
        // If service is still running from before a JS reload, re-attach receiver
        if (downloadInProgress) registerDownloadReceiver()
    }

    override fun onCatalystInstanceDestroy() {
        unregisterDownloadReceiver()
        super.onCatalystInstanceDestroy()
    }

    // ─────────────────────────────────────────────
    // BroadcastReceiver — listens to DownloadService events
    // and forwards them to JS via DeviceEventEmitter
    // ─────────────────────────────────────────────

    private var downloadReceiver: BroadcastReceiver? = null

    private fun registerDownloadReceiver() {
        if (downloadReceiver != null) return // already registered
        downloadReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    DownloadService.ACTION_PROGRESS -> {
                        val binary  = intent.getStringExtra(DownloadService.EXTRA_BINARY) ?: ""
                        val percent = intent.getIntExtra(DownloadService.EXTRA_PERCENT, 0)
                        emitEvent("FridaDownloadProgress", Arguments.createMap().apply {
                            putString("binary", binary)
                            putInt("percent", percent)
                        })
                    }
                    DownloadService.ACTION_DONE -> {
                        downloadInProgress = false
                        val msg = intent.getStringExtra(DownloadService.EXTRA_MESSAGE) ?: ""
                        emitEvent("FridaDownloadDone", Arguments.createMap().apply {
                            putString("message", msg)
                        })
                        unregisterDownloadReceiver()
                    }
                    DownloadService.ACTION_ERROR -> {
                        downloadInProgress = false
                        val msg = intent.getStringExtra(DownloadService.EXTRA_MESSAGE) ?: "Unknown error"
                        emitEvent("FridaDownloadError", Arguments.createMap().apply {
                            putString("message", msg)
                        })
                        unregisterDownloadReceiver()
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(DownloadService.ACTION_PROGRESS)
            addAction(DownloadService.ACTION_DONE)
            addAction(DownloadService.ACTION_ERROR)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactApplicationContext.registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactApplicationContext.registerReceiver(downloadReceiver, filter)
        }
    }

    private fun unregisterDownloadReceiver() {
        downloadReceiver?.let {
            try { reactApplicationContext.unregisterReceiver(it) } catch (_: Exception) {}
            downloadReceiver = null
        }
    }

    private fun emitEvent(name: String, params: com.facebook.react.bridge.WritableMap) {
        try {
            // Guard: don't emit if context is no longer alive
            if (!reactApplicationContext.hasActiveCatalystInstance()) return
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(name, params)
        } catch (_: Exception) {}
    }

    companion object {
        private const val FRIDA_PORT     = 27042
        private const val FRIDA_DEST     = "/data/local/tmp/frida-server"
        private const val FRIDA_CLI_DEST = "/data/local/tmp/frida-inject"   // frida-inject binary
        private const val FRIDA_CLI2_DEST= "/data/local/tmp/frida-inject"   // alias — same binary

        init {
            Shell.enableVerboseLogging = false
            Shell.setDefaultBuilder(
                Shell.Builder.create()
                    .setFlags(Shell.FLAG_REDIRECT_STDERR)
                    .setTimeout(60)
            )
        }
    }

    // ─────────────────────────────────────────────
    // Root / shell
    // ─────────────────────────────────────────────

    @ReactMethod
    fun checkRoot(promise: Promise) {
        try {
            val result = Shell.cmd("id").exec()
            promise.resolve(result.out.joinToString("").contains("uid=0"))
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun execShell(cmd: String, promise: Promise) {
        Thread {
            try {
                // Pass cmd directly to Shell (libsu handles root shell internally)
                // Do NOT wrap with sh -c — it breaks quote escaping
                val result = Shell.cmd(cmd).exec()
                val out = result.out.joinToString("\n")
                if (out.isBlank() && result.code != 0) {
                    promise.resolve("ERR:${result.code}")
                } else {
                    promise.resolve(out.ifBlank { "OK" })
                }
            } catch (e: Exception) {
                promise.reject("SHELL_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // Device / environment detection
    // ─────────────────────────────────────────────

    /**
     * Real arch from /proc/cpuinfo — NOT Build.SUPPORTED_ABIS.
     * VMs like VMOS lie about ABI. /proc/cpuinfo is the kernel truth.
     * Returns: "arm64" | "arm" | "x86_64" | "x86"
     */
    private fun detectRealArch(): String {
        // Try /proc/cpuinfo Hardware/CPU architecture field
        val cpuinfo = try {
            Shell.cmd("cat /proc/cpuinfo 2>/dev/null").exec().out.joinToString("\n")
        } catch (_: Exception) { "" }

        return when {
            cpuinfo.contains("aarch64", ignoreCase = true) ||
            cpuinfo.contains("ARMv8",   ignoreCase = true)   -> "arm64"

            cpuinfo.contains("x86_64",  ignoreCase = true) ||
            cpuinfo.contains("AMD64",   ignoreCase = true)   -> "x86_64"

            // fallback: uname -m
            else -> {
                val uname = Shell.cmd("uname -m 2>/dev/null").exec().out.firstOrNull()?.trim() ?: ""
                when {
                    uname.contains("aarch64") -> "arm64"
                    uname.contains("x86_64")  -> "x86_64"
                    uname.contains("i686") || uname.contains("i386") -> "x86"
                    uname.contains("arm")     -> "arm"
                    else -> {
                        // Last resort: Build.SUPPORTED_ABIS
                        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
                        when {
                            abi.startsWith("arm64")   -> "arm64"
                            abi == "x86_64"           -> "x86_64"
                            abi.startsWith("x86")     -> "x86"
                            else                      -> "arm"
                        }
                    }
                }
            }
        }
    }

    /** Frida download arch string from real arch */
    private fun fridaArchFromReal(): String = when (detectRealArch()) {
        "arm64"  -> "android-arm64"
        "x86_64" -> "android-x86_64"
        "x86"    -> "android-x86"
        else     -> "android-arm"
    }

    /**
     * Detect if running inside a VM/emulator (VMOS, NoxPlayer, BlueStacks, etc.)
     * Returns description string or null if physical device.
     */
    private fun detectVmEnvironment(): String? {
        val checks = listOf(
            // VMOS specific
            Shell.cmd("getprop ro.vmos.version 2>/dev/null").exec().out.firstOrNull()?.trim()
                ?.takeIf { it.isNotBlank() }?.let { "VMOS $it" },
            Shell.cmd("getprop ro.product.manufacturer 2>/dev/null").exec().out.firstOrNull()?.trim()
                ?.takeIf { it.equals("VMOS", ignoreCase = true) }?.let { "VMOS" },
            // Generic VM indicators
            Shell.cmd("getprop ro.kernel.qemu 2>/dev/null").exec().out.firstOrNull()?.trim()
                ?.takeIf { it == "1" }?.let { "QEMU emulator" },
            Shell.cmd("getprop ro.build.tags 2>/dev/null").exec().out.firstOrNull()?.trim()
                ?.takeIf { it.contains("test-keys", ignoreCase = true) }?.let { "test-keys build (VM/custom ROM)" },
            // BlueStacks
            Shell.cmd("ls /data/data/com.bluestacks.home 2>/dev/null").exec().isSuccess
                .takeIf { it }?.let { "BlueStacks" },
            // Check if it's actually an x86 kernel pretending to be arm64
            run {
                val realArch  = detectRealArch()
                val buildAbi  = Build.SUPPORTED_ABIS.firstOrNull() ?: ""
                if (realArch == "x86_64" && buildAbi.startsWith("arm")) {
                    "x86_64 kernel with ARM ABI translation (Houdini/NDK translation layer)"
                } else null
            }
        )
        return checks.filterNotNull().firstOrNull()
    }

    /**
     * Validate that a binary actually executes on this device.
     * Runs `binary --version` and checks exit code.
     */
    private fun validateBinary(path: String): Boolean {
        return try {
            val r = Shell.cmd("'$path' --version 2>/dev/null").exec()
            r.isSuccess && r.out.firstOrNull()?.trim()?.isNotBlank() == true
        } catch (_: Exception) { false }
    }

    // ─────────────────────────────────────────────
    // frida-server lifecycle
    // ─────────────────────────────────────────────

    @ReactMethod
    fun startFridaServer(promise: Promise) {
        Thread {
            try {
                // Detect VM environment and warn
                val vmEnv = detectVmEnvironment()
                if (vmEnv != null) {
                    emitScriptLog("⚠ VM detected: $vmEnv")
                    emitScriptLog("⚠ Frida may not work inside virtualized environments")
                    emitScriptLog("   frida-server needs direct kernel access — VMs block this")
                }

                // Detect real arch
                val realArch = detectRealArch()
                emitScriptLog("📱 Arch: $realArch (from /proc/cpuinfo)")

                // Try embedded asset first, then check if already at dest
                val destFile = File(FRIDA_DEST)
                if (!destFile.exists() || destFile.length() < 1024) {
                    try {
                        // Only extract arm64 asset if arch matches
                        if (realArch == "arm64") {
                            extractAsset("frida-server-arm64", FRIDA_DEST)
                        } else {
                            throw Exception("No embedded binary for $realArch — download from Home screen")
                        }
                    } catch (e: Exception) {
                        throw Exception("frida-server binary not found. Please download it from the Home screen first.\n(Device arch: $realArch)")
                    }
                }

                // Validate binary runs on this arch before attempting to start
                Shell.cmd("chmod 755 $FRIDA_DEST").exec()
                if (!validateBinary(FRIDA_DEST)) {
                    throw Exception(
                        "frida-server binary won't execute on this device (arch mismatch?).\n" +
                        "Device arch: $realArch — binary may be wrong arch.\n" +
                        "Delete and re-download from Home screen to get the correct arch."
                    )
                }

                Shell.cmd("pkill -f frida-server 2>/dev/null; true").exec()
                Thread.sleep(500)

                // Use app filesDir for log — /tmp may not exist on all devices
                val fridaLog = "${reactApplicationContext.filesDir}/frida.log"
                Shell.cmd("rm -f '$fridaLog' 2>/dev/null; true").exec()

                // Launch frida-server in passive mode:
                //   --ignore-crashes   : don't intercept/gate app crashes (prevents apps from hanging)
                //   --exit-on-sigterm  : clean shutdown on kill
                // frida-server by default does NOT enable spawn-gating unless explicitly requested via API.
                // If apps are freezing on launch, it means something called Device.enable_spawn_gating()
                // — we never do that, so the issue is frida-server intercepting all zygote forks.
                // Running with no extra flags is correct; if still freezing → SELinux or kernel hook issue.
                Shell.cmd("$FRIDA_DEST --ignore-crashes > '$fridaLog' 2>&1 &").exec()
                Thread.sleep(3000)

                if (isFridaServerRunning()) {
                    promise.resolve("frida-server started on port $FRIDA_PORT")
                } else {
                    val log = Shell.cmd("cat '$fridaLog' 2>/dev/null | tail -10").exec().out.joinToString("\n")
                    promise.reject("START_FAILED", "frida-server not responding. Log: $log")
                }
            } catch (e: Exception) {
                promise.reject("START_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun stopFridaServer(promise: Promise) {
        try {
            Shell.cmd("pkill -f frida-server").exec()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", e.message)
        }
    }

    @ReactMethod
    fun isFridaRunning(promise: Promise) {
        Thread { promise.resolve(isFridaServerRunning()) }.start()
    }

    private fun isFridaServerRunning(): Boolean {
        return try {
            // Method 1: ps — most reliable, works even if SELinux blocks /proc/net
            val psOut = Shell.cmd("ps -A 2>/dev/null | grep frida-server | grep -v grep").exec().out
            if (psOut.isNotEmpty()) return true

            // Method 2: /proc/net/tcp — ARM little-endian byte order
            // 27042 = 0x69A2 → stored as A269
            val portBE = String.format("%04X", FRIDA_PORT).uppercase()
            val portLE = String.format("%02X%02X",
                FRIDA_PORT and 0xFF,
                (FRIDA_PORT shr 8) and 0xFF
            ).uppercase()
            val tcpOut = Shell.cmd(
                "cat /proc/net/tcp6 /proc/net/tcp 2>/dev/null | grep -iE '($portBE|$portLE)'"
            ).exec().out
            if (tcpOut.isNotEmpty()) return true

            // Method 3: try to connect to port 27042 via nc/netcat
            val ncOut = Shell.cmd(
                "nc -z -w1 127.0.0.1 $FRIDA_PORT 2>/dev/null; echo \$?"
            ).exec().out.firstOrNull()?.trim()
            ncOut == "0"
        } catch (e: Exception) { false }
    }

    // ─────────────────────────────────────────────
    // Download frida binaries at runtime
    // progress callback via events (0-100)
    // ─────────────────────────────────────────────

    @ReactMethod
    fun downloadFridaBinaries(version: String, promise: Promise) {
        // Mark download in progress BEFORE starting service
        downloadInProgress = true
        registerDownloadReceiver()

        val intent = Intent(reactApplicationContext, DownloadService::class.java).apply {
            action = DownloadService.ACTION_START
            putExtra(DownloadService.EXTRA_VERSION, version)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            reactApplicationContext.startForegroundService(intent)
        else
            reactApplicationContext.startService(intent)

        promise.resolve("Download started in background")
    }

    private fun downloadFile(url: String, dest: String, onProgress: (Int) -> Unit) {
        // Follow redirects manually (GitHub releases redirect to CDN)
        var currentUrl = url
        var conn: HttpURLConnection
        var redirects = 0
        while (true) {
            conn = URL(currentUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout    = 300000  // 5 min — large binaries on slow connections
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("User-Agent", "FridaCtl/1.0")
            conn.connect()
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location") ?: break
                conn.disconnect()
                currentUrl = loc
                if (++redirects > 10) throw Exception("Too many redirects")
            } else break
        }

        if (conn.responseCode !in 200..299)
            throw Exception("HTTP ${conn.responseCode} for $url")

        val total = conn.contentLengthLong
        var downloaded = 0L
        var lastReported = -1
        val buf = ByteArray(65536)  // 64KB chunks — faster + less GC pressure
        conn.inputStream.use { inp ->
            FileOutputStream(dest).use { out ->
                var n: Int
                while (inp.read(buf).also { n = it } != -1) {
                    out.write(buf, 0, n)
                    downloaded += n
                    if (total > 0) {
                        val pct = ((downloaded * 100) / total).toInt()
                        // Only emit every 2% to avoid flooding the JS bridge
                        if (pct >= lastReported + 2) {
                            lastReported = pct
                            onProgress(pct)
                        }
                    }
                }
            }
        }
        conn.disconnect()
        onProgress(100)
    }

    @ReactMethod
    fun checkBinaries(promise: Promise) {
        val map = Arguments.createMap()
        map.putBoolean("fridaServer", File(FRIDA_DEST).let { it.exists() && it.length() > 1024 })
        map.putBoolean("fridaCli",    File(FRIDA_CLI_DEST).let { it.exists() && it.length() > 1024 })
        map.putBoolean("fridaCli2",   File(FRIDA_CLI_DEST).let { it.exists() && it.length() > 1024 }) // same binary
        map.putString("fridaServerSize", if (File(FRIDA_DEST).exists()) "${File(FRIDA_DEST).length() / 1024}KB" else "missing")
        map.putString("fridaCliSize",    if (File(FRIDA_CLI_DEST).exists()) "${File(FRIDA_CLI_DEST).length() / 1024}KB" else "missing")
        map.putString("fridaCli2Size",   if (File(FRIDA_CLI_DEST).exists()) "${File(FRIDA_CLI_DEST).length() / 1024}KB" else "missing")
        promise.resolve(map)
    }

    // ─────────────────────────────────────────────
    // App listing — ls /data/data via root
    // Gets ALL packages including games
    // ─────────────────────────────────────────────

    // ─────────────────────────────────────────────
    // getInstalledApps — launcher apps (correct name + icon via PM)
    // ─────────────────────────────────────────────
    @ReactMethod
    fun getInstalledApps(promise: Promise) {
        Thread {
            try {
                val pm = reactApplicationContext.packageManager

                // queryIntentActivities = apps visible in launcher (correct names, icons work)
                val intent = android.content.Intent(android.content.Intent.ACTION_MAIN, null)
                intent.addCategory(android.content.Intent.CATEGORY_LAUNCHER)

                @Suppress("DEPRECATION")
                val activities = pm.queryIntentActivities(intent, 0)

                // third-party set for isSystemApp
                val thirdParty = Shell.cmd("pm list packages -3 2>/dev/null").exec().out
                    .filter { it.startsWith("package:") }
                    .map { it.removePrefix("package:").trim() }
                    .toSet()

                val arr = WritableNativeArray()

                for (ri in activities) {
                    val pkg = ri.activityInfo.packageName
                    if (pkg.isBlank()) continue

                    val appName = ri.loadLabel(pm).toString()
                    val isSystem = !thirdParty.contains(pkg)

                    val map = WritableNativeMap()
                    map.putString("packageName", pkg)
                    map.putString("appName", appName)
                    map.putBoolean("isSystemApp", isSystem)
                    arr.pushMap(map)
                }

                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("APPS_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // getAppIcon — returns base64 PNG icon via PM
    // ─────────────────────────────────────────────
    @ReactMethod
    fun getAppIcon(packageName: String, promise: Promise) {
        Thread {
            try {
                val pm = reactApplicationContext.packageManager
                val drawable = pm.getApplicationIcon(packageName)
                val bitmap = drawableToBitmap(drawable)
                val stream = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 90, stream)
                val b64 = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
                promise.resolve("data:image/png;base64,$b64")
            } catch (e: Exception) {
                promise.resolve(null)
            }
        }.start()
    }

    private fun drawableToBitmap(drawable: android.graphics.drawable.Drawable): Bitmap {
        if (drawable is BitmapDrawable && drawable.bitmap != null) {
            return drawable.bitmap
        }
        val w = drawable.intrinsicWidth.takeIf { it > 0 } ?: 96
        val h = drawable.intrinsicHeight.takeIf { it > 0 } ?: 96
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, canvas.width, canvas.height)
        drawable.draw(canvas)
        return bitmap
    }

    // ─────────────────────────────────────────────
    // detectSdks — exposed to JS, runs buildSdkMap and returns as ReadableMap
    // ─────────────────────────────────────────────
    @ReactMethod
    fun detectSdks(promise: Promise) {
        Thread {
            try {
                val thirdParty = Shell.cmd("pm list packages -3 2>/dev/null").exec().out
                    .filter { it.startsWith("package:") }
                    .map { it.removePrefix("package:").trim() }
                    .toSet()
                val sdkMap = buildSdkMap(thirdParty)
                val result = WritableNativeMap()
                for ((pkg, label) in sdkMap) {
                    result.putString(pkg, label)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.resolve(WritableNativeMap()) // never reject — just return empty
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // buildSdkMap — ONE shell command scans ALL user apps at once
    // returns map of pkg → "AppsFlyer · Adjust" etc.
    // ─────────────────────────────────────────────
    private fun buildSdkMap(userPkgs: Set<String>): Map<String, String> {
        val result = mutableMapOf<String, String>()
        try {
            // Single command: for each user package, print "pkg:filename" for every file in shared_prefs
            // Then we parse it all in Kotlin — zero per-app shell calls
            val out = Shell.cmd(
                "for d in /data/data/*/shared_prefs; do " +
                "pkg=\$(echo \$d | cut -d/ -f4); " +
                "ls \$d 2>/dev/null | while read f; do echo \"\$pkg:\$f\"; done; " +
                "done 2>/dev/null"
            ).exec().out

            // Group filenames by package
            val filesByPkg = mutableMapOf<String, MutableList<String>>()
            for (line in out) {
                val colon = line.indexOf(':')
                if (colon < 1) continue
                val pkg = line.substring(0, colon).trim()
                val file = line.substring(colon + 1).trim().lowercase()
                if (pkg.isBlank() || file.isBlank()) continue
                filesByPkg.getOrPut(pkg) { mutableListOf() }.add(file)
            }

            // Classify each package
            for ((pkg, files) in filesByPkg) {
                if (!userPkgs.contains(pkg)) continue // skip system apps
                val sdks = mutableListOf<String>()
                if (files.any { it.contains("appsflyer") }) sdks.add("AppsFlyer")
                if (files.any { it.contains("adjust") })    sdks.add("Adjust")
                if (files.any { it.contains("singular") })  sdks.add("Singular")
                if (files.any { it.contains("branch") })    sdks.add("Branch")
                if (files.any { it.contains("kochava") })   sdks.add("Kochava")
                if (files.any { it.contains("tenjin") })    sdks.add("Tenjin")
                if (files.any { it.contains("amplitude") }) sdks.add("Amplitude")
                if (files.any { it.contains("mixpanel") })  sdks.add("Mixpanel")
                if (files.any { it.contains("onesignal") }) sdks.add("OneSignal")
                if (files.any { it.contains("segment") })   sdks.add("Segment")
                if (sdks.isNotEmpty()) result[pkg] = sdks.joinToString(" · ")
            }
        } catch (_: Exception) {}
        return result
    }

    // ─────────────────────────────────────────────
    // runScript — attach/spawn via frida CLI binary
    // frida CLI writes console.log to stdout directly
    // → we read inputStream in real-time (no logfile needed)
    // promise resolves once script is loaded; output streams
    // via FridaScriptLog events until process exits / stopScript()
    // ─────────────────────────────────────────────

    // The live frida-inject process — killed on stopScript
    @Volatile private var fridaProcess: Process? = null
    // The persistent logcat process — keeps running until stopScript() is called
    @Volatile private var fridaLogcatProc: Process? = null
    // Legacy signal flag (used by errLog tail thread)
    @Volatile private var fridaScriptPid: String? = null
    // Track whether WE changed SELinux to Permissive — so we can restore it after inject
    @Volatile private var selinuxWasEnforcing: Boolean = false

    @ReactMethod
    fun stopScript(promise: Promise) {
        Thread {
            fridaScriptPid = null

            // Kill frida-inject process
            fridaProcess?.let { p ->
                try {
                    p.outputStream?.let { os ->
                        try { os.write("%resume\n".toByteArray()); os.flush() } catch (_: Exception) {}
                    }
                    Thread.sleep(300)
                    p.destroy()
                } catch (_: Exception) {}
            }
            fridaProcess = null

            // Kill the persistent logcat — user explicitly stopped
            try { fridaLogcatProc?.destroy() } catch (_: Exception) {}
            fridaLogcatProc = null
            try { Shell.cmd("pkill -f 'logcat.*Frida' 2>/dev/null; true").exec() } catch (_: Exception) {}

            // Restore SELinux to Enforcing if we changed it
            if (selinuxWasEnforcing) {
                Shell.cmd("setenforce 1 2>/dev/null; true").exec()
                selinuxWasEnforcing = false
                emitScriptLog("🔒 SELinux restored to Enforcing")
            }

            // Kill frida-server so it stops intercepting new process spawns
            Shell.cmd("pkill -f frida-server 2>/dev/null; true").exec()
            emitScriptLog("⚙ frida-server stopped")

            // ── Unfreeze any process that was paused by frida spawn ────────────
            // When user stops script mid-spawn, the game process may be stuck in ptrace-stop.
            // Send SIGCONT + kill frida to release it. If still frozen → force-stop + relaunch.
            try {
                val allPids = Shell.cmd("ps -A -o pid,name 2>/dev/null | grep -v 'com.fridactl'")
                    .exec().out
                // We don't know which package was spawned, so just send SIGCONT to all non-system PIDs
                // that are in D/T state (stopped). Harmless to running processes.
                Shell.cmd("for p in \$(ls /proc | grep -E '^[0-9]+\
        }.start()
    }

    @ReactMethod
    fun runScript(packageName: String, script: String, mode: String, promise: Promise) {
        Thread {
            try {
                // ── 1. Ensure frida-inject binary ─────────────────────────────
                val realArch = detectRealArch()
                emitScriptLog("📱 Arch: $realArch")

                // Detect VM and warn
                val vmEnv = detectVmEnvironment()
                if (vmEnv != null) {
                    emitScriptLog("⚠ VM: $vmEnv")
                    emitScriptLog("   Frida requires direct kernel access — may not work in VM")
                }

                val injectFile = File(FRIDA_CLI_DEST)
                if (!injectFile.exists() || injectFile.length() < 1024) {
                    try {
                        if (realArch == "arm64") {
                            extractAsset("frida-inject-arm64", FRIDA_CLI_DEST)
                            emitScriptLog("📦 Extracted frida-inject (arm64) from assets")
                        } else {
                            promise.reject("RUN_ERROR",
                                "frida-inject missing — download from Home screen first\n(Device arch: $realArch, need matching binary)")
                            return@Thread
                        }
                    } catch (_: Exception) {
                        promise.reject("RUN_ERROR", "frida-inject binary missing — download from Home screen first\n(Device arch: $realArch)")
                        return@Thread
                    }
                }
                Shell.cmd("chmod 755 $FRIDA_CLI_DEST").exec()

                // Validate binary actually runs on this device
                if (!validateBinary(FRIDA_CLI_DEST)) {
                    emitScriptLog("❌ frida-inject won't execute (arch mismatch or corrupt binary)")
                    emitScriptLog("   Device: $realArch — delete binary and re-download from Home screen")
                    promise.reject("RUN_ERROR",
                        "frida-inject cannot execute on this device.\n" +
                        "Arch: $realArch — re-download the correct version from Home screen.")
                    return@Thread
                }

                // ── 1c. Version mismatch check ────────────────────────────────
                // exit 4 is most commonly caused by frida-inject ≠ frida-server version
                // Check and warn early so the user knows immediately
                val injectVer = Shell.cmd("$FRIDA_CLI_DEST --version 2>/dev/null").exec()
                    .out.firstOrNull()?.trim()
                val serverVer = Shell.cmd("$FRIDA_DEST --version 2>/dev/null").exec()
                    .out.firstOrNull()?.trim()
                if (injectVer != null) emitScriptLog("🔧 frida-inject: $injectVer")
                if (serverVer  != null) emitScriptLog("🔧 frida-server: $serverVer")
                if (injectVer != null && serverVer != null && injectVer != serverVer) {
                    emitScriptLog("⚠ VERSION MISMATCH: frida-inject=$injectVer ≠ frida-server=$serverVer")
                    emitScriptLog("⚠ This WILL cause exit 4. Re-download both from the same release on Home screen.")
                }

                // ── 1b. Disable ptrace restrictions ───────────────────────────
                // "Unable to perform ptrace cont: I/O error" = kernel blocks ptrace
                // Fix: set ptrace_scope=0 and set SELinux to permissive
                // IMPORTANT: validate each change actually took effect before continuing
                val ptrace = Shell.cmd("cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null").exec()
                    .out.firstOrNull()?.trim()
                if (ptrace != null && ptrace != "0") {
                    emitScriptLog("⚙ ptrace_scope=$ptrace → setting to 0")
                    Shell.cmd("echo 0 > /proc/sys/kernel/yama/ptrace_scope 2>/dev/null; true").exec()
                    // Validate ptrace_scope actually changed (up to 1s)
                    var ptraceOk = false
                    repeat(10) {
                        Thread.sleep(100)
                        val cur = Shell.cmd("cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null").exec()
                            .out.firstOrNull()?.trim()
                        if (cur == "0") { ptraceOk = true; return@repeat }
                    }
                    if (!ptraceOk) emitScriptLog("⚠ ptrace_scope did not change — device may block this")
                    else emitScriptLog("✓ ptrace_scope=0 confirmed")
                }
                val selinux = Shell.cmd("getenforce 2>/dev/null").exec().out.firstOrNull()?.trim()
                if (selinux != null && selinux.equals("Enforcing", ignoreCase = true)) {
                    selinuxWasEnforcing = true
                    emitScriptLog("⚙ SELinux Enforcing → setting Permissive (will restore after inject)")
                    Shell.cmd("setenforce 0 2>/dev/null; true").exec()
                    var seOk = false
                    repeat(20) {
                        Thread.sleep(100)
                        val cur = Shell.cmd("getenforce 2>/dev/null").exec().out.firstOrNull()?.trim()
                        if (cur != null && cur.equals("Permissive", ignoreCase = true)) {
                            seOk = true; return@repeat
                        }
                    }
                    if (!seOk) emitScriptLog("⚠ SELinux did not switch to Permissive — injection may fail")
                    else emitScriptLog("✓ SELinux=Permissive confirmed")
                } else {
                    selinuxWasEnforcing = false
                }
                // Extra buffer: give kernel 300ms after all policy changes before injecting
                Thread.sleep(300)

                // ── 2. Write script to device ─────────────────────────────────
                val scriptPath = "/data/local/tmp/hook_${packageName.replace('.', '_')}.js"
                val tmp = "${reactApplicationContext.filesDir}/hook_tmp.js"
                File(tmp).writeText(script)
                Shell.cmd("cp '$tmp' '$scriptPath' && chmod 644 '$scriptPath'").exec()
                emitScriptLog("📝 Script → $scriptPath")

                // ── 3. Build command based on mode ────────────────────────────
                //
                // IMPORTANT — frida-inject capability matrix (frida 16+):
                //   -f (spawn)  → on Android 10+ SELinux strict REQUIRES frida-server
                //   -p (pid)    → requires frida-server        ⚠
                //   -n (name)   → requires frida-server        ⚠
                //
                // All modes go through frida-server for reliability
                //
                val cmd: String
                val modeLabel: String

                when (mode) {
                    "spawn" -> {
                        // Spawn via frida-server (required on Android 10+ / frida 16+)
                        emitScriptLog("⚙ Spawn mode — starting frida-server...")
                        if (!ensureFridaServer()) {
                            promise.reject("RUN_ERROR",
                                "frida-server failed to start.\nDownload frida-server from Home screen first.")
                            return@Thread
                        }

                        // Kill any existing instance of the app so we get a clean spawn
                        Shell.cmd("am force-stop '$packageName' 2>/dev/null; true").exec()
                        Thread.sleep(1500)  // wait for app to fully die

                        // Verify the app is truly dead before spawning
                        val stillRunning = Shell.cmd("pidof '$packageName' 2>/dev/null").exec().out.firstOrNull()?.trim()
                        if (!stillRunning.isNullOrBlank()) {
                            Shell.cmd("kill -9 $stillRunning 2>/dev/null; true").exec()
                            Thread.sleep(500)
                        }

                        emitScriptLog("🔄 Force-stopped $packageName — spawning with frida...")
                        emitScriptLog("ℹ Spawn injects BEFORE app code runs — bypasses anti-tamper startup checks")

                        // frida-inject -D local -f <pkg> --no-pause
                        // --no-pause: resume app immediately after script loads (don't keep paused)
                        // WITHOUT --no-pause: app stays paused forever if frida-inject dies → freeze bug
                        // --runtime=qjs: QuickJS runtime — lighter, more compatible on locked-down devices
                        cmd = "$FRIDA_CLI_DEST -D local -f '$packageName' --script '$scriptPath' --no-pause --runtime=qjs"
                        modeLabel = "spawn (via server)"
                    }
                    "name" -> {
                        // Attach by name — resolve REAL process name from ps, not package name
                        // frida-inject -n expects the process name (comm), not the package name
                        // e.g. com.game.foo → process name is often "game.foo" or "com.game.foo"
                        emitScriptLog("⚙ Name mode — resolving process name...")
                        if (!ensureFridaServer()) {
                            promise.reject("RUN_ERROR",
                                "frida-server failed to start.\n" +
                                "Download frida-server from Home screen, or use SPAWN mode instead.")
                            return@Thread
                        }
                        // Resolve the real process name from /proc/<pid>/cmdline or ps
                        val namePid = resolvePid(packageName) ?: run {
                            promise.reject("RUN_ERROR",
                                "Process '$packageName' not running — launch the app first, then use Name mode")
                            return@Thread
                        }
                        val cleanNamePid = namePid.filter { it.isDigit() }
                        // Get the actual process name from /proc/<pid>/cmdline (null-delimited, first token)
                        val procName = Shell.cmd(
                            "cat /proc/$cleanNamePid/cmdline 2>/dev/null | tr '\\0' '\\n' | head -1"
                        ).exec().out.firstOrNull()?.trim()?.ifBlank { null }
                            ?: packageName  // fallback to package name
                        emitScriptLog("⚙ Resolved process name: '$procName' (PID $cleanNamePid)")
                        // Use PID instead of name to avoid process name truncation issues (15-char limit)
                        // frida-inject -n can fail if process name > 15 chars (kernel truncates comm)
                        cmd = "$FRIDA_CLI_DEST -D local -p $cleanNamePid --script '$scriptPath'"
                        modeLabel = "name→PID $cleanNamePid ($procName)"
                    }
                    else -> {   // pid
                        // Attach by PID — needs frida-server
                        emitScriptLog("⚙ PID mode requires frida-server...")
                        if (!ensureFridaServer()) {
                            promise.reject("RUN_ERROR",
                                "frida-server failed to start.\n" +
                                "Download frida-server from Home screen, or use SPAWN mode instead.")
                            return@Thread
                        }
                        // Find PID directly — do NOT use resolvePid() here because it auto-launches
                        var pid = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
                            .exec().out.firstOrNull()?.trim()?.ifBlank { null }

                        if (pid == null) {
                            // App not running — launch via am start (more reliable than monkey for some devices)
                            emitScriptLog("⚙ App not running — launching $packageName...")
                            Shell.cmd(
                                "am start -n \"\$(cmd package resolve-activity --brief '$packageName' 2>/dev/null | tail -1)\" 2>/dev/null; " +
                                "monkey -p '$packageName' -c android.intent.category.LAUNCHER 1 2>/dev/null; true"
                            ).exec()

                            // Poll up to 15s for process to appear
                            repeat(30) { i ->
                                Thread.sleep(500)
                                val found = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
                                    .exec().out.firstOrNull()?.trim()?.ifBlank { null }
                                if (found != null) {
                                    pid = found
                                    emitScriptLog("✓ Process appeared after ${(i + 1) * 500}ms (PID $found)")
                                    return@repeat
                                }
                            }
                        }

                        if (pid == null) {
                            // App appeared briefly but already died — typical anti-tamper behavior
                            // when frida-server is running in background
                            emitScriptLog("❌ Process not found — app may have detected frida-server and quit")
                            emitScriptLog("💡 Anti-tamper games (Coin Master, etc.) detect frida-server on startup")
                            emitScriptLog("💡 Try SPAWN mode — it injects before the app's anti-tamper runs")
                            promise.reject("RUN_ERROR",
                                "Cannot find process for $packageName — app likely detected frida-server and quit.\n\n" +
                                "→ Use SPAWN mode instead (injects before anti-tamper initializes)")
                            return@Thread
                        }

                        // Wait for app to initialize before injecting
                        emitScriptLog("⏳ App found (PID $pid) — waiting 3s for initialization...")
                        Thread.sleep(3000)

                        // Re-check process still alive after wait
                        val stillAlive = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
                            .exec().out.firstOrNull()?.trim()?.ifBlank { null }
                        if (stillAlive == null) {
                            emitScriptLog("❌ App died during initialization wait — anti-tamper detected frida-server")
                            emitScriptLog("💡 Switch to SPAWN mode for anti-cheat/anti-tamper games")
                            promise.reject("RUN_ERROR",
                                "App quit after launch — anti-tamper active.\n→ Use SPAWN mode instead.")
                            return@Thread
                        }

                        val cleanPid = pid!!.filter { it.isDigit() }
                        if (cleanPid.isEmpty()) {
                            promise.reject("RUN_ERROR", "Invalid PID: '$pid'")
                            return@Thread
                        }
                        cmd = "$FRIDA_CLI_DEST -D local -p $cleanPid --script '$scriptPath'"
                        modeLabel = "PID $cleanPid (via server)"
                    }
                }

                emitScriptLog("🚀 frida-inject $modeLabel...")
                emitScriptLog("▶ $cmd")

                // Extract PID from cmd for logcat --pid filter (improves output on some devices)
                val logcatPid = Regex("""-p\s+(\d+)""").find(cmd)?.groupValues?.get(1)?.toIntOrNull()

                // ── 4. Start logcat BEFORE frida-inject so no output is missed ──
                startPersistentLogcat(logcatPid)

                // ── 5. Launch frida-inject ────────────────────────────────────
                runFridaProcess(cmd, promise)

            } catch (e: Exception) {
                promise.reject("RUN_ERROR", e.message)
            }
        }.start()
    }

    // Starts logcat BEFORE frida-inject so no early output is missed.
    // Strategy:
    //   Primary  — filter by Frida/frida/FRIDA tags (works on most devices)
    //   Fallback — if no output in 8s, switch to unfiltered logcat and grep for hook keywords
    //              This catches devices where frida console.log routes under a different tag
    private fun startPersistentLogcat(targetPid: Int? = null) {
        try { fridaLogcatProc?.destroy() } catch (_: Exception) {}
        fridaLogcatProc = null

        // Clear logcat buffer first so we don't get stale output
        try { ProcessBuilder("su", "-c", "logcat -c 2>/dev/null").start().waitFor() } catch (_: Exception) {}

        // Build filter string — PID filter + known Frida tags
        val pidFilter = if (targetPid != null) "--pid=$targetPid" else ""
        val tagFilter = "Frida:V frida:V FRIDA:V frida-server:V frida-inject:V *:S"

        // Primary logcat command — tag-filtered
        val primaryCmd = "logcat -v raw $pidFilter -s Frida:V frida:V FRIDA:V frida-server:V frida-inject:V 2>/dev/null"
        // Fallback — unfiltered, we grep for hook output ourselves
        val fallbackCmd = "logcat -v raw 2>/dev/null"

        var linesReceived = 0
        val startTime = System.currentTimeMillis()
        var usedFallback = false

        fun launchLogcat(cmd: String): Process? = try {
            ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start()
        } catch (_: Exception) { null }

        var proc = launchLogcat(primaryCmd) ?: return
        fridaLogcatProc = proc
        emitScriptLog("📡 Logcat streaming (runs until you press STOP)...")

        Thread {
            try {
                proc.inputStream.bufferedReader().use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isBlank()) continue
                        linesReceived++
                        emitScriptLog(line)
                    }
                }
            } catch (_: Exception) {}

            // Primary ended — if we never got output and fallback not yet tried, switch to filtered logcat
            if (linesReceived == 0 && !usedFallback && fridaLogcatProc != null) {
                usedFallback = true
                emitScriptLog("⚠ No Frida-tagged output — switching to filtered logcat")
                val proc2 = launchLogcat(fallbackCmd) ?: return@Thread
                fridaLogcatProc = proc2
                // Only show lines relevant to script execution — filter noise
                val hookRx = Regex(
                    """\[|hook|cipher|key|inject|frida|console|send|recv|error|warn|crash|memory|scan|bypass|patch""",
                    RegexOption.IGNORE_CASE
                )
                try {
                    proc2.inputStream.bufferedReader().use { reader ->
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isBlank()) continue
                            if (hookRx.containsMatchIn(line)) emitScriptLog(line)
                        }
                    }
                } catch (_: Exception) {}
            }

            emitScriptLog("📡 Logcat stopped")
        }.also { it.isDaemon = true }.start()

        // Watchdog: if no output after 8s, kill primary and let fallback take over
        Thread {
            Thread.sleep(8000)
            if (linesReceived == 0 && !usedFallback && fridaLogcatProc == proc) {
                try { proc.destroy() } catch (_: Exception) {}
                // Thread above will detect empty output and launch fallback
            }
        }.also { it.isDaemon = true }.start()
    }

    // Runs the frida-inject command as a root Process, streams all output → FridaScriptLog
    private fun runFridaProcess(cmd: String, promise: Promise) {
        fridaProcess?.destroy()
        fridaProcess = null
        fridaScriptPid = null

        val filesDir  = reactApplicationContext.filesDir.absolutePath
        val outLog    = "$filesDir/fi_out.log"
        val errLog    = "$filesDir/fi_err.log"

        // frida-inject needs a TTY — piping stdout/stderr to a file breaks tcgetattr → EXIT:4
        // Confirmed fix: setsid WITHOUT stdout/stderr redirect works (tested manually)
        // We redirect stdin from /dev/null + capture stderr only for error diagnosis
        // Real frida script output (console.log) goes through logcat automatically
        Shell.cmd("rm -f '$outLog' '$errLog' 2>/dev/null; true").exec()

        // frida-inject writes console.log to stdout (piped mode) or PTY slave (TTY mode).
        // setsid </dev/ptmx redirects stdin from PTY master — stdout still goes to the file correctly
        // ONLY when the slave fd is open. Without a slave, frida detects no TTY and writes to stdout→file.
        //
        // CONFIRMED WORKING STRATEGY:
        //   Run frida-inject with stdout+stderr redirected to files — no PTY wrapper.
        //   frida-inject will print "tcgetattr: Inappropriate ioctl" to stderr (we filter it).
        //   console.log output goes to stdout → outLog. This is the most reliable cross-device approach.
        //
        //   If 'script' is available, use it — it gives frida a real PTY and captures everything.
        val hasScript = Shell.cmd("which script 2>/dev/null").exec().out.firstOrNull()?.trim()?.isNotBlank() == true

        val wrapper = if (hasScript) {
            emitScriptLog("🖥 PTY capture via script")
            // script -q -c 'CMD' /dev/null — CMD gets a real PTY slave; all output captured to script stdout → outLog
            "script -q -c '$cmd' /dev/null >'$outLog' 2>'$errLog'; echo \"EXIT:\$?\" >>'$outLog'"
        } else {
            emitScriptLog("🖥 Direct capture (no PTY — tcgetattr warning is normal)")
            // No PTY tools. frida prints tcgetattr warning to stderr (filtered below).
            // console.log goes to stdout → outLog. Works reliably.
            "$cmd >'$outLog' 2>&1; echo \"EXIT:\$?\" >>'$outLog'"
        }

        val pb = ProcessBuilder("su", "-c", wrapper)
        pb.redirectErrorStream(true)

        val proc: Process
        try {
            proc = pb.start()
        } catch (e: Exception) {
            promise.reject("RUN_ERROR", "Cannot start process: ${e.message}")
            return
        }

        fridaProcess   = proc
        fridaScriptPid = "running"

        var promiseResolved = false

        val noiseRx = Regex(
            "tcgetattr|isatty|not a tty|inappropriate ioctl|Script (started|done)|stty:",
            RegexOption.IGNORE_CASE
        )

        // ── Stream outLog in real-time (stdout from frida-inject — console.log + send() output) ──
        Thread {
            try {
                val tailProc = ProcessBuilder("su", "-c", "tail -f '$outLog' 2>/dev/null")
                    .redirectErrorStream(true).start()
                try {
                    tailProc.inputStream.bufferedReader().use { r ->
                        while (fridaScriptPid != null || proc.isAlive) {
                            val l = r.readLine() ?: break
                            if (l.isBlank()) continue
                            if (l.startsWith("EXIT:")) continue
                            if (noiseRx.containsMatchIn(l)) continue
                            emitScriptLog(l)
                        }
                    }
                } catch (_: Exception) {}
                try { tailProc.destroy() } catch (_: Exception) {}
            } catch (_: Exception) {}
        }.start()

        // errLog not streamed separately — stderr is merged into outLog via 2>&1
        // (when using script, errLog captures script's own stderr which is minimal)

        Thread {
            // Drain the process stdout (mostly empty now since we redirect to files)
            try { proc.inputStream.bufferedReader().readText() } catch (_: Exception) {}

            val exitCode = try { proc.waitFor() } catch (_: Exception) { -1 }

            // Give real-time streams a moment to flush
            Thread.sleep(500)

            // Now read the captured output files
            val outLines = try { java.io.File(outLog).readLines() } catch (_: Exception) { emptyList() }
            // errLog is not used separately — stderr merged into outLog via 2>&1
            val noiseRegex = Regex(
                "tcgetattr|isatty|not a tty|inappropriate ioctl|Script (started|done)|stty:",
                RegexOption.IGNORE_CASE
            )

            // outLog contains both stdout + stderr (merged). Skip noise and EXIT: marker.
            for (l in outLines) {
                if (l.isBlank()) continue
                if (l.startsWith("EXIT:")) continue
                if (noiseRegex.containsMatchIn(l)) continue
                emitScriptLog(l)
                if (!promiseResolved) {
                    val isFatal = l.lowercase().let { ll ->
                        ll.contains("unable to") || ll.contains("failed to") ||
                        ll.contains("permission denied") || ll.contains("access denied") ||
                        ll.contains("no such process") || ll.contains("error:")
                    }
                    if (!isFatal) { promiseResolved = true; promise.resolve("running:inject") }
                }
            }

            // Real exit code from the EXIT: line we appended
            val realExit = outLines.lastOrNull { it.startsWith("EXIT:") }
                ?.removePrefix("EXIT:")?.trim()?.toIntOrNull() ?: exitCode

            emitScriptLog("━━ exit: $realExit ━━")

            // frida-server log
            val fridaServerLog = "$filesDir/frida.log"
            val srvLines = try { Shell.cmd("tail -5 '$fridaServerLog' 2>/dev/null").exec().out } catch (_: Exception) { emptyList() }
            if (srvLines.isNotEmpty()) {
                emitScriptLog("── frida-server log ──")
                srvLines.forEach { emitScriptLog("  $it") }
            }

            // Diagnosis hint for exit 4
            if (realExit == 4) {
                emitScriptLog("💡 exit 4 = attach rejected. Check:")
                emitScriptLog("   • frida-server and frida-inject versions must match exactly")
                emitScriptLog("   • Run: /data/local/tmp/frida-server --version")
                emitScriptLog("   • Run: /data/local/tmp/frida-inject --version")
                emitScriptLog("   • SELinux must be Permissive")
                emitScriptLog("   • Try re-downloading both binaries from same release")
            }

            if (!promiseResolved) {
                promiseResolved = true
                val allEmpty = outLines.all { it.isBlank() || it.startsWith("EXIT:") || noiseRegex.containsMatchIn(it) }
                if (allEmpty) emitScriptLog("⚠ frida-inject produced no output (binary issue?)")
                val hint = when (realExit) {
                    0    -> "exited cleanly (script ran and finished)"
                    1    -> "exit 1 — wrong package name or binary version mismatch"
                    4    -> "exit 4 — attach/spawn rejected (version mismatch or SELinux)"
                    else -> "exit $realExit"
                }
                promise.reject("INJECT_ERROR", hint)
            } else {
                if (realExit == 0) emitScriptLog("✅ Done")
                else emitScriptLog("⚠ exit $realExit")
            }

            fridaScriptPid = null
            fridaProcess   = null

            // ── CRITICAL: Resume any frozen spawned process ─────────────────────
            // If frida-inject exits (error or crash) while in spawn mode, the target process
            // remains paused in ptrace state forever — the game appears frozen with black screen.
            // We must resume it via frida or kill it so the user can restart normally.
            // Strategy: send SIGCONT to all child processes of the package, then kill frida-server.
            val frozenPid = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
                .exec().out.firstOrNull()?.trim()?.ifBlank { null }
            if (frozenPid != null) {
                // Send SIGCONT — resumes a ptrace-stopped process if kernel allows it
                Shell.cmd("kill -CONT $frozenPid 2>/dev/null; true").exec()
                emitScriptLog("⚙ Sent SIGCONT to $packageName (PID $frozenPid) — unfreeze")
            }

            // ── Kill frida-server after inject finishes ────────────────────────
            // frida-server intercepts ALL process spawns system-wide via ptrace.
            // Leaving it running causes any app launched AFTER inject to freeze on startup.
            // Fix: kill it as soon as frida-inject exits — it's no longer needed.
            Shell.cmd("pkill -f frida-server 2>/dev/null; true").exec()
            emitScriptLog("⚙ frida-server stopped")
            Thread.sleep(300)

            // ── Restore SELinux AFTER killing frida-server ─────────────────────
            if (selinuxWasEnforcing) {
                Shell.cmd("setenforce 1 2>/dev/null; true").exec()
                selinuxWasEnforcing = false
                emitScriptLog("🔒 SELinux restored to Enforcing")
            }
            // NOTE: do NOT destroy logcatProc here — injected script inside game is still logging
        }.start()

        // ── Safety timeout: 10s ───────────────────────────────────────────────
        Thread {
            Thread.sleep(10000)
            if (!promiseResolved) {
                promiseResolved = true
                if (fridaProcess != null) {
                    emitScriptLog("✅ Script presumed running (timeout reached, process alive)")
                    promise.resolve("running:timeout")
                } else {
                    promise.reject("INJECT_ERROR", "frida-inject did not respond within 10 seconds")
                }
            }
        }.start()
    }

    // Resolve PID — launch app if not running, return null if still not found
    private fun resolvePid(packageName: String): String? {
        var pid = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
            .exec().out.firstOrNull()?.trim()
        if (!pid.isNullOrBlank()) return pid
        emitScriptLog("⚙ Launching $packageName...")
        Shell.cmd("monkey -p '$packageName' -c android.intent.category.LAUNCHER 1 2>/dev/null").exec()
        Thread.sleep(3000)
        pid = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
            .exec().out.firstOrNull()?.trim()
        return pid?.ifBlank { null }
    }

    // Start frida-server if not already running — returns true if server is up
    private fun ensureFridaServer(): Boolean {
        if (isFridaServerRunning()) {
            emitScriptLog("✓ frida-server already running")
            return true
        }
        val dest = File(FRIDA_DEST)
        if (!dest.exists() || dest.length() < 1024) {
            emitScriptLog("ℹ frida-server binary missing — download from Home screen first")
            return false
        }
        emitScriptLog("⚙ Starting frida-server...")
        val fridaLog = "${reactApplicationContext.filesDir}/frida.log"
        Shell.cmd("pkill -f frida-server 2>/dev/null; true").exec()
        Thread.sleep(300)

        // ── Fix ptrace/SELinux BEFORE launching frida-server ──────────────
        val ptraceCur = Shell.cmd("cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null").exec().out.joinToString("").trim()
        if (ptraceCur.isNotEmpty() && ptraceCur != "0") {
            emitScriptLog("⚙ ptrace_scope=$ptraceCur → setting to 0")
            Shell.cmd("echo 0 > /proc/sys/kernel/yama/ptrace_scope 2>/dev/null; true").exec()
            // Wait for change to propagate
            repeat(10) {
                Thread.sleep(100)
                val cur = Shell.cmd("cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null").exec()
                    .out.firstOrNull()?.trim()
                if (cur == "0") return@repeat
            }
        }
        val seStatus = Shell.cmd("getenforce 2>/dev/null").exec().out.joinToString("").trim()
        if (seStatus.equals("Enforcing", ignoreCase = true)) {
            emitScriptLog("⚙ SELinux Enforcing → setting Permissive")
            Shell.cmd("setenforce 0 2>/dev/null; true").exec()
            // Wait for SELinux to actually switch
            repeat(20) {
                Thread.sleep(100)
                val cur = Shell.cmd("getenforce 2>/dev/null").exec().out.firstOrNull()?.trim()
                if (cur != null && cur.equals("Permissive", ignoreCase = true)) return@repeat
            }
        }
        // Extra buffer after policy changes
        Thread.sleep(300)
        // ──────────────────────────────────────────────────────────────────

        // --ignore-crashes: don't let frida-server gate/intercept app crashes
        // No --policy-softener=android: that flag injects frida into zygote which causes
        // ALL newly spawned apps to hang until frida responds — root cause of the freeze bug.
        // Without it, frida-server only attaches when explicitly told to via frida-inject/frida CLI.
        Shell.cmd("chmod 755 $FRIDA_DEST && $FRIDA_DEST --ignore-crashes > '$fridaLog' 2>&1 &").exec()

        // Poll up to 8 seconds (16 × 500ms) instead of fixed 3s sleep
        repeat(16) { i ->
            Thread.sleep(500)
            if (isFridaServerRunning()) {
                emitScriptLog("✓ frida-server started (${(i + 1) * 500}ms)")
                return true
            }
        }

        val log = Shell.cmd("tail -5 '$fridaLog' 2>/dev/null").exec().out.joinToString(" | ")
        emitScriptLog("⚠ frida-server failed to start: $log")
        return false
    }

    // ── Background log buffer ─────────────────────────────────────────────────
    // When the app is in the background, hasActiveCatalystInstance() returns false
    // and events are silently dropped. We buffer them here and flush when JS calls
    // flushPendingLogs() (triggered by AppState 'active' event on the JS side).
    private val pendingLogs = ArrayDeque<String>()
    private val pendingLogsLock = Any()
    private val MAX_PENDING = 2000   // keep last 2000 lines max

    @ReactMethod
    fun flushPendingLogs(promise: Promise) {
        val lines = synchronized(pendingLogsLock) {
            val copy = pendingLogs.toList()
            pendingLogs.clear()
            copy
        }
        val arr = Arguments.createArray()
        lines.forEach { arr.pushString(it) }
        promise.resolve(arr)
    }

    private fun emitScriptLog(line: String) {
        try {
            // 2. Push to FloatingLogService overlay (always works, even in background)
            FloatingLogService.pushLog(line)

            // 1. Push to React Native JS layer — buffer if app is in background
            if (reactApplicationContext.hasActiveCatalystInstance()) {
                // App is in foreground — flush any buffered lines first, then emit live
                val pending = synchronized(pendingLogsLock) {
                    val copy = pendingLogs.toList()
                    pendingLogs.clear()
                    copy
                }
                pending.forEach { buffered ->
                    val p = Arguments.createMap(); p.putString("line", buffered)
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        ?.emit("FridaScriptLog", p)
                }
                val params = Arguments.createMap()
                params.putString("line", line)
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    ?.emit("FridaScriptLog", params)
            } else {
                // App in background — buffer the line
                synchronized(pendingLogsLock) {
                    if (pendingLogs.size >= MAX_PENDING) pendingLogs.removeFirst()
                    pendingLogs.addLast(line)
                }
            }
        } catch (_: Exception) {}
    }

    // ─────────────────────────────────────────────
    // Floating Memory Scanner Overlay
    // ─────────────────────────────────────────────

    @ReactMethod
    fun startMemoryOverlay(pkg: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            Shell.cmd("appops set ${ctx.packageName} SYSTEM_ALERT_WINDOW allow 2>/dev/null; true").exec()
            val intent = Intent(ctx, FloatingMemoryScanService::class.java).apply {
                action = FloatingMemoryScanService.ACTION_SHOW
                putExtra(FloatingMemoryScanService.EXTRA_PKG, pkg)
            }
            ctx.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stopMemoryOverlay(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, FloatingMemoryScanService::class.java).apply {
                action = FloatingMemoryScanService.ACTION_HIDE
            }
            reactApplicationContext.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    // ─────────────────────────────────────────────
    // Floating Overlay Log Window
    // ─────────────────────────────────────────────

    @ReactMethod
    fun showFloatingLog(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            // Grant SYSTEM_ALERT_WINDOW via appops on rooted device (no user prompt needed)
            Shell.cmd("appops set ${ctx.packageName} SYSTEM_ALERT_WINDOW allow 2>/dev/null; true").exec()
            val intent = Intent(ctx, FloatingLogService::class.java).apply {
                action = FloatingLogService.ACTION_SHOW
            }
            ctx.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    @ReactMethod
    fun hideFloatingLog(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, FloatingLogService::class.java).apply {
                action = FloatingLogService.ACTION_HIDE
            }
            reactApplicationContext.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    // ─────────────────────────────────────────────
    // File Browser — root access to /data/data
    // ─────────────────────────────────────────────

    @ReactMethod
    fun readDir(path: String, promise: Promise) {
        Thread {
            try {
                // Use find -maxdepth 1 — works better than ls under SELinux
                // Format: TYPE|SIZE|PERMS|NAME  (TYPE=d or f)
                val cmd = "find '$path' -maxdepth 1 -mindepth 1 " +
                    "\\( -type f -o -type d -o -type l \\) " +
                    "-exec stat -c '%F|%s|%A|%n' {} \\; 2>&1"
                val result = Shell.cmd(cmd).exec()

                val arr = WritableNativeArray()
                for (line in result.out) {
                    if (line.isBlank()) continue
                    // stat -c '%F|%s|%A|%n' output: "regular file|1234|drwxr-x--|/path/name"
                    val parts = line.split("|", limit = 4)
                    if (parts.size < 4) continue
                    val fileType = parts[0]
                    val size     = parts[1].toLongOrNull() ?: 0L
                    val perms    = parts[2]
                    val fullPath = parts[3].trim()
                    val name     = fullPath.substringAfterLast("/")
                    if (name.isEmpty() || name == "." || name == "..") continue
                    val isDir = fileType.contains("directory") || fileType.contains("link")
                    val map = WritableNativeMap()
                    map.putString("name", name)
                    map.putString("path", fullPath)
                    map.putBoolean("isDir", isDir)
                    map.putString("size", if (isDir) "" else formatSize(size))
                    map.putString("perms", perms)
                    arr.pushMap(map)
                }

                // If find returned nothing but no error, directory might be empty or inaccessible
                if (arr.size() == 0 && result.out.any { it.contains("Permission denied") || it.contains("Operation not permitted") }) {
                    promise.reject("READ_DIR_ERROR", "Permission denied (SELinux)")
                    return@Thread
                }

                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("READ_DIR_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun readFile(path: String, promise: Promise) {
        Thread {
            try {
                // Read via root — copy to tmp first then read
                val tmp = "${reactApplicationContext.filesDir}/tmpread"
                Shell.cmd("cp '$path' '$tmp' && chmod 644 '$tmp' 2>&1").exec()
                val f = File(tmp)
                if (!f.exists()) throw Exception("Cannot read file")
                val size = f.length()
                if (size > 512 * 1024) {
                    // Too large — show hex dump header + tail
                    val head = Shell.cmd("xxd '$path' 2>/dev/null | head -32").exec().out.joinToString("\n")
                    promise.resolve("[Binary file — ${formatSize(size)}]\n\n$head\n...(truncated)")
                } else {
                    val content = f.readText()
                    // Check if binary (contains null bytes)
                    if (content.contains('\u0000')) {
                        val hex = Shell.cmd("xxd '$path' 2>/dev/null | head -64").exec().out.joinToString("\n")
                        promise.resolve("[Binary — ${formatSize(size)}]\n\n$hex")
                    } else {
                        promise.resolve(content)
                    }
                }
                f.delete()
            } catch (e: Exception) {
                promise.reject("READ_FILE_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun writeFile(path: String, content: String, promise: Promise) {
        Thread {
            try {
                val tmp = "${reactApplicationContext.filesDir}/tmpwrite"
                File(tmp).writeText(content)
                val r = Shell.cmd("cp '$tmp' '$path' 2>&1").exec()
                File(tmp).delete()
                if (!r.isSuccess && r.out.isNotEmpty()) {
                    promise.reject("WRITE_FILE_ERROR", r.out.joinToString("\n"))
                } else {
                    promise.resolve("OK")
                }
            } catch (e: Exception) {
                promise.reject("WRITE_FILE_ERROR", e.message)
            }
        }.start()
    }

    private fun formatSize(bytes: Long): String = when {
        bytes < 1024       -> "${bytes}B"
        bytes < 1024*1024  -> "${bytes/1024}KB"
        else               -> "${"%.1f".format(bytes/1024.0/1024.0)}MB"
    }

    // ─────────────────────────────────────────────
    // XZ extraction — 4 tiers, SELinux-safe
    // Root shell handles all writes to restricted paths
    // Java only writes to filesDir (always allowed)
    // ─────────────────────────────────────────────
    private fun extractXz(xzPath: String, outPath: String) {
        File(outPath).delete()

        // ── Tier 1: shell tool reads .xz file directly ──
        // Shell runs as root; it reads xzPath (in filesDir, world-readable) and writes to outPath
        val tier1Cmds = listOf(
            "xz -d -k -c '$xzPath' > '$outPath'",
            "unxz -k -c '$xzPath' > '$outPath'",
            "busybox xz -d -k -c '$xzPath' > '$outPath'",
            "toybox xz -d '$xzPath' -c > '$outPath'"
        )
        for (cmd in tier1Cmds) {
            try {
                val r = Shell.cmd(cmd).exec()
                if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                    android.util.Log.d("FridaCtl", "Tier1 success: $cmd")
                    return
                }
                android.util.Log.w("FridaCtl", "Tier1 cmd '$cmd' failed: ${r.out + r.err}")
            } catch (e: Exception) {
                android.util.Log.w("FridaCtl", "Tier1 cmd '$cmd' exception: ${e.message}")
            }
        }

        // ── Tier 2: raw shell Task — pipe .xz bytes directly into 'xz -d' stdin ──
        // Uses Shell.execTask() which gives direct access to STDIN/STDOUT/STDERR streams
        // Java writes raw .xz bytes to shell stdin; shell decompresses and writes to outPath
        val xzAvail = Shell.cmd("which xz 2>/dev/null || which busybox 2>/dev/null").exec()
            .out.firstOrNull()?.trim()
        if (!xzAvail.isNullOrBlank()) {
            try {
                android.util.Log.d("FridaCtl", "Tier2: raw stdin pipe to xz -d")
                val xzDecCmd = if (xzAvail.contains("busybox")) "busybox xz -d" else "xz -d"
                var tier2Success = false
                Shell.getShell().execTask { stdin: OutputStream, stdout: InputStream, stderr: InputStream ->
                    // Write command to shell stdin
                    stdin.write("$xzDecCmd > '$outPath'\n".toByteArray())
                    stdin.flush()
                    // Now pipe the .xz file bytes into stdin
                    val buf = ByteArray(32768)
                    FileInputStream(File(xzPath)).use { fis ->
                        var n: Int
                        while (fis.read(buf).also { n = it } != -1) {
                            stdin.write(buf, 0, n)
                        }
                    }
                    stdin.flush()
                    // Send newline + exit-status check sentinel
                    stdin.write("\necho __DONE_\$?\n".toByteArray())
                    stdin.flush()
                    // Read until we see __DONE_ in stdout
                    val sb = StringBuilder()
                    val readBuf = ByteArray(512)
                    var attempts = 0
                    while (!sb.contains("__DONE_") && attempts++ < 200) {
                        Thread.sleep(100)
                        val avail = stdout.available()
                        if (avail > 0) {
                            val n2 = stdout.read(readBuf, 0, minOf(avail, readBuf.size))
                            if (n2 > 0) sb.append(String(readBuf, 0, n2))
                        }
                    }
                    tier2Success = sb.contains("__DONE_0")
                    android.util.Log.d("FridaCtl", "Tier2 raw task output: $sb")
                }
                if (tier2Success && File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                    android.util.Log.d("FridaCtl", "Tier2 success")
                    return
                }
                android.util.Log.w("FridaCtl", "Tier2 failed — output size: ${File(outPath).length()}")
            } catch (e: Exception) {
                android.util.Log.w("FridaCtl", "Tier2 exception: ${e.message}")
            }
        }

        // ── Tier 3: Java decompresses XZ → write to tmp in filesDir → root cp to dest ──
        // Java writes decompressed binary to filesDir (always allowed)
        // Root shell copies from filesDir to restricted destination
        val tmpOut = File(reactApplicationContext.filesDir, "frida_tmp.bin")
        try {
            tmpOut.delete()
            android.util.Log.d("FridaCtl", "Tier3: Java XZ decompress to filesDir tmp")
            val inBuf = BufferedInputStream(FileInputStream(File(xzPath)), 32768)
            XZCompressorInputStream(inBuf, true).use { xzIn ->
                FileOutputStream(tmpOut).use { out ->
                    val buf = ByteArray(32768)
                    var n: Int
                    while (xzIn.read(buf).also { n = it } != -1) {
                        out.write(buf, 0, n)
                    }
                }
            }
            android.util.Log.d("FridaCtl", "Tier3: decompressed ${tmpOut.length()} bytes, copying via root shell")
            // Root shell copies from filesDir to restricted path
            val r = Shell.cmd("cp '${tmpOut.absolutePath}' '$outPath'").exec()
            if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                android.util.Log.d("FridaCtl", "Tier3 cp success")
                tmpOut.delete()
                return
            }
            android.util.Log.w("FridaCtl", "Tier3 cp failed: ${r.out + r.err}")
            // cp failed — try cat redirect via root shell
            val r2 = Shell.cmd("cat '${tmpOut.absolutePath}' > '$outPath'").exec()
            if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                android.util.Log.d("FridaCtl", "Tier3 cat success")
                tmpOut.delete()
                return
            }
            android.util.Log.w("FridaCtl", "Tier3 cat failed: ${r2.out + r2.err}")
        } catch (e: Exception) {
            android.util.Log.w("FridaCtl", "Tier3 exception: ${e.message}")
        } finally {
            tmpOut.delete()
        }

        // ── Tier 4: Java decompresses XZ → root dd reads from filesDir via shell ──
        // Same as Tier 3 but uses dd instead of cp/cat
        val tmpOut4 = File(reactApplicationContext.filesDir, "frida_tmp4.bin")
        try {
            tmpOut4.delete()
            android.util.Log.d("FridaCtl", "Tier4: Java XZ decompress + dd copy")
            val inBuf = BufferedInputStream(FileInputStream(File(xzPath)), 32768)
            XZCompressorInputStream(inBuf, true).use { xzIn ->
                FileOutputStream(tmpOut4).use { out ->
                    val buf = ByteArray(32768)
                    var n: Int
                    while (xzIn.read(buf).also { n = it } != -1) {
                        out.write(buf, 0, n)
                    }
                }
            }
            val r = Shell.cmd("dd if='${tmpOut4.absolutePath}' of='$outPath' bs=32768").exec()
            if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                android.util.Log.d("FridaCtl", "Tier4 dd success")
                tmpOut4.delete()
                return
            }
            android.util.Log.w("FridaCtl", "Tier4 dd failed: ${r.out + r.err}")
        } catch (e: Exception) {
            android.util.Log.w("FridaCtl", "Tier4 exception: ${e.message}")
        } finally {
            tmpOut4.delete()
        }

        throw Exception("All XZ extraction tiers failed — check logcat for per-tier errors")
    }

    // ─────────────────────────────────────────────
    // Asset extraction (from APK assets/)
    // ─────────────────────────────────────────────

    private fun extractAsset(assetName: String, destPath: String, overwrite: Boolean = false) {
        val dest = File(destPath)
        if (!overwrite && dest.exists() && dest.length() > 1024) return
        try {
            reactApplicationContext.assets.open(assetName).use { inp ->
                FileOutputStream(dest).use { out -> inp.copyTo(out) }
            }
            dest.setExecutable(true, false)
        } catch (e: Exception) {
            throw Exception("Missing asset '$assetName'")
        }
    }
}
); do state=\$(cat /proc/\$p/status 2>/dev/null | grep '^State:' | awk '{print \$2}'); if [ \"\$state\" = 'T' ] || [ \"\$state\" = 't' ]; then kill -CONT \$p 2>/dev/null; fi; done").exec()
                emitScriptLog("⚙ Sent SIGCONT to any frozen processes")
            } catch (_: Exception) {}

            emitScriptLog("⏹ Script stopped")
            promise.resolve("stopped")
        }.start()
    }

    // Starts logcat BEFORE frida-inject so no early output is missed.
    // Strategy:
    //   Primary  — filter by Frida/frida/FRIDA tags (works on most devices)
    //   Fallback — if no output in 8s, switch to unfiltered logcat and grep for hook keywords
    //              This catches devices where frida console.log routes under a different tag
    private fun startPersistentLogcat(targetPid: Int? = null) {
        try { fridaLogcatProc?.destroy() } catch (_: Exception) {}
        fridaLogcatProc = null

        // Clear logcat buffer first so we don't get stale output
        try { ProcessBuilder("su", "-c", "logcat -c 2>/dev/null").start().waitFor() } catch (_: Exception) {}

        // Build filter string — PID filter + known Frida tags
        val pidFilter = if (targetPid != null) "--pid=$targetPid" else ""
        val tagFilter = "Frida:V frida:V FRIDA:V frida-server:V frida-inject:V *:S"

        // Primary logcat command — tag-filtered
        val primaryCmd = "logcat -v raw $pidFilter -s Frida:V frida:V FRIDA:V frida-server:V frida-inject:V 2>/dev/null"
        // Fallback — unfiltered, we grep for hook output ourselves
        val fallbackCmd = "logcat -v raw 2>/dev/null"

        var linesReceived = 0
        val startTime = System.currentTimeMillis()
        var usedFallback = false

        fun launchLogcat(cmd: String): Process? = try {
            ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start()
        } catch (_: Exception) { null }

        var proc = launchLogcat(primaryCmd) ?: return
        fridaLogcatProc = proc
        emitScriptLog("📡 Logcat streaming (runs until you press STOP)...")

        Thread {
            try {
                proc.inputStream.bufferedReader().use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isBlank()) continue
                        linesReceived++
                        emitScriptLog(line)
                    }
                }
            } catch (_: Exception) {}

            // Primary ended — if we never got output and fallback not yet tried, switch to filtered logcat
            if (linesReceived == 0 && !usedFallback && fridaLogcatProc != null) {
                usedFallback = true
                emitScriptLog("⚠ No Frida-tagged output — switching to filtered logcat")
                val proc2 = launchLogcat(fallbackCmd) ?: return@Thread
                fridaLogcatProc = proc2
                // Only show lines relevant to script execution — filter noise
                val hookRx = Regex(
                    """\[|hook|cipher|key|inject|frida|console|send|recv|error|warn|crash|memory|scan|bypass|patch""",
                    RegexOption.IGNORE_CASE
                )
                try {
                    proc2.inputStream.bufferedReader().use { reader ->
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isBlank()) continue
                            if (hookRx.containsMatchIn(line)) emitScriptLog(line)
                        }
                    }
                } catch (_: Exception) {}
            }

            emitScriptLog("📡 Logcat stopped")
        }.also { it.isDaemon = true }.start()

        // Watchdog: if no output after 8s, kill primary and let fallback take over
        Thread {
            Thread.sleep(8000)
            if (linesReceived == 0 && !usedFallback && fridaLogcatProc == proc) {
                try { proc.destroy() } catch (_: Exception) {}
                // Thread above will detect empty output and launch fallback
            }
        }.also { it.isDaemon = true }.start()
    }

    // Runs the frida-inject command as a root Process, streams all output → FridaScriptLog
    private fun runFridaProcess(cmd: String, promise: Promise) {
        fridaProcess?.destroy()
        fridaProcess = null
        fridaScriptPid = null

        val filesDir  = reactApplicationContext.filesDir.absolutePath
        val outLog    = "$filesDir/fi_out.log"
        val errLog    = "$filesDir/fi_err.log"

        // frida-inject needs a TTY — piping stdout/stderr to a file breaks tcgetattr → EXIT:4
        // Confirmed fix: setsid WITHOUT stdout/stderr redirect works (tested manually)
        // We redirect stdin from /dev/null + capture stderr only for error diagnosis
        // Real frida script output (console.log) goes through logcat automatically
        Shell.cmd("rm -f '$outLog' '$errLog' 2>/dev/null; true").exec()

        // frida-inject writes console.log to stdout (piped mode) or PTY slave (TTY mode).
        // setsid </dev/ptmx redirects stdin from PTY master — stdout still goes to the file correctly
        // ONLY when the slave fd is open. Without a slave, frida detects no TTY and writes to stdout→file.
        //
        // CONFIRMED WORKING STRATEGY:
        //   Run frida-inject with stdout+stderr redirected to files — no PTY wrapper.
        //   frida-inject will print "tcgetattr: Inappropriate ioctl" to stderr (we filter it).
        //   console.log output goes to stdout → outLog. This is the most reliable cross-device approach.
        //
        //   If 'script' is available, use it — it gives frida a real PTY and captures everything.
        val hasScript = Shell.cmd("which script 2>/dev/null").exec().out.firstOrNull()?.trim()?.isNotBlank() == true

        val wrapper = if (hasScript) {
            emitScriptLog("🖥 PTY capture via script")
            // script -q -c 'CMD' /dev/null — CMD gets a real PTY slave; all output captured to script stdout → outLog
            "script -q -c '$cmd' /dev/null >'$outLog' 2>'$errLog'; echo \"EXIT:\$?\" >>'$outLog'"
        } else {
            emitScriptLog("🖥 Direct capture (no PTY — tcgetattr warning is normal)")
            // No PTY tools. frida prints tcgetattr warning to stderr (filtered below).
            // console.log goes to stdout → outLog. Works reliably.
            "$cmd >'$outLog' 2>&1; echo \"EXIT:\$?\" >>'$outLog'"
        }

        val pb = ProcessBuilder("su", "-c", wrapper)
        pb.redirectErrorStream(true)

        val proc: Process
        try {
            proc = pb.start()
        } catch (e: Exception) {
            promise.reject("RUN_ERROR", "Cannot start process: ${e.message}")
            return
        }

        fridaProcess   = proc
        fridaScriptPid = "running"

        var promiseResolved = false

        val noiseRx = Regex(
            "tcgetattr|isatty|not a tty|inappropriate ioctl|Script (started|done)|stty:",
            RegexOption.IGNORE_CASE
        )

        // ── Stream outLog in real-time (stdout from frida-inject — console.log + send() output) ──
        Thread {
            try {
                val tailProc = ProcessBuilder("su", "-c", "tail -f '$outLog' 2>/dev/null")
                    .redirectErrorStream(true).start()
                try {
                    tailProc.inputStream.bufferedReader().use { r ->
                        while (fridaScriptPid != null || proc.isAlive) {
                            val l = r.readLine() ?: break
                            if (l.isBlank()) continue
                            if (l.startsWith("EXIT:")) continue
                            if (noiseRx.containsMatchIn(l)) continue
                            emitScriptLog(l)
                        }
                    }
                } catch (_: Exception) {}
                try { tailProc.destroy() } catch (_: Exception) {}
            } catch (_: Exception) {}
        }.start()

        // errLog not streamed separately — stderr is merged into outLog via 2>&1
        // (when using script, errLog captures script's own stderr which is minimal)

        Thread {
            // Drain the process stdout (mostly empty now since we redirect to files)
            try { proc.inputStream.bufferedReader().readText() } catch (_: Exception) {}

            val exitCode = try { proc.waitFor() } catch (_: Exception) { -1 }

            // Give real-time streams a moment to flush
            Thread.sleep(500)

            // Now read the captured output files
            val outLines = try { java.io.File(outLog).readLines() } catch (_: Exception) { emptyList() }
            // errLog is not used separately — stderr merged into outLog via 2>&1
            val noiseRegex = Regex(
                "tcgetattr|isatty|not a tty|inappropriate ioctl|Script (started|done)|stty:",
                RegexOption.IGNORE_CASE
            )

            // outLog contains both stdout + stderr (merged). Skip noise and EXIT: marker.
            for (l in outLines) {
                if (l.isBlank()) continue
                if (l.startsWith("EXIT:")) continue
                if (noiseRegex.containsMatchIn(l)) continue
                emitScriptLog(l)
                if (!promiseResolved) {
                    val isFatal = l.lowercase().let { ll ->
                        ll.contains("unable to") || ll.contains("failed to") ||
                        ll.contains("permission denied") || ll.contains("access denied") ||
                        ll.contains("no such process") || ll.contains("error:")
                    }
                    if (!isFatal) { promiseResolved = true; promise.resolve("running:inject") }
                }
            }

            // Real exit code from the EXIT: line we appended
            val realExit = outLines.lastOrNull { it.startsWith("EXIT:") }
                ?.removePrefix("EXIT:")?.trim()?.toIntOrNull() ?: exitCode

            emitScriptLog("━━ exit: $realExit ━━")

            // frida-server log
            val fridaServerLog = "$filesDir/frida.log"
            val srvLines = try { Shell.cmd("tail -5 '$fridaServerLog' 2>/dev/null").exec().out } catch (_: Exception) { emptyList() }
            if (srvLines.isNotEmpty()) {
                emitScriptLog("── frida-server log ──")
                srvLines.forEach { emitScriptLog("  $it") }
            }

            // Diagnosis hint for exit 4
            if (realExit == 4) {
                emitScriptLog("💡 exit 4 = attach rejected. Check:")
                emitScriptLog("   • frida-server and frida-inject versions must match exactly")
                emitScriptLog("   • Run: /data/local/tmp/frida-server --version")
                emitScriptLog("   • Run: /data/local/tmp/frida-inject --version")
                emitScriptLog("   • SELinux must be Permissive")
                emitScriptLog("   • Try re-downloading both binaries from same release")
            }

            if (!promiseResolved) {
                promiseResolved = true
                val allEmpty = outLines.all { it.isBlank() || it.startsWith("EXIT:") || noiseRegex.containsMatchIn(it) }
                if (allEmpty) emitScriptLog("⚠ frida-inject produced no output (binary issue?)")
                val hint = when (realExit) {
                    0    -> "exited cleanly (script ran and finished)"
                    1    -> "exit 1 — wrong package name or binary version mismatch"
                    4    -> "exit 4 — attach/spawn rejected (version mismatch or SELinux)"
                    else -> "exit $realExit"
                }
                promise.reject("INJECT_ERROR", hint)
            } else {
                if (realExit == 0) emitScriptLog("✅ Done")
                else emitScriptLog("⚠ exit $realExit")
            }

            fridaScriptPid = null
            fridaProcess   = null

            // ── CRITICAL: Resume any frozen spawned process ─────────────────────
            // If frida-inject exits (error or crash) while in spawn mode, the target process
            // remains paused in ptrace state forever — the game appears frozen with black screen.
            // We must resume it via frida or kill it so the user can restart normally.
            // Strategy: send SIGCONT to all child processes of the package, then kill frida-server.
            val frozenPid = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
                .exec().out.firstOrNull()?.trim()?.ifBlank { null }
            if (frozenPid != null) {
                // Send SIGCONT — resumes a ptrace-stopped process if kernel allows it
                Shell.cmd("kill -CONT $frozenPid 2>/dev/null; true").exec()
                emitScriptLog("⚙ Sent SIGCONT to $packageName (PID $frozenPid) — unfreeze")
            }

            // ── Kill frida-server after inject finishes ────────────────────────
            // frida-server intercepts ALL process spawns system-wide via ptrace.
            // Leaving it running causes any app launched AFTER inject to freeze on startup.
            // Fix: kill it as soon as frida-inject exits — it's no longer needed.
            Shell.cmd("pkill -f frida-server 2>/dev/null; true").exec()
            emitScriptLog("⚙ frida-server stopped")
            Thread.sleep(300)

            // ── Restore SELinux AFTER killing frida-server ─────────────────────
            if (selinuxWasEnforcing) {
                Shell.cmd("setenforce 1 2>/dev/null; true").exec()
                selinuxWasEnforcing = false
                emitScriptLog("🔒 SELinux restored to Enforcing")
            }
            // NOTE: do NOT destroy logcatProc here — injected script inside game is still logging
        }.start()

        // ── Safety timeout: 10s ───────────────────────────────────────────────
        Thread {
            Thread.sleep(10000)
            if (!promiseResolved) {
                promiseResolved = true
                if (fridaProcess != null) {
                    emitScriptLog("✅ Script presumed running (timeout reached, process alive)")
                    promise.resolve("running:timeout")
                } else {
                    promise.reject("INJECT_ERROR", "frida-inject did not respond within 10 seconds")
                }
            }
        }.start()
    }

    // Resolve PID — launch app if not running, return null if still not found
    private fun resolvePid(packageName: String): String? {
        var pid = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
            .exec().out.firstOrNull()?.trim()
        if (!pid.isNullOrBlank()) return pid
        emitScriptLog("⚙ Launching $packageName...")
        Shell.cmd("monkey -p '$packageName' -c android.intent.category.LAUNCHER 1 2>/dev/null").exec()
        Thread.sleep(3000)
        pid = Shell.cmd("pidof '$packageName' 2>/dev/null | tr ' ' '\\n' | head -1")
            .exec().out.firstOrNull()?.trim()
        return pid?.ifBlank { null }
    }

    // Start frida-server if not already running — returns true if server is up
    private fun ensureFridaServer(): Boolean {
        if (isFridaServerRunning()) {
            emitScriptLog("✓ frida-server already running")
            return true
        }
        val dest = File(FRIDA_DEST)
        if (!dest.exists() || dest.length() < 1024) {
            emitScriptLog("ℹ frida-server binary missing — download from Home screen first")
            return false
        }
        emitScriptLog("⚙ Starting frida-server...")
        val fridaLog = "${reactApplicationContext.filesDir}/frida.log"
        Shell.cmd("pkill -f frida-server 2>/dev/null; true").exec()
        Thread.sleep(300)

        // ── Fix ptrace/SELinux BEFORE launching frida-server ──────────────
        val ptraceCur = Shell.cmd("cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null").exec().out.joinToString("").trim()
        if (ptraceCur.isNotEmpty() && ptraceCur != "0") {
            emitScriptLog("⚙ ptrace_scope=$ptraceCur → setting to 0")
            Shell.cmd("echo 0 > /proc/sys/kernel/yama/ptrace_scope 2>/dev/null; true").exec()
            // Wait for change to propagate
            repeat(10) {
                Thread.sleep(100)
                val cur = Shell.cmd("cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null").exec()
                    .out.firstOrNull()?.trim()
                if (cur == "0") return@repeat
            }
        }
        val seStatus = Shell.cmd("getenforce 2>/dev/null").exec().out.joinToString("").trim()
        if (seStatus.equals("Enforcing", ignoreCase = true)) {
            emitScriptLog("⚙ SELinux Enforcing → setting Permissive")
            Shell.cmd("setenforce 0 2>/dev/null; true").exec()
            // Wait for SELinux to actually switch
            repeat(20) {
                Thread.sleep(100)
                val cur = Shell.cmd("getenforce 2>/dev/null").exec().out.firstOrNull()?.trim()
                if (cur != null && cur.equals("Permissive", ignoreCase = true)) return@repeat
            }
        }
        // Extra buffer after policy changes
        Thread.sleep(300)
        // ──────────────────────────────────────────────────────────────────

        // --ignore-crashes: don't let frida-server gate/intercept app crashes
        // No --policy-softener=android: that flag injects frida into zygote which causes
        // ALL newly spawned apps to hang until frida responds — root cause of the freeze bug.
        // Without it, frida-server only attaches when explicitly told to via frida-inject/frida CLI.
        Shell.cmd("chmod 755 $FRIDA_DEST && $FRIDA_DEST --ignore-crashes > '$fridaLog' 2>&1 &").exec()

        // Poll up to 8 seconds (16 × 500ms) instead of fixed 3s sleep
        repeat(16) { i ->
            Thread.sleep(500)
            if (isFridaServerRunning()) {
                emitScriptLog("✓ frida-server started (${(i + 1) * 500}ms)")
                return true
            }
        }

        val log = Shell.cmd("tail -5 '$fridaLog' 2>/dev/null").exec().out.joinToString(" | ")
        emitScriptLog("⚠ frida-server failed to start: $log")
        return false
    }

    // ── Background log buffer ─────────────────────────────────────────────────
    // When the app is in the background, hasActiveCatalystInstance() returns false
    // and events are silently dropped. We buffer them here and flush when JS calls
    // flushPendingLogs() (triggered by AppState 'active' event on the JS side).
    private val pendingLogs = ArrayDeque<String>()
    private val pendingLogsLock = Any()
    private val MAX_PENDING = 2000   // keep last 2000 lines max

    @ReactMethod
    fun flushPendingLogs(promise: Promise) {
        val lines = synchronized(pendingLogsLock) {
            val copy = pendingLogs.toList()
            pendingLogs.clear()
            copy
        }
        val arr = Arguments.createArray()
        lines.forEach { arr.pushString(it) }
        promise.resolve(arr)
    }

    private fun emitScriptLog(line: String) {
        try {
            // 2. Push to FloatingLogService overlay (always works, even in background)
            FloatingLogService.pushLog(line)

            // 1. Push to React Native JS layer — buffer if app is in background
            if (reactApplicationContext.hasActiveCatalystInstance()) {
                // App is in foreground — flush any buffered lines first, then emit live
                val pending = synchronized(pendingLogsLock) {
                    val copy = pendingLogs.toList()
                    pendingLogs.clear()
                    copy
                }
                pending.forEach { buffered ->
                    val p = Arguments.createMap(); p.putString("line", buffered)
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        ?.emit("FridaScriptLog", p)
                }
                val params = Arguments.createMap()
                params.putString("line", line)
                reactApplicationContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    ?.emit("FridaScriptLog", params)
            } else {
                // App in background — buffer the line
                synchronized(pendingLogsLock) {
                    if (pendingLogs.size >= MAX_PENDING) pendingLogs.removeFirst()
                    pendingLogs.addLast(line)
                }
            }
        } catch (_: Exception) {}
    }

    // ─────────────────────────────────────────────
    // Floating Memory Scanner Overlay
    // ─────────────────────────────────────────────

    @ReactMethod
    fun startMemoryOverlay(pkg: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            Shell.cmd("appops set ${ctx.packageName} SYSTEM_ALERT_WINDOW allow 2>/dev/null; true").exec()
            val intent = Intent(ctx, FloatingMemoryScanService::class.java).apply {
                action = FloatingMemoryScanService.ACTION_SHOW
                putExtra(FloatingMemoryScanService.EXTRA_PKG, pkg)
            }
            ctx.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stopMemoryOverlay(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, FloatingMemoryScanService::class.java).apply {
                action = FloatingMemoryScanService.ACTION_HIDE
            }
            reactApplicationContext.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    // ─────────────────────────────────────────────
    // Floating Overlay Log Window
    // ─────────────────────────────────────────────

    @ReactMethod
    fun showFloatingLog(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            // Grant SYSTEM_ALERT_WINDOW via appops on rooted device (no user prompt needed)
            Shell.cmd("appops set ${ctx.packageName} SYSTEM_ALERT_WINDOW allow 2>/dev/null; true").exec()
            val intent = Intent(ctx, FloatingLogService::class.java).apply {
                action = FloatingLogService.ACTION_SHOW
            }
            ctx.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    @ReactMethod
    fun hideFloatingLog(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, FloatingLogService::class.java).apply {
                action = FloatingLogService.ACTION_HIDE
            }
            reactApplicationContext.startService(intent)
            promise.resolve("ok")
        } catch (e: Exception) {
            promise.reject("OVERLAY_ERROR", e.message)
        }
    }

    // ─────────────────────────────────────────────
    // File Browser — root access to /data/data
    // ─────────────────────────────────────────────

    @ReactMethod
    fun readDir(path: String, promise: Promise) {
        Thread {
            try {
                // Use find -maxdepth 1 — works better than ls under SELinux
                // Format: TYPE|SIZE|PERMS|NAME  (TYPE=d or f)
                val cmd = "find '$path' -maxdepth 1 -mindepth 1 " +
                    "\\( -type f -o -type d -o -type l \\) " +
                    "-exec stat -c '%F|%s|%A|%n' {} \\; 2>&1"
                val result = Shell.cmd(cmd).exec()

                val arr = WritableNativeArray()
                for (line in result.out) {
                    if (line.isBlank()) continue
                    // stat -c '%F|%s|%A|%n' output: "regular file|1234|drwxr-x--|/path/name"
                    val parts = line.split("|", limit = 4)
                    if (parts.size < 4) continue
                    val fileType = parts[0]
                    val size     = parts[1].toLongOrNull() ?: 0L
                    val perms    = parts[2]
                    val fullPath = parts[3].trim()
                    val name     = fullPath.substringAfterLast("/")
                    if (name.isEmpty() || name == "." || name == "..") continue
                    val isDir = fileType.contains("directory") || fileType.contains("link")
                    val map = WritableNativeMap()
                    map.putString("name", name)
                    map.putString("path", fullPath)
                    map.putBoolean("isDir", isDir)
                    map.putString("size", if (isDir) "" else formatSize(size))
                    map.putString("perms", perms)
                    arr.pushMap(map)
                }

                // If find returned nothing but no error, directory might be empty or inaccessible
                if (arr.size() == 0 && result.out.any { it.contains("Permission denied") || it.contains("Operation not permitted") }) {
                    promise.reject("READ_DIR_ERROR", "Permission denied (SELinux)")
                    return@Thread
                }

                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("READ_DIR_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun readFile(path: String, promise: Promise) {
        Thread {
            try {
                // Read via root — copy to tmp first then read
                val tmp = "${reactApplicationContext.filesDir}/tmpread"
                Shell.cmd("cp '$path' '$tmp' && chmod 644 '$tmp' 2>&1").exec()
                val f = File(tmp)
                if (!f.exists()) throw Exception("Cannot read file")
                val size = f.length()
                if (size > 512 * 1024) {
                    // Too large — show hex dump header + tail
                    val head = Shell.cmd("xxd '$path' 2>/dev/null | head -32").exec().out.joinToString("\n")
                    promise.resolve("[Binary file — ${formatSize(size)}]\n\n$head\n...(truncated)")
                } else {
                    val content = f.readText()
                    // Check if binary (contains null bytes)
                    if (content.contains('\u0000')) {
                        val hex = Shell.cmd("xxd '$path' 2>/dev/null | head -64").exec().out.joinToString("\n")
                        promise.resolve("[Binary — ${formatSize(size)}]\n\n$hex")
                    } else {
                        promise.resolve(content)
                    }
                }
                f.delete()
            } catch (e: Exception) {
                promise.reject("READ_FILE_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun writeFile(path: String, content: String, promise: Promise) {
        Thread {
            try {
                val tmp = "${reactApplicationContext.filesDir}/tmpwrite"
                File(tmp).writeText(content)
                val r = Shell.cmd("cp '$tmp' '$path' 2>&1").exec()
                File(tmp).delete()
                if (!r.isSuccess && r.out.isNotEmpty()) {
                    promise.reject("WRITE_FILE_ERROR", r.out.joinToString("\n"))
                } else {
                    promise.resolve("OK")
                }
            } catch (e: Exception) {
                promise.reject("WRITE_FILE_ERROR", e.message)
            }
        }.start()
    }

    private fun formatSize(bytes: Long): String = when {
        bytes < 1024       -> "${bytes}B"
        bytes < 1024*1024  -> "${bytes/1024}KB"
        else               -> "${"%.1f".format(bytes/1024.0/1024.0)}MB"
    }

    // ─────────────────────────────────────────────
    // XZ extraction — 4 tiers, SELinux-safe
    // Root shell handles all writes to restricted paths
    // Java only writes to filesDir (always allowed)
    // ─────────────────────────────────────────────
    private fun extractXz(xzPath: String, outPath: String) {
        File(outPath).delete()

        // ── Tier 1: shell tool reads .xz file directly ──
        // Shell runs as root; it reads xzPath (in filesDir, world-readable) and writes to outPath
        val tier1Cmds = listOf(
            "xz -d -k -c '$xzPath' > '$outPath'",
            "unxz -k -c '$xzPath' > '$outPath'",
            "busybox xz -d -k -c '$xzPath' > '$outPath'",
            "toybox xz -d '$xzPath' -c > '$outPath'"
        )
        for (cmd in tier1Cmds) {
            try {
                val r = Shell.cmd(cmd).exec()
                if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                    android.util.Log.d("FridaCtl", "Tier1 success: $cmd")
                    return
                }
                android.util.Log.w("FridaCtl", "Tier1 cmd '$cmd' failed: ${r.out + r.err}")
            } catch (e: Exception) {
                android.util.Log.w("FridaCtl", "Tier1 cmd '$cmd' exception: ${e.message}")
            }
        }

        // ── Tier 2: raw shell Task — pipe .xz bytes directly into 'xz -d' stdin ──
        // Uses Shell.execTask() which gives direct access to STDIN/STDOUT/STDERR streams
        // Java writes raw .xz bytes to shell stdin; shell decompresses and writes to outPath
        val xzAvail = Shell.cmd("which xz 2>/dev/null || which busybox 2>/dev/null").exec()
            .out.firstOrNull()?.trim()
        if (!xzAvail.isNullOrBlank()) {
            try {
                android.util.Log.d("FridaCtl", "Tier2: raw stdin pipe to xz -d")
                val xzDecCmd = if (xzAvail.contains("busybox")) "busybox xz -d" else "xz -d"
                var tier2Success = false
                Shell.getShell().execTask { stdin: OutputStream, stdout: InputStream, stderr: InputStream ->
                    // Write command to shell stdin
                    stdin.write("$xzDecCmd > '$outPath'\n".toByteArray())
                    stdin.flush()
                    // Now pipe the .xz file bytes into stdin
                    val buf = ByteArray(32768)
                    FileInputStream(File(xzPath)).use { fis ->
                        var n: Int
                        while (fis.read(buf).also { n = it } != -1) {
                            stdin.write(buf, 0, n)
                        }
                    }
                    stdin.flush()
                    // Send newline + exit-status check sentinel
                    stdin.write("\necho __DONE_\$?\n".toByteArray())
                    stdin.flush()
                    // Read until we see __DONE_ in stdout
                    val sb = StringBuilder()
                    val readBuf = ByteArray(512)
                    var attempts = 0
                    while (!sb.contains("__DONE_") && attempts++ < 200) {
                        Thread.sleep(100)
                        val avail = stdout.available()
                        if (avail > 0) {
                            val n2 = stdout.read(readBuf, 0, minOf(avail, readBuf.size))
                            if (n2 > 0) sb.append(String(readBuf, 0, n2))
                        }
                    }
                    tier2Success = sb.contains("__DONE_0")
                    android.util.Log.d("FridaCtl", "Tier2 raw task output: $sb")
                }
                if (tier2Success && File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                    android.util.Log.d("FridaCtl", "Tier2 success")
                    return
                }
                android.util.Log.w("FridaCtl", "Tier2 failed — output size: ${File(outPath).length()}")
            } catch (e: Exception) {
                android.util.Log.w("FridaCtl", "Tier2 exception: ${e.message}")
            }
        }

        // ── Tier 3: Java decompresses XZ → write to tmp in filesDir → root cp to dest ──
        // Java writes decompressed binary to filesDir (always allowed)
        // Root shell copies from filesDir to restricted destination
        val tmpOut = File(reactApplicationContext.filesDir, "frida_tmp.bin")
        try {
            tmpOut.delete()
            android.util.Log.d("FridaCtl", "Tier3: Java XZ decompress to filesDir tmp")
            val inBuf = BufferedInputStream(FileInputStream(File(xzPath)), 32768)
            XZCompressorInputStream(inBuf, true).use { xzIn ->
                FileOutputStream(tmpOut).use { out ->
                    val buf = ByteArray(32768)
                    var n: Int
                    while (xzIn.read(buf).also { n = it } != -1) {
                        out.write(buf, 0, n)
                    }
                }
            }
            android.util.Log.d("FridaCtl", "Tier3: decompressed ${tmpOut.length()} bytes, copying via root shell")
            // Root shell copies from filesDir to restricted path
            val r = Shell.cmd("cp '${tmpOut.absolutePath}' '$outPath'").exec()
            if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                android.util.Log.d("FridaCtl", "Tier3 cp success")
                tmpOut.delete()
                return
            }
            android.util.Log.w("FridaCtl", "Tier3 cp failed: ${r.out + r.err}")
            // cp failed — try cat redirect via root shell
            val r2 = Shell.cmd("cat '${tmpOut.absolutePath}' > '$outPath'").exec()
            if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                android.util.Log.d("FridaCtl", "Tier3 cat success")
                tmpOut.delete()
                return
            }
            android.util.Log.w("FridaCtl", "Tier3 cat failed: ${r2.out + r2.err}")
        } catch (e: Exception) {
            android.util.Log.w("FridaCtl", "Tier3 exception: ${e.message}")
        } finally {
            tmpOut.delete()
        }

        // ── Tier 4: Java decompresses XZ → root dd reads from filesDir via shell ──
        // Same as Tier 3 but uses dd instead of cp/cat
        val tmpOut4 = File(reactApplicationContext.filesDir, "frida_tmp4.bin")
        try {
            tmpOut4.delete()
            android.util.Log.d("FridaCtl", "Tier4: Java XZ decompress + dd copy")
            val inBuf = BufferedInputStream(FileInputStream(File(xzPath)), 32768)
            XZCompressorInputStream(inBuf, true).use { xzIn ->
                FileOutputStream(tmpOut4).use { out ->
                    val buf = ByteArray(32768)
                    var n: Int
                    while (xzIn.read(buf).also { n = it } != -1) {
                        out.write(buf, 0, n)
                    }
                }
            }
            val r = Shell.cmd("dd if='${tmpOut4.absolutePath}' of='$outPath' bs=32768").exec()
            if (File(outPath).exists() && File(outPath).length() > 1_000_000L) {
                android.util.Log.d("FridaCtl", "Tier4 dd success")
                tmpOut4.delete()
                return
            }
            android.util.Log.w("FridaCtl", "Tier4 dd failed: ${r.out + r.err}")
        } catch (e: Exception) {
            android.util.Log.w("FridaCtl", "Tier4 exception: ${e.message}")
        } finally {
            tmpOut4.delete()
        }

        throw Exception("All XZ extraction tiers failed — check logcat for per-tier errors")
    }

    // ─────────────────────────────────────────────
    // Asset extraction (from APK assets/)
    // ─────────────────────────────────────────────

    private fun extractAsset(assetName: String, destPath: String, overwrite: Boolean = false) {
        val dest = File(destPath)
        if (!overwrite && dest.exists() && dest.length() > 1024) return
        try {
            reactApplicationContext.assets.open(assetName).use { inp ->
                FileOutputStream(dest).use { out -> inp.copyTo(out) }
            }
            dest.setExecutable(true, false)
        } catch (e: Exception) {
            throw Exception("Missing asset '$assetName'")
        }
    }
}

package com.fridactl

import android.app.*
import android.content.Intent
import android.os.*
import androidx.core.app.NotificationCompat
import com.topjohnwu.superuser.Shell
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream
import java.io.*
import java.util.zip.GZIPInputStream
import java.net.HttpURLConnection
import java.net.URL

class DownloadService : Service() {

    companion object {
        const val ACTION_START    = "com.fridactl.DOWNLOAD_START"
        const val ACTION_PROGRESS = "com.fridactl.DOWNLOAD_PROGRESS"
        const val ACTION_DONE     = "com.fridactl.DOWNLOAD_DONE"
        const val ACTION_ERROR    = "com.fridactl.DOWNLOAD_ERROR"

        const val EXTRA_VERSION  = "version"
        const val EXTRA_BINARY   = "binary"
        const val EXTRA_PERCENT  = "percent"
        const val EXTRA_MESSAGE  = "message"

        private const val CHANNEL_ID = "frida_download"
        private const val NOTIF_ID   = 1001

        private const val FRIDA_DEST     = "/data/local/tmp/frida-server"
        private const val FRIDA_CLI_DEST = "/data/local/tmp/frida-inject"
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val version = intent?.getStringExtra(EXTRA_VERSION) ?: "16.5.9"
        // startForeground MUST be called on main thread, synchronously here
        startForeground(NOTIF_ID, buildNotification("Starting download...", 0))
        Thread { doDownload(version) }.start()
        return START_NOT_STICKY
    }

    // ─── broadcast helpers — safe from any thread ───────────────────────────

    private fun broadcast(action: String, block: Intent.() -> Unit = {}) {
        val i = Intent(action).apply {
            setPackage(packageName)   // explicit package — required on Android 14+
            block()
        }
        sendBroadcast(i)
    }

    private fun emitProgress(binary: String, pct: Int) {
        updateNotification("$binary: $pct%", pct)
        broadcast(ACTION_PROGRESS) {
            putExtra(EXTRA_BINARY, binary)
            putExtra(EXTRA_PERCENT, pct)
        }
    }

    // stopForeground/stopSelf must run on main thread
    private fun finishService(action: String, msg: String) {
        broadcast(action) { putExtra(EXTRA_MESSAGE, msg) }
        mainHandler.post {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
            } catch (_: Exception) {}
            stopSelf()
        }
    }

    // ─── arch detection ──────────────────────────────────────────────────────

    /**
     * Returns the frida android arch suffix (e.g. "android-arm64") based on
     * the device's primary ABI.  Falls back to arm64 if unknown.
     */
    private fun fridaArch(): String {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        return when {
            abi.startsWith("arm64")   -> "android-arm64"
            abi.startsWith("armeabi") -> "android-arm"
            abi == "x86_64"           -> "android-x86_64"
            abi.startsWith("x86")     -> "android-x86"
            else                      -> "android-arm64"   // safe fallback
        }
    }

    // ─── main download logic (runs on background Thread) ────────────────────

    private fun doDownload(version: String) {
        val tmp  = filesDir.absolutePath
        val base = "https://github.com/frida/frida/releases/download/$version"
        val arch = fridaArch()
        val log  = StringBuilder()

        log.appendLine("▶ detected arch: $arch")

        // ── frida-server — .xz only (no .gz on GitHub releases) ─────────────
        if (!File(FRIDA_DEST).exists() || File(FRIDA_DEST).length() < 1024) {
            log.appendLine("▶ frida-server $version")
            val dl  = "$tmp/frida-server.dl"
            val bin = "$tmp/frida-server.bin"
            try {
                downloadFile(
                    "$base/frida-server-$version-$arch.xz", dl
                ) { emitProgress("frida-server", it) }
                extractXzShell(dl, bin)
                cleanup(dl)
                copyToTmp(bin, FRIDA_DEST)
                cleanup(bin)
                log.appendLine("  ✓ done")
            } catch (e: Exception) {
                cleanup(dl); cleanup(bin)
                finishService(ACTION_ERROR, "frida-server failed: ${e.message}")
                return
            }
        } else {
            log.appendLine("▶ frida-server already present")
        }

        // ── frida-inject — replaces "frida" CLI (not published for Android) ──
        // Binary name on GitHub: frida-inject-VERSION-android-ARCH.xz
        if (!File(FRIDA_CLI_DEST).exists() || File(FRIDA_CLI_DEST).length() < 1024) {
            log.appendLine("▶ frida-inject $version")
            val dl  = "$tmp/frida-inject.dl"
            val bin = "$tmp/frida-inject.bin"
            try {
                downloadFile(
                    "$base/frida-inject-$version-$arch.xz", dl
                ) { emitProgress("frida-inject", it) }
                extractXzShell(dl, bin)
                cleanup(dl)
                copyToTmp(bin, FRIDA_CLI_DEST)
                cleanup(bin)
                log.appendLine("  ✓ done")
            } catch (e: Exception) {
                cleanup(dl); cleanup(bin)
                log.appendLine("  ⚠ frida-inject failed: ${e.message}")
                // non-fatal — frida-server still usable without inject
            }
        } else {
            log.appendLine("▶ frida-inject already present")
        }

        finishService(ACTION_DONE, log.toString())
    }

    // ─── file helpers ────────────────────────────────────────────────────────

    private fun cleanup(path: String) {
        try { File(path).delete() } catch (_: Exception) {}
    }

    /** Copy extracted binary to /data/local/tmp via root shell */
    private fun copyToTmp(src: String, dest: String) {
        val r = Shell.cmd("cp '$src' '$dest' && chmod 755 '$dest'").exec()
        if (!r.isSuccess)
            throw Exception("cp failed: ${r.out.joinToString(" ")}")
    }

    // ─── download ────────────────────────────────────────────────────────────

    /** Returns true on success, false on 4xx/5xx (caller tries next URL) */
    private fun tryDownload(url: String, dest: String, onProgress: (Int) -> Unit): Boolean {
        return try {
            downloadFile(url, dest, onProgress)
            true
        } catch (e: Exception) {
            cleanup(dest)
            false
        }
    }

    private fun downloadFile(url: String, dest: String, onProgress: (Int) -> Unit) {
        var currentUrl = url
        var redirects  = 0
        var conn: HttpURLConnection? = null

        try {
            while (true) {
                conn = (URL(currentUrl).openConnection() as HttpURLConnection).also {
                    it.connectTimeout = 20_000
                    it.readTimeout    = 300_000
                    it.instanceFollowRedirects = false
                    it.setRequestProperty("User-Agent", "FridaCtl/1.0")
                    it.connect()
                }
                val code = conn.responseCode
                when {
                    code in 300..399 -> {
                        val loc = conn.getHeaderField("Location")
                            ?: throw Exception("Redirect with no Location")
                        conn.disconnect(); conn = null
                        currentUrl = loc
                        if (++redirects > 10) throw Exception("Too many redirects")
                    }
                    code !in 200..299 -> {
                        conn.disconnect(); conn = null
                        throw Exception("HTTP $code for $url")
                    }
                    else -> break
                }
            }

            val total = conn!!.contentLengthLong
            var downloaded = 0L
            var lastPct    = -1
            val buf        = ByteArray(32_768)   // 32KB chunks — balanced speed/GC

            conn.inputStream.use { inp ->
                FileOutputStream(dest).use { out ->
                    var n: Int
                    while (inp.read(buf).also { n = it } != -1) {
                        out.write(buf, 0, n)
                        downloaded += n
                        if (total > 0) {
                            val pct = ((downloaded * 100) / total).toInt().coerceIn(0, 99)
                            if (pct > lastPct) { lastPct = pct; onProgress(pct) }
                        }
                    }
                }
            }
            // emit 100 exactly once, after stream closed
            onProgress(100)

        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    // ─── extraction ──────────────────────────────────────────────────────────

    private fun extractGz(gzPath: String, outPath: String) {
        cleanup(outPath)
        BufferedInputStream(FileInputStream(gzPath), 32_768).use { bis ->
            GZIPInputStream(bis).use { gz ->
                FileOutputStream(outPath).use { out ->
                    val buf = ByteArray(32_768)
                    var n: Int
                    while (gz.read(buf).also { n = it } != -1) out.write(buf, 0, n)
                }
            }
        }
        if (!File(outPath).exists() || File(outPath).length() < 1024)
            throw Exception("GZ extraction produced empty file")
    }

    private fun extractXzShell(xzPath: String, outPath: String) {
        cleanup(outPath)

        // 1) system xz
        if (tryShellExtract("xz -d -k -c '$xzPath' > '$outPath'", outPath)) return
        // 2) busybox xz
        val bb = Shell.cmd("busybox 2>/dev/null | head -1").exec().out.firstOrNull()
        if (!bb.isNullOrBlank()) {
            if (tryShellExtract("busybox xz -d -k -c '$xzPath' > '$outPath'", outPath)) return
        }
        // 3) magisk/toybox
        if (tryShellExtract("toybox xz -d -k -c '$xzPath' > '$outPath'", outPath)) return

        // 4) Java XZ — last resort
        try {
            BufferedInputStream(FileInputStream(xzPath), 8_192).use { bis ->
                XZCompressorInputStream(bis, true).use { xzIn ->
                    FileOutputStream(outPath).use { out ->
                        val buf = ByteArray(8_192); var n: Int
                        while (xzIn.read(buf).also { n = it } != -1) out.write(buf, 0, n)
                    }
                }
            }
        } catch (e: Exception) {
            cleanup(outPath)
            throw Exception("XZ extraction failed (no shell xz + Java OOM?): ${e.message}")
        }

        if (!File(outPath).exists() || File(outPath).length() < 1024)
            throw Exception("XZ extraction produced empty file")
    }

    private fun tryShellExtract(cmd: String, outPath: String): Boolean {
        return try {
            Shell.cmd(cmd).exec()
            File(outPath).exists() && File(outPath).length() > 1024
        } catch (_: Exception) { false }
    }

    // ─── notification ────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "Frida Download", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Downloading Frida binaries" }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String, progress: Int): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("FridaCtl — Downloading")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setProgress(100, progress, progress == 0)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build()

    private fun updateNotification(text: String, progress: Int) {
        try {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIF_ID, buildNotification(text, progress))
        } catch (_: Exception) {}
    }
}

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

        // Temp download dir — /data/local/tmp is world-writable and root-accessible
        // avoids SELinux EACCES when shell tries to read from app private filesDir
        private const val TMP_DIR = "/data/local/tmp"
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
        // Strategy (SELinux-safe for all devices):
        //   1. Download .xz  → filesDir  (Java always allowed to write here)
        //   2. Extract .xz   → /data/local/tmp/ directly via root shell
        //      root shell reads filesDir fine + writes /data/local/tmp fine
        //   Java never touches /data/local/tmp — avoids all EACCES issues
        val appTmp = filesDir.absolutePath
        val base   = "https://github.com/frida/frida/releases/download/$version"
        val arch   = fridaArch()
        val log    = StringBuilder()

        log.appendLine("▶ arch: $arch")

        Shell.cmd("mkdir -p /data/local/tmp 2>/dev/null; true").exec()

        // ── frida-server ─────────────────────────────────────────────────────
        if (!File(FRIDA_DEST).exists() || File(FRIDA_DEST).length() < 1024) {
            log.appendLine("▶ downloading frida-server $version")
            val xz = "$appTmp/frida-server.xz"
            try {
                // Step 1: Java downloads .xz → filesDir
                downloadFile("$base/frida-server-$version-$arch.xz", xz) { emitProgress("frida-server", it) }
                log.appendLine("  ✓ download complete")

                // Step 2: root shell extracts .xz → /data/local/tmp (never touches filesDir for output)
                val extracted = extractXzToDestShell(xz, FRIDA_DEST)
                cleanup(xz)
                if (!extracted) throw Exception("all XZ extraction methods failed")
                Shell.cmd("chmod 755 '$FRIDA_DEST'").exec()
                log.appendLine("  ✓ installed (${File(FRIDA_DEST).length()/1024}KB)")
            } catch (e: Exception) {
                cleanup(xz)
                finishService(ACTION_ERROR, "frida-server failed: ${e.message}")
                return
            }
        } else {
            log.appendLine("▶ frida-server already present (${File(FRIDA_DEST).length()/1024}KB)")
        }

        // ── frida-inject ─────────────────────────────────────────────────────
        if (!File(FRIDA_CLI_DEST).exists() || File(FRIDA_CLI_DEST).length() < 1024) {
            log.appendLine("▶ downloading frida-inject $version")
            val xz = "$appTmp/frida-inject.xz"
            try {
                downloadFile("$base/frida-inject-$version-$arch.xz", xz) { emitProgress("frida-inject", it) }
                val extracted = extractXzToDestShell(xz, FRIDA_CLI_DEST)
                cleanup(xz)
                if (!extracted) throw Exception("all XZ extraction methods failed")
                Shell.cmd("chmod 755 '$FRIDA_CLI_DEST'").exec()
                log.appendLine("  ✓ installed (${File(FRIDA_CLI_DEST).length()/1024}KB)")
            } catch (e: Exception) {
                cleanup(xz)
                log.appendLine("  ⚠ frida-inject failed (non-fatal): ${e.message}")
            }
        } else {
            log.appendLine("▶ frida-inject already present")
        }

        finishService(ACTION_DONE, log.toString())
    }

    /**
     * Extract .xz file directly to dest using root shell — no Java I/O on output.
     * Tries multiple decompressors available on rooted Android devices.
     * Returns true if dest exists and size > 1MB after extraction.
     */
    private fun extractXzToDestShell(xzPath: String, dest: String): Boolean {
        Shell.cmd("rm -f '$dest' 2>/dev/null; true").exec()

        // Each command reads xzPath (in filesDir — readable by root shell)
        // and writes directly to dest (in /data/local/tmp — writable by root shell)
        val cmds = listOf(
            "xz -d -k -c '$xzPath' > '$dest'",
            "busybox xz -d -k -c '$xzPath' > '$dest'",
            "toybox xz -d -k -c '$xzPath' > '$dest'",
            "unxz -k -c '$xzPath' > '$dest'",
            "python3 -c \"import lzma; open('$dest','wb').write(lzma.open('$xzPath').read())\"",
            "python -c \"import lzma; open('$dest','wb').write(lzma.open('$xzPath').read())\"",
        )

        for (cmd in cmds) {
            try {
                Shell.cmd(cmd).exec()
                if (File(dest).exists() && File(dest).length() > 1_000_000) return true
            } catch (_: Exception) {}
            // clean partial output before next attempt
            Shell.cmd("rm -f '$dest' 2>/dev/null; true").exec()
        }

        // Last resort: Java XZ — reads xzPath, writes to a root-shell-piped tmp
        // Use a named pipe trick: write via stdout redirect through shell
        try {
            val pipeTmp = "$dest.raw"
            Shell.cmd("rm -f '$pipeTmp' 2>/dev/null; true").exec()
            // Extract via Java to pipeTmp in /data/local/tmp (root shell made this writable)
            // Actually just try Java directly to dest since we already tried shell
            XZCompressorInputStream(
                BufferedInputStream(FileInputStream(xzPath), 4_096), true
            ).use { xzIn ->
                // Write to a ByteArray first to avoid partial-write EACCES
                val bytes = xzIn.readBytes()
                // Use root shell to write bytes — pipe through dd
                val proc = Runtime.getRuntime().exec(arrayOf("su", "-c", "dd of='$dest' bs=4096"))
                proc.outputStream.write(bytes)
                proc.outputStream.close()
                proc.waitFor()
            }
            if (File(dest).exists() && File(dest).length() > 1_000_000) return true
        } catch (_: Exception) {}

        return false
    }

    // ─── file helpers ────────────────────────────────────────────────────────

    private fun cleanup(path: String) {
        try { File(path).delete() } catch (_: Exception) {}
    }

    // ─── download ────────────────────────────────────────────────────────────

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

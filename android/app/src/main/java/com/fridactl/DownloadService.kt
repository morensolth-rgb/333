package com.fridactl

import android.app.*
import android.content.Intent
import android.os.*
import androidx.core.app.NotificationCompat
import com.topjohnwu.superuser.Shell
import java.io.*
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

        // Pre-extracted frida binaries hosted as GitHub release assets (no .xz on device!)
        // Hosted at: github.com/morensolth-rgb/333/releases/tag/frida-{version}
        private const val PREBUILT_BASE =
            "https://github.com/morensolth-rgb/333/releases/download"
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val version = intent?.getStringExtra(EXTRA_VERSION) ?: "16.5.9"
        startForeground(NOTIF_ID, buildNotification("Starting download...", 0))
        Thread { doDownload(version) }.start()
        return START_NOT_STICKY
    }

    // ─── broadcast helpers ───────────────────────────────────────────────────

    private fun broadcast(action: String, block: Intent.() -> Unit = {}) {
        val i = Intent(action).apply {
            setPackage(packageName)
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

    private fun fridaArch(): String {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        return when {
            abi.startsWith("arm64")   -> "android-arm64"
            abi.startsWith("armeabi") -> "android-arm"
            abi == "x86_64"           -> "android-x86_64"
            abi.startsWith("x86")     -> "android-x86"
            else                      -> "android-arm64"
        }
    }

    // ─── main download logic ──────────────────────────────────────────────────

    private fun doDownload(version: String) {
        // Strategy: download RAW (pre-decompressed) binary from our GitHub release assets.
        // No .xz extraction needed on device — binaries are already decompressed.
        //
        // Flow:
        //   1. Download raw binary → filesDir  (Java always allowed to write here)
        //   2. Root shell copies it → /data/local/tmp  (bypasses SELinux on Java process)
        //   3. Root shell sets chmod 755
        val appTmp = filesDir.absolutePath
        val arch   = fridaArch()
        val log    = StringBuilder()

        log.appendLine("▶ arch: $arch | version: $version")

        Shell.cmd("mkdir -p /data/local/tmp 2>/dev/null; true").exec()

        // ── frida-server ──────────────────────────────────────────────────────
        if (!File(FRIDA_DEST).exists() || File(FRIDA_DEST).length() < 1024) {
            log.appendLine("▶ downloading frida-server")
            val rawPath = "$appTmp/frida-server.bin"
            try {
                // Raw pre-extracted binary — no XZ decompression needed
                val url = "$PREBUILT_BASE/frida-$version/frida-server-$version-$arch"
                downloadFile(url, rawPath) { emitProgress("frida-server", it) }

                val size = File(rawPath).length()
                log.appendLine("  ✓ download: ${size/1024}KB")
                if (size < 1_000_000) throw Exception("Downloaded file too small: $size bytes")

                copyToDestViaRoot(rawPath, FRIDA_DEST)
                cleanup(rawPath)
                Shell.cmd("chmod 755 '$FRIDA_DEST'").exec()
                log.appendLine("  ✓ installed (${File(FRIDA_DEST).length()/1024}KB)")
            } catch (e: Exception) {
                cleanup(rawPath)
                finishService(ACTION_ERROR, "frida-server failed: ${e.message}")
                return
            }
        } else {
            log.appendLine("▶ frida-server OK (${File(FRIDA_DEST).length()/1024}KB)")
        }

        // ── frida-inject ──────────────────────────────────────────────────────
        if (!File(FRIDA_CLI_DEST).exists() || File(FRIDA_CLI_DEST).length() < 1024) {
            log.appendLine("▶ downloading frida-inject")
            val rawPath = "$appTmp/frida-inject.bin"
            try {
                val url = "$PREBUILT_BASE/frida-$version/frida-inject-$version-$arch"
                downloadFile(url, rawPath) { emitProgress("frida-inject", it) }

                val size = File(rawPath).length()
                if (size < 1_000_000) throw Exception("Downloaded file too small: $size bytes")

                copyToDestViaRoot(rawPath, FRIDA_CLI_DEST)
                cleanup(rawPath)
                Shell.cmd("chmod 755 '$FRIDA_CLI_DEST'").exec()
                log.appendLine("  ✓ installed (${File(FRIDA_CLI_DEST).length()/1024}KB)")
            } catch (e: Exception) {
                cleanup(rawPath)
                log.appendLine("  ⚠ frida-inject failed (non-fatal): ${e.message}")
            }
        } else {
            log.appendLine("▶ frida-inject OK")
        }

        finishService(ACTION_DONE, log.toString())
    }

    /**
     * Copy a file from filesDir (Java-writable) to dest (root-only) via root shell.
     * Java never writes to /data/local/tmp — avoids all SELinux EACCES.
     *
     * Tries multiple strategies:
     *   1. cp   — most Android devices have this
     *   2. cat  redirect — universal
     *   3. dd   — universal  
     *   4. libsu Shell + stdin pipe (cat > dest) — final fallback
     */
    private fun copyToDestViaRoot(srcPath: String, dest: String) {
        Shell.cmd("rm -f '$dest' 2>/dev/null; true").exec()

        // Tier 1: shell copy commands
        val copyCmds = listOf(
            "cp '$srcPath' '$dest'",
            "cat '$srcPath' > '$dest'",
            "dd if='$srcPath' of='$dest' bs=65536",
        )
        for (cmd in copyCmds) {
            try {
                val r = Shell.cmd(cmd).exec()
                if (r.isSuccess && File(dest).exists() && File(dest).length() > 1_000_000) return
            } catch (_: Exception) {}
            Shell.cmd("rm -f '$dest' 2>/dev/null; true").exec()
        }

        // Tier 2: libsu Shell with stdin pipe (some Magisk builds handle this better)
        try {
            val fis = FileInputStream(srcPath)
            val r = Shell.cmd("cat > '$dest'").add(fis).exec()
            if (File(dest).exists() && File(dest).length() > 1_000_000) return
        } catch (_: Exception) {}

        Shell.cmd("rm -f '$dest' 2>/dev/null; true").exec()
        throw Exception("all copy methods failed for $dest")
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
                    it.connectTimeout = 30_000
                    it.readTimeout    = 600_000   // 10 min for large binary
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
            val buf        = ByteArray(32_768)

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
            onProgress(100)

        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }

    // ─── notification ─────────────────────────────────────────────────────────

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

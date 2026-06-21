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

    /**
     * Detect real arch from kernel — NOT Build.SUPPORTED_ABIS.
     * VMs like VMOS lie about ABI. /proc/cpuinfo + uname -m = kernel truth.
     */
    private fun detectRealArch(): String {
        val cpuinfo = try {
            val p = ProcessBuilder("sh", "-c", "cat /proc/cpuinfo 2>/dev/null").start()
            p.inputStream.bufferedReader().readText().also { p.waitFor() }
        } catch (_: Exception) { "" }

        return when {
            cpuinfo.contains("aarch64", ignoreCase = true) ||
            cpuinfo.contains("ARMv8",   ignoreCase = true)   -> "arm64"
            cpuinfo.contains("x86_64",  ignoreCase = true) ||
            cpuinfo.contains("AMD64",   ignoreCase = true)   -> "x86_64"
            else -> {
                val uname = try {
                    val p = ProcessBuilder("sh", "-c", "uname -m 2>/dev/null").start()
                    p.inputStream.bufferedReader().readText().trim().also { p.waitFor() }
                } catch (_: Exception) { "" }
                when {
                    uname.contains("aarch64") -> "arm64"
                    uname.contains("x86_64")  -> "x86_64"
                    uname.contains("i686") || uname.contains("i386") -> "x86"
                    uname.contains("arm")     -> "arm"
                    else -> {
                        // Last resort: Build.SUPPORTED_ABIS
                        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
                        when {
                            abi.startsWith("arm64") -> "arm64"
                            abi == "x86_64"         -> "x86_64"
                            abi.startsWith("x86")   -> "x86"
                            else                    -> "arm"
                        }
                    }
                }
            }
        }
    }

    private fun fridaArch(): String = when (detectRealArch()) {
        "arm64"  -> "android-arm64"
        "x86_64" -> "android-x86_64"
        "x86"    -> "android-x86"
        else     -> "android-arm"
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
        val appTmp   = filesDir.absolutePath
        val realArch = detectRealArch()
        val arch     = fridaArch()
        val log      = StringBuilder()

        log.appendLine("▶ real arch: $realArch → frida arch: $arch | version: $version")
        // Warn if arch detection used fallback (VM may lie)
        val buildAbi = Build.SUPPORTED_ABIS.firstOrNull() ?: ""
        if ((realArch == "x86_64" && buildAbi.startsWith("arm")) ||
            (realArch == "arm64"  && buildAbi.startsWith("x86"))) {
            log.appendLine("⚠ ABI translation detected: kernel=$realArch, Build.ABI=$buildAbi")
            log.appendLine("⚠ Downloading $arch binary — if it fails, device may be VM with Houdini")
        }

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
                val installedSize = File(FRIDA_DEST).length()
                log.appendLine("  ✓ installed (${installedSize/1024}KB)")

                // Validate binary executes on this arch
                val verOut = try {
                    Shell.cmd("'$FRIDA_DEST' --version 2>/dev/null").exec()
                        .out.firstOrNull()?.trim()
                } catch (_: Exception) { null }
                if (verOut.isNullOrBlank()) {
                    log.appendLine("  ❌ binary won't execute on this device!")
                    log.appendLine("  ❌ Arch mismatch? kernel=$realArch but downloaded $arch")
                    log.appendLine("  ❌ This device may not support this binary format")
                    Shell.cmd("rm -f '$FRIDA_DEST'").exec()
                    finishService(ACTION_ERROR,
                        "frida-server downloaded but won't run on this device.\n" +
                        "Kernel arch: $realArch | Downloaded: $arch\n" +
                        "This may be a VM (VMOS/BlueStacks) that blocks direct kernel access.")
                    return
                }
                log.appendLine("  ✓ version: $verOut")
            } catch (e: Exception) {
                cleanup(rawPath)
                finishService(ACTION_ERROR, "frida-server failed: ${e.message}")
                return
            }
        } else {
            val verOut = try {
                Shell.cmd("'$FRIDA_DEST' --version 2>/dev/null").exec().out.firstOrNull()?.trim()
            } catch (_: Exception) { null }
            if (verOut.isNullOrBlank()) {
                log.appendLine("▶ frida-server exists but won't execute — re-downloading")
                Shell.cmd("rm -f '$FRIDA_DEST'").exec()
                // Will be downloaded on next call — for now inform user
                finishService(ACTION_ERROR,
                    "Existing frida-server binary is corrupt or wrong arch.\n" +
                    "Deleted it. Please retry download.\nKernel arch: $realArch")
                return
            }
            log.appendLine("▶ frida-server OK v$verOut (${File(FRIDA_DEST).length()/1024}KB)")
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

                // Validate frida-inject executes
                val injVer = try {
                    Shell.cmd("'$FRIDA_CLI_DEST' --version 2>/dev/null").exec()
                        .out.firstOrNull()?.trim()
                } catch (_: Exception) { null }
                if (injVer.isNullOrBlank()) {
                    log.appendLine("  ⚠ frida-inject downloaded but won't execute (arch mismatch?)")
                    log.appendLine("  ⚠ kernel=$realArch, downloaded $arch")
                    Shell.cmd("rm -f '$FRIDA_CLI_DEST'").exec()
                } else {
                    log.appendLine("  ✓ installed v$injVer (${File(FRIDA_CLI_DEST).length()/1024}KB)")
                }
            } catch (e: Exception) {
                cleanup(rawPath)
                log.appendLine("  ⚠ frida-inject failed (non-fatal): ${e.message}")
            }
        } else {
            val injVer = try {
                Shell.cmd("'$FRIDA_CLI_DEST' --version 2>/dev/null").exec().out.firstOrNull()?.trim()
            } catch (_: Exception) { null }
            if (injVer.isNullOrBlank()) {
                Shell.cmd("rm -f '$FRIDA_CLI_DEST'").exec()
                log.appendLine("▶ frida-inject existed but won't execute — deleted (retry download)")
            } else {
                log.appendLine("▶ frida-inject OK v$injVer")
            }
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

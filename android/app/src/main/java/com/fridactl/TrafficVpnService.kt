package com.fridactl

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.InetAddress
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

data class TrafficEntry(
    val timestamp: Long,
    val protocol: String,
    val srcIp: String,
    val dstIp: String,
    val dstPort: Int,
    val length: Int,
    val direction: String // "out" | "in"
) {
    fun toJson(): String {
        val host = try {
            KnownPorts.resolve(dstPort) ?: dstIp
        } catch (e: Exception) { dstIp }
        return JSONObject().apply {
            put("ts", timestamp)
            put("protocol", protocol)
            put("src", srcIp)
            put("dst", dstIp)
            put("host", host)
            put("port", dstPort)
            put("len", length)
            put("dir", direction)
        }.toString()
    }
}

object KnownPorts {
    private val map = mapOf(
        80 to "HTTP", 443 to "HTTPS", 8080 to "HTTP-Alt",
        8443 to "HTTPS-Alt", 53 to "DNS", 22 to "SSH",
        21 to "FTP", 25 to "SMTP", 3306 to "MySQL",
        5432 to "PostgreSQL", 6379 to "Redis", 27017 to "MongoDB"
    )
    fun resolve(port: Int): String? = map[port]
}

class TrafficVpnService : VpnService() {

    companion object {
        const val TAG = "TrafficVpnService"
        const val CHANNEL_ID = "traffic_vpn_channel"
        const val NOTIF_ID = 7777
        const val ACTION_START = "com.fridactl.START_VPN"
        const val ACTION_STOP  = "com.fridactl.STOP_VPN"
        const val EXTRA_PKG    = "target_package"

        // Shared state — accessed from TrafficModule
        val isRunning = AtomicBoolean(false)
        val capturedPackets: CopyOnWriteArrayList<TrafficEntry> = CopyOnWriteArrayList()
        var targetPackage: String = ""
        var onPacketCallback: ((TrafficEntry) -> Unit)? = null

        // NDK needs raw fd of the VPN TUN interface
        @Volatile private var _vpnFd: Int = -1
        fun getVpnFd(): Int = _vpnFd
        internal fun setVpnFd(fd: Int) { _vpnFd = fd }
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private var running = false
    private var readerThread: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopVpn()
            return START_NOT_STICKY
        }

        targetPackage = intent?.getStringExtra(EXTRA_PKG) ?: ""
        startForeground(NOTIF_ID, buildNotification())
        startVpn()
        return START_STICKY
    }

    private fun startVpn() {
        try {
            val builder = Builder()
                .setSession("FridaCtl Traffic")
                .addAddress("10.0.0.2", 24)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("8.8.8.8")
                .addDnsServer("1.1.1.1")
                .setMtu(1500)
                .setBlocking(true)

            if (targetPackage.isNotEmpty()) {
                try {
                    builder.addAllowedApplication(targetPackage)
                    builder.addAllowedApplication(packageName)
                } catch (e: Exception) {
                    Log.w(TAG, "addAllowedApplication failed, capturing all: ${e.message}")
                }
            }

            val iface = builder.establish()
            if (iface == null) {
                Log.e(TAG, "establish() returned null — VPN permission missing or revoked")
                isRunning.set(false)
                stopSelf()
                return
            }

            vpnInterface = iface
            setVpnFd(iface.fd)   // expose fd for NDK layer
            running = true
            isRunning.set(true)
            capturedPackets.clear()

            // Start HTTP proxy — captures plain HTTP with full headers/body
            HttpProxyServer.start()

            readerThread = Thread { readPackets() }.apply {
                name = "TrafficVpnReader"
                isDaemon = true
                start()
            }

        } catch (e: Exception) {
            Log.e(TAG, "startVpn error: ${e.message}")
            isRunning.set(false)
            stopSelf()
        }
    }

    private fun readPackets() {
        val vpnFd = vpnInterface ?: return
        val inputStream  = FileInputStream(vpnFd.fileDescriptor)
        val outputStream = FileOutputStream(vpnFd.fileDescriptor)
        val packet = ByteArray(32767)

        while (running) {
            try {
                val len = inputStream.read(packet)
                if (len <= 0) {
                    Thread.sleep(1)
                    continue
                }

                // Parse — never let a bad packet crash the loop
                try {
                    val buf = ByteBuffer.wrap(packet, 0, len)
                    parseIpPacket(buf, len)
                } catch (pe: Exception) {
                    Log.v(TAG, "parse error (ignored): ${pe.message}")
                }

                // Forward packet back so internet still works
                try {
                    outputStream.write(packet, 0, len)
                } catch (we: Exception) {
                    Log.v(TAG, "write error: ${we.message}")
                }

            } catch (e: InterruptedException) {
                break
            } catch (e: Exception) {
                if (running) Log.w(TAG, "read error: ${e.message}")
                // Small back-off to avoid tight error loop
                try { Thread.sleep(5) } catch (_: InterruptedException) { break }
            }
        }
    }

    private fun parseIpPacket(buf: ByteBuffer, totalLen: Int) {
        if (totalLen < 20) return

        val versionIhl = buf.get(0).toInt() and 0xFF
        val version    = (versionIhl shr 4)
        if (version != 4) return // IPv4 only for now

        val ihl        = (versionIhl and 0x0F) * 4
        val protocol   = buf.get(9).toInt() and 0xFF

        val srcIp = formatIp(buf, 12)
        val dstIp = formatIp(buf, 16)

        val (protoName, dstPort) = when (protocol) {
            6  -> { // TCP
                if (totalLen < ihl + 4) return
                val port = ((buf.get(ihl + 2).toInt() and 0xFF) shl 8) or
                            (buf.get(ihl + 3).toInt() and 0xFF)
                "TCP" to port
            }
            17 -> { // UDP
                if (totalLen < ihl + 4) return
                val port = ((buf.get(ihl + 2).toInt() and 0xFF) shl 8) or
                            (buf.get(ihl + 3).toInt() and 0xFF)
                "UDP" to port
            }
            1  -> "ICMP" to 0
            else -> return
        }

        val entry = TrafficEntry(
            timestamp  = System.currentTimeMillis(),
            protocol   = protoName,
            srcIp      = srcIp,
            dstIp      = dstIp,
            dstPort    = dstPort,
            length     = totalLen,
            direction  = "out"
        )

        // Limit to 2000 entries in memory
        if (capturedPackets.size >= 2000) {
            capturedPackets.removeAt(0)
        }
        capturedPackets.add(entry)
        onPacketCallback?.invoke(entry)
    }

    private fun formatIp(buf: ByteBuffer, offset: Int): String {
        return "${buf.get(offset).toInt() and 0xFF}." +
               "${buf.get(offset+1).toInt() and 0xFF}." +
               "${buf.get(offset+2).toInt() and 0xFF}." +
               "${buf.get(offset+3).toInt() and 0xFF}"
    }

    private fun stopVpn() {
        running = false
        isRunning.set(false)
        setVpnFd(-1)   // invalidate fd — NDK should have stopped already
        readerThread?.interrupt()
        readerThread = null
        try { vpnInterface?.close() } catch (e: Exception) { }
        vpnInterface = null
        HttpProxyServer.stop()
        stopForeground(true)
        stopSelf()
    }

    override fun onDestroy() {
        stopVpn()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val chan = NotificationChannel(
                CHANNEL_ID, "Traffic Capture",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "FridaCtl VPN traffic capture" }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(chan)
        }

        val stopIntent = Intent(this, TrafficVpnService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPi = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val pkg = if (targetPackage.isEmpty()) "All Apps" else targetPackage
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("FridaCtl — Capturing Traffic")
            .setContentText("Target: $pkg")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .addAction(android.R.drawable.ic_delete, "Stop", stopPi)
            .setOngoing(true)
            .build()
    }
}

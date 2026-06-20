package com.fridactl

import android.util.Log
import java.io.*
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

data class HttpRequest(
    val id: Long,
    val ts: Long,
    val method: String,
    val url: String,
    val host: String,
    val path: String,
    val headers: Map<String, String>,
    val body: String,
    val source: String = "proxy" // "proxy" | "frida"
)

data class HttpResponse(
    val requestId: Long,
    val ts: Long,
    val statusCode: Int,
    val statusText: String,
    val headers: Map<String, String>,
    val body: String,
    val source: String = "proxy"
)

object HttpProxyServer {

    const val TAG = "HttpProxyServer"
    const val PROXY_PORT = 8877

    val isRunning = AtomicBoolean(false)
    val requests  = CopyOnWriteArrayList<HttpRequest>()
    val responses = CopyOnWriteArrayList<HttpResponse>()

    var onRequest:  ((HttpRequest)  -> Unit)? = null
    var onResponse: ((HttpResponse) -> Unit)? = null

    private var serverSocket: ServerSocket? = null
    private val executor = Executors.newCachedThreadPool()
    private var idCounter = 0L

    fun start() {
        if (isRunning.get()) return
        try {
            serverSocket = ServerSocket(PROXY_PORT)
            isRunning.set(true)
            executor.execute { acceptLoop() }
            Log.i(TAG, "HTTP proxy started on port $PROXY_PORT")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start proxy: ${e.message}")
        }
    }

    fun stop() {
        isRunning.set(false)
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        Log.i(TAG, "HTTP proxy stopped")
    }

    fun clear() {
        requests.clear()
        responses.clear()
    }

    private fun acceptLoop() {
        while (isRunning.get()) {
            try {
                val client = serverSocket?.accept() ?: break
                executor.execute { handleClient(client) }
            } catch (e: SocketException) {
                if (isRunning.get()) Log.w(TAG, "accept error: ${e.message}")
                break
            } catch (e: Exception) {
                Log.w(TAG, "accept loop: ${e.message}")
            }
        }
    }

    private fun handleClient(client: Socket) {
        try {
            client.soTimeout = 10000
            val inStream  = client.getInputStream().buffered()
            val outStream = client.getOutputStream()

            // Read request line
            val requestLine = readLine(inStream) ?: return
            val parts = requestLine.trim().split(" ")
            if (parts.size < 3) return

            val method = parts[0]
            val rawUrl = parts[1]

            // Read headers
            val reqHeaders = mutableMapOf<String, String>()
            var line: String?
            while (true) {
                line = readLine(inStream)
                if (line.isNullOrBlank()) break
                val colonIdx = line.indexOf(':')
                if (colonIdx > 0) {
                    val k = line.substring(0, colonIdx).trim().lowercase()
                    val v = line.substring(colonIdx + 1).trim()
                    reqHeaders[k] = v
                }
            }

            val host = reqHeaders["host"] ?: ""
            val contentLength = reqHeaders["content-length"]?.toIntOrNull() ?: 0

            // Read body
            val bodyBytes = if (contentLength > 0) {
                val buf = ByteArray(minOf(contentLength, 65536))
                var read = 0
                while (read < buf.size) {
                    val n = inStream.read(buf, read, buf.size - read)
                    if (n <= 0) break
                    read += n
                }
                buf.copyOf(read)
            } else ByteArray(0)

            val bodyStr = tryDecodeBody(bodyBytes, reqHeaders["content-type"])

            // Build full URL
            val fullUrl = if (rawUrl.startsWith("http")) rawUrl
                          else "http://$host$rawUrl"
            val path    = if (rawUrl.startsWith("http")) {
                try { java.net.URL(rawUrl).path } catch (_: Exception) { rawUrl }
            } else rawUrl

            val reqId = ++idCounter
            val req = HttpRequest(
                id      = reqId,
                ts      = System.currentTimeMillis(),
                method  = method,
                url     = fullUrl,
                host    = host,
                path    = path,
                headers = reqHeaders,
                body    = bodyStr,
                source  = "proxy"
            )

            if (requests.size >= 500) requests.removeAt(0)
            requests.add(req)
            onRequest?.invoke(req)

            // Forward to real server
            val targetHost = host.substringBefore(":")
            val targetPort = host.substringAfter(":", "80").toIntOrNull() ?: 80

            try {
                val server = Socket(targetHost, targetPort)
                server.soTimeout = 10000

                val srvOut = server.getOutputStream()
                val srvIn  = server.getInputStream().buffered()

                // Write original request to server
                val reqBuilder = StringBuilder()
                reqBuilder.append("$method $rawUrl ${parts[2]}\r\n")
                reqHeaders.forEach { (k, v) -> reqBuilder.append("$k: $v\r\n") }
                reqBuilder.append("\r\n")
                srvOut.write(reqBuilder.toString().toByteArray())
                if (bodyBytes.isNotEmpty()) srvOut.write(bodyBytes)
                srvOut.flush()

                // Read response status line
                val statusLine = readLine(srvIn) ?: ""
                val statusParts = statusLine.trim().split(" ", limit = 3)
                val statusCode  = statusParts.getOrNull(1)?.toIntOrNull() ?: 0
                val statusText  = statusParts.getOrNull(2) ?: ""

                // Read response headers
                val resHeaders = mutableMapOf<String, String>()
                while (true) {
                    val rl = readLine(srvIn)
                    if (rl.isNullOrBlank()) break
                    val ci = rl.indexOf(':')
                    if (ci > 0) {
                        resHeaders[rl.substring(0, ci).trim().lowercase()] = rl.substring(ci + 1).trim()
                    }
                }

                val resContentLength = resHeaders["content-length"]?.toIntOrNull() ?: -1
                val isChunked = resHeaders["transfer-encoding"]?.contains("chunked") == true

                // Read response body
                val resBodyBytes = when {
                    resContentLength > 0 -> {
                        val buf = ByteArray(minOf(resContentLength, 131072))
                        var read = 0
                        while (read < buf.size) {
                            val n = srvIn.read(buf, read, buf.size - read)
                            if (n <= 0) break
                            read += n
                        }
                        buf.copyOf(read)
                    }
                    isChunked -> readChunked(srvIn)
                    else -> ByteArray(0)
                }

                val resBodyStr = tryDecodeBody(resBodyBytes, resHeaders["content-type"])

                val res = HttpResponse(
                    requestId  = reqId,
                    ts         = System.currentTimeMillis(),
                    statusCode = statusCode,
                    statusText = statusText,
                    headers    = resHeaders,
                    body       = resBodyStr,
                    source     = "proxy"
                )
                if (responses.size >= 500) responses.removeAt(0)
                responses.add(res)
                onResponse?.invoke(res)

                // Forward response back to client
                val resBuilder = StringBuilder()
                resBuilder.append("$statusLine\r\n")
                resHeaders.forEach { (k, v) -> resBuilder.append("$k: $v\r\n") }
                resBuilder.append("\r\n")
                outStream.write(resBuilder.toString().toByteArray())
                if (resBodyBytes.isNotEmpty()) outStream.write(resBodyBytes)
                outStream.flush()

                server.close()
            } catch (e: Exception) {
                Log.w(TAG, "forward error for $host: ${e.message}")
                // Return 502 to client
                outStream.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n".toByteArray())
                outStream.flush()
            }

        } catch (e: Exception) {
            Log.w(TAG, "handleClient: ${e.message}")
        } finally {
            try { client.close() } catch (_: Exception) {}
        }
    }

    private fun readLine(stream: InputStream): String? {
        val sb = StringBuilder()
        var prev = -1
        while (true) {
            val b = stream.read()
            if (b == -1) return if (sb.isEmpty()) null else sb.toString()
            if (prev == '\r'.code && b == '\n'.code) {
                sb.deleteCharAt(sb.length - 1)
                return sb.toString()
            }
            sb.append(b.toChar())
            prev = b
        }
    }

    private fun readChunked(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val sizeLine = readLine(stream)?.trim() ?: break
            val chunkSize = sizeLine.toIntOrNull(16) ?: break
            if (chunkSize == 0) break
            val buf = ByteArray(chunkSize)
            var read = 0
            while (read < chunkSize) {
                val n = stream.read(buf, read, chunkSize - read)
                if (n <= 0) break
                read += n
            }
            out.write(buf, 0, read)
            readLine(stream) // CRLF after chunk
            if (out.size() > 131072) break // cap at 128KB
        }
        return out.toByteArray()
    }

    private fun tryDecodeBody(bytes: ByteArray, contentType: String?): String {
        if (bytes.isEmpty()) return ""
        val ct = contentType?.lowercase() ?: ""
        return try {
            when {
                ct.contains("json") || ct.contains("text") || ct.contains("xml")
                || ct.contains("form") || ct.contains("javascript") ->
                    String(bytes, Charsets.UTF_8)
                else -> "[binary ${bytes.size}B]"
            }
        } catch (_: Exception) {
            "[binary ${bytes.size}B]"
        }
    }
}

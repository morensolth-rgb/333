package com.fridactl

import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.util.Base64
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.facebook.react.bridge.*
import com.topjohnwu.superuser.Shell
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipFile

class RootBridgeModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName() = "RootBridge"

    companion object {
        private var pythonStarted = false

        @Synchronized
        fun ensurePython(ctx: ReactApplicationContext) {
            if (!pythonStarted) {
                Python.start(AndroidPlatform(ctx))
                pythonStarted = true
            }
        }
    }

    // Scratch root for all extraction output (no root needed to read it later)
    private fun scratchRoot(): File =
        File(ctx.filesDir, "extracted").apply { mkdirs() }

    private fun gameDir(pkg: String): File =
        File(scratchRoot(), pkg).apply { mkdirs() }

    // ─────────────────────────────────────────────
    // Root & shell
    // ─────────────────────────────────────────────
    @ReactMethod
    fun checkRoot(promise: Promise) {
        Thread {
            try {
                val r = Shell.cmd("id").exec()
                promise.resolve(r.isSuccess && r.out.any { it.contains("uid=0") })
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }.start()
    }

    @ReactMethod
    fun execShell(cmd: String, promise: Promise) {
        Thread {
            try {
                val r = Shell.cmd(cmd).exec()
                promise.resolve(r.out.joinToString("\n"))
            } catch (e: Exception) {
                promise.reject("SHELL_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // Installed apps (launcher apps, classified via PM flags — no root)
    // ─────────────────────────────────────────────
    @ReactMethod
    fun getInstalledApps(promise: Promise) {
        Thread {
            try {
                val pm = ctx.packageManager
                val intent = android.content.Intent(android.content.Intent.ACTION_MAIN, null)
                intent.addCategory(android.content.Intent.CATEGORY_LAUNCHER)

                @Suppress("DEPRECATION")
                val activities = pm.queryIntentActivities(intent, 0)

                val arr = WritableNativeArray()
                val seen = HashSet<String>()

                for (ri in activities) {
                    val pkg = ri.activityInfo.packageName
                    if (pkg.isBlank() || !seen.add(pkg)) continue

                    val isSystem = try {
                        val ai = pm.getApplicationInfo(pkg, 0)
                        (ai.flags and ApplicationInfo.FLAG_SYSTEM) != 0 &&
                            (ai.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0
                    } catch (e: Exception) {
                        false
                    }

                    val map = WritableNativeMap()
                    map.putString("packageName", pkg)
                    map.putString("appName", ri.loadLabel(pm).toString())
                    map.putBoolean("isSystemApp", isSystem)
                    arr.pushMap(map)
                }

                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("APPS_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun getAppIcon(packageName: String, promise: Promise) {
        Thread {
            try {
                val drawable = ctx.packageManager.getApplicationIcon(packageName)
                val bitmap = if (drawable is BitmapDrawable && drawable.bitmap != null) {
                    drawable.bitmap
                } else {
                    val w = drawable.intrinsicWidth.takeIf { it > 0 } ?: 96
                    val h = drawable.intrinsicHeight.takeIf { it > 0 } ?: 96
                    Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bmp ->
                        val canvas = Canvas(bmp)
                        drawable.setBounds(0, 0, canvas.width, canvas.height)
                        drawable.draw(canvas)
                    }
                }
                val stream = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 90, stream)
                promise.resolve("data:image/png;base64," + Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP))
            } catch (e: Exception) {
                promise.resolve(null)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // APK staging — copy base.apk + splits to scratch via root
    // Returns the staged dir path
    // ─────────────────────────────────────────────
    private fun stageApks(pkg: String): File {
        val dir = File(gameDir(pkg), "apk").apply { mkdirs() }
        // Copy all apk files of the package (base + splits). Path pattern is stable.
        Shell.cmd(
            "for p in \$(pm path $pkg 2>/dev/null | sed 's/^package://'); do " +
            "cp \"\$p\" '${dir.absolutePath}/' 2>/dev/null; done"
        ).exec()
        if (dir.listFiles().isNullOrEmpty()) {
            throw Exception("Could not stage APK for $pkg (root copy failed)")
        }
        return dir
    }

    // ─────────────────────────────────────────────
    // locateUnityFiles — find global-metadata.dat + libil2cpp.so + *.unity3d
    // inside the staged APK(s). Returns JSON-ish map with paths after extraction.
    // ─────────────────────────────────────────────
    @ReactMethod
    fun locateUnityFiles(pkg: String, promise: Promise) {
        Thread {
            try {
                val dir = stageApks(pkg)
                val outDir = File(gameDir(pkg), "il2cpp").apply { mkdirs() }

                var metadata: File? = null
                var lib: File? = null
                val unity3dFiles = WritableNativeArray()

                for (apk in dir.listFiles() ?: emptyArray()) {
                    if (!apk.name.endsWith(".apk")) continue
                    try {
                        ZipFile(apk).use { zip ->
                            val entries = zip.entries()
                            while (entries.hasMoreElements()) {
                                val e = entries.nextElement()
                                val name = e.name
                                val lower = name.lowercase()
                                when {
                                    // prefer arm64 libil2cpp
                                    lower.endsWith("libil2cpp.so") && name.contains("arm64") -> {
                                        val f = File(outDir, "libil2cpp.so")
                                        zip.getInputStream(e).use { it.copyTo(f.outputStream()) }
                                        lib = f
                                    }
                                    lower.endsWith("libil2cpp.so") && lib == null -> {
                                        val f = File(outDir, "libil2cpp.so")
                                        zip.getInputStream(e).use { it.copyTo(f.outputStream()) }
                                        lib = f
                                    }
                                    lower.endsWith("global-metadata.dat") -> {
                                        val f = File(outDir, "global-metadata.dat")
                                        zip.getInputStream(e).use { it.copyTo(f.outputStream()) }
                                        metadata = f
                                    }
                                    lower.endsWith(".unity3d") || lower.endsWith(".assets") || lower.endsWith(".unitypackage") -> {
                                        unity3dFiles.pushString("$apk!$name")
                                    }
                                }
                            }
                        }
                    } catch (_: Exception) {}
                }

                val result = WritableNativeMap()
                result.putBoolean("hasMetadata", metadata != null)
                result.putBoolean("hasLib", lib != null)
                result.putString("metadataPath", metadata?.absolutePath ?: "")
                result.putString("libPath", lib?.absolutePath ?: "")
                result.putArray("unity3d", unity3dFiles)
                result.putBoolean("isUnity", metadata != null || unity3dFiles.size() > 0)
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("LOCATE_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // dumpIl2cpp — run the bundled il2cpp_dumper binary on the staged files
    // Output: <scratch>/<pkg>/il2cpp_dump/dump.cs etc.
    // ─────────────────────────────────────────────
    @ReactMethod
    fun dumpIl2cpp(pkg: String, promise: Promise) {
        Thread {
            try {
                val inDir = File(gameDir(pkg), "il2cpp")
                val lib = File(inDir, "libil2cpp.so")
                val meta = File(inDir, "global-metadata.dat")
                if (!lib.exists() || !meta.exists()) {
                    promise.reject("DUMP_ERROR", "libil2cpp.so/global-metadata.dat not found — run locate first")
                    return@Thread
                }

                // Extract the dumper binary from assets and make it executable
                val bin = File(ctx.filesDir, "il2cpp_dumper").apply {
                    if (!exists() || length() < 1024) {
                        ctx.assets.open("il2cpp_dumper-arm64").use { it.copyTo(outputStream()) }
                    }
                }
                Shell.cmd("chmod 755 '${bin.absolutePath}'").exec()

                val outDir = File(gameDir(pkg), "il2cpp_dump").apply {
                    deleteRecursively(); mkdirs()
                }

                val r = Shell.cmd(
                    "cd '${outDir.absolutePath}' && '${bin.absolutePath}' " +
                    "--binary '${lib.absolutePath}' --metadata '${meta.absolutePath}' " +
                    "--output '${outDir.absolutePath}' 2>&1"
                ).exec()

                // The dumper may write into a versioned subdirectory (e.g. Dump0/)
                // — search recursively for dump.cs.
                val dumpCs = outDir.walkTopDown().firstOrNull { it.isFile && it.name == "dump.cs" }
                val ok = dumpCs != null && dumpCs.exists() && dumpCs.length() > 0
                val result = WritableNativeMap()
                result.putBoolean("success", ok)
                result.putString("outputDir", dumpCs?.parent ?: outDir.absolutePath)
                result.putString("log", r.out.takeLast(40).joinToString("\n"))
                if (ok && dumpCs != null) {
                    result.putString("dumpCsSize", formatSize(dumpCs.length()))
                    result.putDouble("dumpCsBytes", dumpCs.length().toDouble())
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("DUMP_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // extractUnityAssets — run UnityPy (Chaquopy) on the staged APK(s)
    // Extracts MonoBehaviour + TextAsset (+ all raw). Output: <scratch>/<pkg>/assets/
    // ─────────────────────────────────────────────
    @ReactMethod
    fun extractUnityAssets(pkg: String, promise: Promise) {
        Thread {
            try {
                ensurePython(ctx)
                val dir = stageApks(pkg)
                val outDir = File(gameDir(pkg), "assets").apply {
                    deleteRecursively(); mkdirs()
                }

                val apks = (dir.listFiles() ?: emptyArray())
                    .filter { it.name.endsWith(".apk") }
                    .joinToString(";") { it.absolutePath }

                val py = Python.getInstance()
                val mod = py.getModule("extract_unity")
                val summary = mod.callAttr("extract", apks, outDir.absolutePath).toString()

                val result = WritableNativeMap()
                result.putBoolean("success", true)
                result.putString("outputDir", outDir.absolutePath)
                result.putString("summary", summary)
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("EXTRACT_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // listExtracted — list all files under <scratch>/<pkg> recursively
    // ─────────────────────────────────────────────
    @ReactMethod
    fun listExtracted(pkg: String, promise: Promise) {
        Thread {
            try {
                val root = gameDir(pkg)
                val arr = WritableNativeArray()
                root.walkTopDown().filter { it.isFile }.forEach { f ->
                    val map = WritableNativeMap()
                    map.putString("name", f.name)
                    map.putString("path", f.absolutePath)
                    map.putString("relative", f.relativeTo(root).path)
                    map.putString("size", formatSize(f.length()))
                    arr.pushMap(map)
                }
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("LIST_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // searchFiles — grep-like search inside extracted text files.
    // Returns matches: file + line number + line content (capped).
    // ─────────────────────────────────────────────
    @ReactMethod
    fun searchFiles(pkg: String, query: String, promise: Promise) {
        Thread {
            try {
                if (query.isBlank()) {
                    promise.resolve(WritableNativeArray())
                    return@Thread
                }
                val root = gameDir(pkg)
                val q = query.lowercase()
                val arr = WritableNativeArray()
                var fileCount = 0

                root.walkTopDown()
                    .filter { it.isFile && it.length() in 1..(20L * 1024 * 1024) }
                    .forEach { f ->
                        var matched = false
                        var lineNo = 0
                        var hits = 0
                        try {
                            f.bufferedReader().useLines { lines ->
                                for (line in lines) {
                                    lineNo++
                                    if (line.lowercase().contains(q)) {
                                        if (!matched) { matched = true; fileCount++ }
                                        if (hits < 20) {
                                            val map = WritableNativeMap()
                                            map.putString("file", f.relativeTo(root).path)
                                            map.putString("path", f.absolutePath)
                                            map.putInt("line", lineNo)
                                            map.putString("text", line.take(300))
                                            arr.pushMap(map)
                                        }
                                        hits++
                                    }
                                    if (fileCount > 200) return@useLines
                                }
                            }
                        } catch (_: Exception) { /* binary/unreadable file — skip */ }
                        if (fileCount > 200) return@forEach
                    }

                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("SEARCH_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // readFileRange — read `lineCount` lines starting at `startLine` (1-based).
    // Efficient for huge files (dump.cs) — never loads the whole file.
    // ─────────────────────────────────────────────
    @ReactMethod
    fun readFileRange(path: String, startLine: Int, lineCount: Int, promise: Promise) {
        Thread {
            try {
                val f = File(path)
                if (!f.exists()) throw Exception("File not found")
                val sb = StringBuilder()
                var cur = 0
                val end = startLine + lineCount
                f.bufferedReader().useLines { lines ->
                    val it = lines.iterator()
                    while (it.hasNext()) {
                        cur++
                        val line = it.next()
                        if (cur >= startLine) sb.append(line).append('\n')
                        if (cur >= end) break
                    }
                }
                val map = WritableNativeMap()
                map.putInt("startLine", startLine)
                map.putString("content", sb.toString())
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("READ_RANGE_ERROR", e.message)
            }
        }.start()
    }

    // ─────────────────────────────────────────────
    // File browser helpers (read-only + write for notes)
    // ─────────────────────────────────────────────
    @ReactMethod
    fun readDir(path: String, promise: Promise) {
        Thread {
            try {
                val dir = File(path)
                val arr = WritableNativeArray()
                val entries = if (dir.canRead()) {
                    dir.listFiles()?.toList()
                } else {
                    // root fallback
                    val r = Shell.cmd("ls -la '$path' 2>/dev/null").exec()
                    r.out.drop(2).mapNotNull { line ->
                        val parts = line.split(Regex("\\s+"))
                        if (parts.size < 8) return@mapNotNull null
                        val name = parts.drop(7).joinToString(" ")
                        if (name == "." || name == "..") return@mapNotNull null
                        File("$path/$name")
                    }
                }
                entries?.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))?.forEach { f ->
                    val map = WritableNativeMap()
                    map.putString("name", f.name)
                    map.putString("path", f.absolutePath)
                    map.putBoolean("isDir", f.isDirectory)
                    map.putString("size", if (f.isDirectory) "" else formatSize(f.length()))
                    arr.pushMap(map)
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
                val f = File(path)
                if (!f.exists()) throw Exception("File not found")
                val size = f.length()
                if (size > 512 * 1024) {
                    // head only for big files (e.g. dump.cs can be huge)
                    val head = f.bufferedReader().use { r ->
                        val buf = CharArray(64 * 1024)
                        val n = r.read(buf)
                        if (n > 0) String(buf, 0, n) else ""
                    }
                    promise.resolve("[Large file — ${formatSize(size)} — showing first 64KB]\n\n$head")
                } else {
                    val bytes = f.readBytes()
                    val isBinary = bytes.take(2048).any { it.toInt() == 0 }
                    if (isBinary) {
                        promise.resolve("[Binary file — ${formatSize(size)}]")
                    } else {
                        promise.resolve(String(bytes))
                    }
                }
            } catch (e: Exception) {
                promise.reject("READ_FILE_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun writeFile(path: String, content: String, promise: Promise) {
        Thread {
            try {
                File(path).writeText(content)
                promise.resolve("OK")
            } catch (e: Exception) {
                promise.reject("WRITE_FILE_ERROR", e.message)
            }
        }.start()
    }

    @ReactMethod
    fun getScratchRoot(promise: Promise) {
        promise.resolve(scratchRoot().absolutePath)
    }

    private fun formatSize(bytes: Long): String = when {
        bytes < 1024 -> "${bytes}B"
        bytes < 1024 * 1024 -> "${bytes / 1024}KB"
        else -> "${"%.1f".format(bytes / 1024.0 / 1024.0)}MB"
    }
}

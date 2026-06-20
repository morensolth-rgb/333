package com.fridactl

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.*
import com.topjohnwu.superuser.Shell
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * FloatingMemoryScanService — GameGuardian-style overlay.
 *
 * ★ Uses gg-mem native binary (ptrace + process_vm_readv/writev).
 *   Same technique as GameGuardian — ptrace ATTACH pauses target safely,
 *   then process_vm_readv reads memory without opening /proc/pid/mem directly.
 *   Zero Frida. Zero freeze. Works exactly like GG.
 *
 * Binary is bundled as assets/gg-mem-arm64, extracted to /data/data/.../gg-mem
 * on first use and given +x via root shell.
 */
class FloatingMemoryScanService : Service() {

    companion object {
        const val ACTION_SHOW = "com.fridactl.FMEM_SHOW"
        const val ACTION_HIDE = "com.fridactl.FMEM_HIDE"
        const val EXTRA_PKG   = "pkg"

        var instance: FloatingMemoryScanService? = null

        private const val GREEN  = "#00ff88"
        private const val BG     = "#E00d0d0d"
        private const val CARD   = "#CC111111"
        private const val DIM    = "#666666"
        private const val YELLOW = "#FFD700"
        private const val RED    = "#ff4444"
        private const val BORDER = "#1a3a2a"

        private const val MAX_RESULTS = 500
        private const val BINARY_NAME = "gg-mem-arm64"
    }

    // ─── State ────────────────────────────────────────────────────────────────
    private var wm: WindowManager? = null
    private var rootView: LinearLayout? = null
    private var visible = false

    private var initX = 0; private var initY = 0
    private var initTouchX = 0f; private var initTouchY = 0f

    private var targetPkg = ""
    private var targetPid = ""
    private var scanType  = "int32"   // int32 | int64 | float | double
    private var scanMode  = "exact"   // exact | changed | increased | decreased | unknown
    private var scanCount = 0

    data class ScanResult(val addr: Long, var value: String, var frozen: Boolean = false)
    data class FreezeJob(val addr: Long, val type: String, val value: String, @Volatile var active: Boolean = true)

    private val results    = mutableListOf<ScanResult>()
    private val frozenJobs = mutableMapOf<Long, FreezeJob>()

    // UI refs
    private var pkgLabel:      TextView?     = null
    private var scanValueEt:   EditText?     = null
    private var editValueEt:   EditText?     = null
    private var logTv:         TextView?     = null
    private var resultsLayout: LinearLayout? = null
    private var actionPanel:   LinearLayout? = null
    private var selectedAddr:  Long?         = null
    private var typeChips:     MutableMap<String, TextView> = mutableMapOf()
    private var modeChips:     MutableMap<String, TextView> = mutableMapOf()
    private var searchBtn:     TextView?     = null
    private var scanCountTv:   TextView?     = null
    private val mainHandler    = Handler(Looper.getMainLooper())

    // Path to extracted binary
    private var ggMemPath: String = ""

    // ─── Service lifecycle ────────────────────────────────────────────────────
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        ggMemPath = extractBinary()
        buildView()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SHOW -> {
                val pkg = intent.getStringExtra(EXTRA_PKG) ?: ""
                if (pkg.isNotBlank()) {
                    targetPkg = pkg
                    pkgLabel?.text = "📦 $pkg"
                }
                Thread { resolvePid() }.start()
                showOverlay()
            }
            ACTION_HIDE -> hideOverlay()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopAllFreezes()
        hideOverlay()
        instance = null
        super.onDestroy()
    }

    // ─── Binary extraction ────────────────────────────────────────────────────
    /**
     * Extract gg-mem-arm64 from assets to app's private dir.
     * Then chmod +x via root so it can run as root subprocess.
     */
    private fun extractBinary(): String {
        val outFile = File(filesDir, "gg-mem")
        try {
            assets.open(BINARY_NAME).use { input ->
                FileOutputStream(outFile).use { output ->
                    input.copyTo(output)
                }
            }
            // Make executable via root
            Shell.cmd("chmod 755 ${outFile.absolutePath}").exec()
        } catch (e: Exception) {
            // Binary missing — fallback will be caught at scan time
        }
        return outFile.absolutePath
    }

    // ─── PID resolution ───────────────────────────────────────────────────────
    private fun resolvePid(): String {
        if (targetPid.isNotBlank() && targetPid.all { it.isDigit() }) return targetPid
        if (targetPkg.isBlank()) return ""
        val out = Shell.cmd("pidof '${targetPkg}' 2>/dev/null | tr ' ' '\\n' | head -1").exec()
            .out.firstOrNull()?.trim() ?: ""
        if (out.isNotBlank()) {
            targetPid = out
            mainHandler.post { log("PID: $out") }
        } else {
            mainHandler.post { log("✗ Process not found — launch game first") }
        }
        return out
    }

    // ─── gg-mem runner ────────────────────────────────────────────────────────
    /**
     * Run gg-mem command as root via libsu.
     * Returns list of output lines.
     */
    private fun runGgMem(vararg args: String): List<String> {
        if (ggMemPath.isEmpty() || !File(ggMemPath).exists()) {
            // Try re-extracting
            ggMemPath = extractBinary()
            if (!File(ggMemPath).exists()) {
                mainHandler.post { log("✗ gg-mem binary not found — rebuild the app") }
                return emptyList()
            }
        }
        val cmd = "$ggMemPath ${args.joinToString(" ")}"
        val result = Shell.cmd(cmd).exec()
        return result.out
    }

    // ─── SCAN ─────────────────────────────────────────────────────────────────
    private fun doFirstScan(value: String) {
        val pid = resolvePid()
        if (pid.isEmpty()) { mainHandler.post { setBusy(false) }; return }

        mainHandler.post { log("⏳ Scanning…") }

        val lines = runGgMem("scan", pid, scanType, shellEscape(value))
        val found = mutableListOf<ScanResult>()

        for (line in lines) {
            if (line.startsWith("DONE")) break
            // Format: "0xADDR VALUE"
            val parts = line.trim().split(" ")
            if (parts.size >= 2) {
                val addr = parts[0].removePrefix("0x").toLongOrNull(16) ?: continue
                found.add(ScanResult(addr, parts[1]))
                if (found.size >= MAX_RESULTS) break
            }
        }

        mainHandler.post {
            results.clear()
            results.addAll(found)
            scanCount = 1
            renderResults()
            updateScanCount()
            log(if (found.isEmpty()) "⚠ 0 results — value not found" else "✓ Found ${found.size} addresses")
            setBusy(false)
        }
    }

    private fun doNextScan(value: String) {
        val pid = resolvePid()
        if (pid.isEmpty()) { mainHandler.post { setBusy(false) }; return }

        mainHandler.post { log("⏳ Next scan (${results.size} addrs)…") }

        // Build CSV of addresses to rescan
        val addrCsv = results.take(MAX_RESULTS).joinToString(",") {
            "0x${it.addr.toString(16)}"
        }

        val lines = runGgMem("rescan", pid, scanType, addrCsv)

        // Build map of addr → current value from output
        val currentMap = mutableMapOf<Long, String>()
        for (line in lines) {
            if (line.startsWith("DONE")) break
            val parts = line.trim().split(" ")
            if (parts.size >= 2) {
                val addr = parts[0].removePrefix("0x").toLongOrNull(16) ?: continue
                currentMap[addr] = parts[1]
            }
        }

        val filtered = mutableListOf<ScanResult>()
        for (res in results.toList()) {
            val current = currentMap[res.addr] ?: continue
            val currentNum = current.toDoubleOrNull()
            val prevNum    = res.value.toDoubleOrNull()

            val pass = when (scanMode) {
                "exact"     -> current == value
                "changed"   -> current != res.value
                "increased" -> currentNum != null && prevNum != null && currentNum > prevNum
                "decreased" -> currentNum != null && prevNum != null && currentNum < prevNum
                "unknown"   -> true
                else        -> current == value
            }
            if (pass) filtered.add(res.copy(value = current))
        }

        mainHandler.post {
            results.clear()
            results.addAll(filtered)
            scanCount++
            renderResults()
            updateScanCount()
            log(if (filtered.isEmpty()) "⚠ 0 results — try different value/mode" else "✓ Narrowed to ${filtered.size}")
            setBusy(false)
        }
    }

    // ─── WRITE ────────────────────────────────────────────────────────────────
    private fun writeValue(pid: String, addr: Long, value: String) {
        val addrHex = "0x${addr.toString(16)}"
        val lines   = runGgMem("write", pid, scanType, addrHex, shellEscape(value))
        val ok      = lines.any { it.startsWith("OK") }
        mainHandler.post {
            if (ok) {
                results.find { it.addr == addr }?.value = value
                renderResults()
                log("✓ Written $value → $addrHex")
            } else {
                log("✗ Write failed — address may have moved")
            }
        }
    }

    // ─── FREEZE: background thread writes every 100ms via gg-mem ─────────────
    private fun startFreeze(addr: Long, value: String) {
        stopFreeze(addr)

        val job = FreezeJob(addr, scanType, value, active = true)
        frozenJobs[addr] = job

        Thread {
            val pid = resolvePid()
            if (pid.isEmpty()) {
                mainHandler.post { log("✗ Cannot freeze — process not found") }
                return@Thread
            }

            // Verify address is readable
            val addrHex = "0x${addr.toString(16)}"
            val check = runGgMem("read", pid, scanType, addrHex)
            if (check.isEmpty() || check.all { it.isBlank() }) {
                mainHandler.post { log("✗ Address $addrHex not readable") }
                frozenJobs.remove(addr)
                return@Thread
            }

            mainHandler.post {
                results.find { it.addr == addr }?.frozen = true
                renderResults()
                updateFreezeBtn(true)
                log("❄ Frozen $addrHex = $value")
            }

            while (job.active) {
                runGgMem("write", pid, scanType, addrHex, value)
                try { Thread.sleep(100) } catch (_: InterruptedException) { break }
            }

            mainHandler.post { log("● Unfrozen $addrHex") }
        }.start()
    }

    private fun stopFreeze(addr: Long) {
        frozenJobs[addr]?.active = false
        frozenJobs.remove(addr)
        results.find { it.addr == addr }?.frozen = false
        mainHandler.post { renderResults(); updateFreezeBtn(false) }
    }

    private fun stopAllFreezes() {
        frozenJobs.values.forEach { it.active = false }
        frozenJobs.clear()
    }

    // ─── Shell escape ─────────────────────────────────────────────────────────
    private fun shellEscape(s: String): String {
        // Wrap in single quotes, escape any ' inside
        return "'${s.replace("'", "'\\''")}'"
    }

    // ─── UI BUILD ──────────────────────────────────────────────────────────────
    @SuppressLint("ClickableViewAccessibility")
    private fun buildView() {
        rootView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#E00d0d0d"))
            setPadding(0, 0, 0, 0)
        }

        val titleBar = makeTitleBar()
        rootView!!.addView(titleBar)

        pkgLabel = TextView(this).apply {
            text = "📦 No package set"
            setTextColor(Color.parseColor(DIM))
            textSize = 10f
            typeface = Typeface.MONOSPACE
            setPadding(10, 6, 10, 6)
            setBackgroundColor(Color.parseColor("#CC0a0a0a"))
        }
        rootView!!.addView(pkgLabel)

        rootView!!.addView(makeTypeRow())
        rootView!!.addView(makeModeRow())
        rootView!!.addView(makeInputRow())
        rootView!!.addView(makeScanInfoRow())

        val scrollView = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            setBackgroundColor(Color.parseColor("#CC080808"))
        }
        resultsLayout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scrollView.addView(resultsLayout)
        rootView!!.addView(scrollView)

        actionPanel = makeActionPanel()
        actionPanel!!.visibility = View.GONE
        rootView!!.addView(actionPanel)

        logTv = TextView(this).apply {
            text = "[ GG-Mem engine ready ]"
            setTextColor(Color.parseColor(DIM))
            textSize = 9f
            typeface = Typeface.MONOSPACE
            setPadding(10, 4, 10, 6)
            setBackgroundColor(Color.parseColor("#CC050505"))
        }
        rootView!!.addView(logTv)

        titleBar.setOnTouchListener { _, ev ->
            val lp = rootView!!.layoutParams as? WindowManager.LayoutParams ?: return@setOnTouchListener false
            when (ev.action) {
                MotionEvent.ACTION_DOWN -> {
                    initX = lp.x; initY = lp.y
                    initTouchX = ev.rawX; initTouchY = ev.rawY
                }
                MotionEvent.ACTION_MOVE -> {
                    lp.x = initX + (ev.rawX - initTouchX).toInt()
                    lp.y = initY + (ev.rawY - initTouchY).toInt()
                    if (visible) wm?.updateViewLayout(rootView, lp)
                }
            }
            true
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun makeTitleBar(): LinearLayout {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#CC003322"))
            setPadding(10, 8, 8, 8)
        }
        val title = TextView(this).apply {
            text = "🧠 Memory Scanner"
            setTextColor(Color.parseColor(GREEN))
            textSize = 12f
            typeface = Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val closeBtn = TextView(this).apply {
            text = "  ✕  "
            setTextColor(Color.parseColor(RED))
            textSize = 14f
            typeface = Typeface.MONOSPACE
            setOnClickListener { hideOverlay() }
        }
        bar.addView(title)
        bar.addView(closeBtn)
        return bar
    }

    private fun makeTypeRow(): HorizontalScrollView {
        val scroll = HorizontalScrollView(this).apply { setPadding(6, 6, 6, 0) }
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val types = listOf("int32" to "Dword", "float" to "Float", "double" to "Double", "int64" to "Qword")
        for ((val_, lbl) in types) {
            val chip = makeChip(lbl, val_ == scanType)
            chip.setOnClickListener {
                scanType = val_
                typeChips.values.forEach { resetChip(it) }
                activateChip(chip)
            }
            typeChips[val_] = chip
            row.addView(chip)
        }
        scroll.addView(row)
        return scroll
    }

    private fun makeModeRow(): HorizontalScrollView {
        val scroll = HorizontalScrollView(this).apply { setPadding(6, 4, 6, 4) }
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val modes = listOf(
            "exact"     to "= Exact",
            "changed"   to "≠ Changed",
            "increased" to "↑ Up",
            "decreased" to "↓ Down",
            "unknown"   to "? Any"
        )
        for ((val_, lbl) in modes) {
            val chip = makeChip(lbl, val_ == scanMode)
            chip.setOnClickListener {
                scanMode = val_
                modeChips.values.forEach { resetChip(it) }
                activateChip(chip)
            }
            modeChips[val_] = chip
            row.addView(chip)
        }
        scroll.addView(row)
        return scroll
    }

    private fun makeInputRow(): LinearLayout {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(8, 0, 8, 6) }
        scanValueEt = EditText(this).apply {
            hint = "Value to scan"
            setHintTextColor(Color.parseColor(DIM))
            setTextColor(Color.WHITE)
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC1a1a1a"))
            setPadding(10, 8, 10, 8)
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = 6 }
        }
        searchBtn = TextView(this).apply {
            text = "🔍 SCAN"
            setTextColor(Color.parseColor(GREEN))
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC001a0d"))
            setPadding(14, 10, 14, 10)
            setOnClickListener { onScanClicked() }
        }
        row.addView(scanValueEt)
        row.addView(searchBtn!!)
        return row
    }

    private fun makeScanInfoRow(): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(10, 0, 8, 6)
            gravity = Gravity.CENTER_VERTICAL
        }
        scanCountTv = TextView(this).apply {
            text = ""
            setTextColor(Color.parseColor(DIM))
            textSize = 9.5f
            typeface = Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val newBtn = TextView(this).apply {
            text = "NEW"
            setTextColor(Color.parseColor(DIM))
            textSize = 10f
            typeface = Typeface.MONOSPACE
            setPadding(10, 6, 10, 6)
            setOnClickListener { resetScan() }
        }
        row.addView(scanCountTv)
        row.addView(newBtn)
        return row
    }

    private fun makeActionPanel(): LinearLayout {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#CC0a0a0a"))
            setPadding(10, 8, 10, 8)
        }
        val addrTv = TextView(this).apply {
            tag = "addrTv"; text = "▶ ─"
            setTextColor(Color.parseColor(GREEN))
            textSize = 10f; typeface = Typeface.MONOSPACE
        }
        editValueEt = EditText(this).apply {
            hint = "New value"; setHintTextColor(Color.parseColor(DIM))
            setTextColor(Color.WHITE); textSize = 12f; typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC1a1a1a")); setPadding(8, 6, 8, 6)
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
        }
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 6 }
        }
        val writeBtn = TextView(this).apply {
            text = "WRITE"; setTextColor(Color.parseColor(GREEN)); textSize = 11f; typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC001a0d")); setPadding(12, 8, 12, 8); gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = 4 }
            setOnClickListener { doWrite() }
        }
        val freezeBtn = TextView(this).apply {
            tag = "freezeBtn"; text = "❄ FREEZE"; setTextColor(Color.parseColor(YELLOW))
            textSize = 11f; typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC1a1400")); setPadding(12, 8, 12, 8); gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = 4 }
            setOnClickListener { doToggleFreeze() }
        }
        val closeBtn = TextView(this).apply {
            text = "✕"; setTextColor(Color.parseColor(DIM)); textSize = 13f; typeface = Typeface.MONOSPACE
            setPadding(12, 8, 10, 8)
            setOnClickListener { selectedAddr = null; actionPanel?.visibility = View.GONE }
        }
        btnRow.addView(writeBtn); btnRow.addView(freezeBtn); btnRow.addView(closeBtn)
        panel.addView(addrTv); panel.addView(editValueEt!!); panel.addView(btnRow)
        return panel
    }

    // ─── Chip helpers ─────────────────────────────────────────────────────────
    private fun makeChip(label: String, active: Boolean) = TextView(this).apply {
        text = label; textSize = 10f; typeface = Typeface.MONOSPACE; setPadding(12, 6, 12, 6)
        setTextColor(Color.parseColor(if (active) GREEN else DIM))
        setBackgroundColor(Color.parseColor(if (active) "#CC001a0d" else "#CC111111"))
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginEnd = 4 }
    }
    private fun resetChip(tv: TextView)    { tv.setTextColor(Color.parseColor(DIM));   tv.setBackgroundColor(Color.parseColor("#CC111111")) }
    private fun activateChip(tv: TextView) { tv.setTextColor(Color.parseColor(GREEN)); tv.setBackgroundColor(Color.parseColor("#CC001a0d")) }

    // ─── Window management ────────────────────────────────────────────────────
    private fun makeLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        return WindowManager.LayoutParams(
            560, 680, type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START; x = 20; y = 80 }
    }

    fun showOverlay() {
        mainHandler.post {
            if (visible) return@post
            try { wm?.addView(rootView, makeLayoutParams()); visible = true } catch (e: Exception) { e.printStackTrace() }
        }
    }

    fun hideOverlay() {
        mainHandler.post {
            if (!visible) return@post
            try { wm?.removeView(rootView) } catch (_: Exception) {}
            visible = false
        }
    }

    // ─── Scan trigger ─────────────────────────────────────────────────────────
    private fun onScanClicked() {
        val value = scanValueEt?.text?.toString()?.trim() ?: ""
        if (value.isEmpty() && scanMode == "exact") { log("✗ Enter a value first"); return }
        setBusy(true)
        if (scanCount == 0) Thread { doFirstScan(value) }.start()
        else Thread { doNextScan(value) }.start()
    }

    // ─── Write ────────────────────────────────────────────────────────────────
    private fun doWrite() {
        val addr  = selectedAddr ?: return
        val value = editValueEt?.text?.toString()?.trim() ?: return
        if (value.isEmpty()) { log("✗ Enter value to write"); return }
        setBusy(true)
        Thread {
            val pid = resolvePid()
            if (pid.isEmpty()) { mainHandler.post { log("✗ Process not found"); setBusy(false) }; return@Thread }
            writeValue(pid, addr, value)
            mainHandler.post { setBusy(false) }
        }.start()
    }

    // ─── Freeze toggle ────────────────────────────────────────────────────────
    private fun doToggleFreeze() {
        val addr = selectedAddr ?: return
        if (frozenJobs.containsKey(addr)) {
            stopFreeze(addr)
        } else {
            val value = editValueEt?.text?.toString()?.trim() ?: ""
            if (value.isEmpty()) { log("✗ Enter value to freeze at"); return }
            startFreeze(addr, value)
        }
    }

    // ─── Render results ───────────────────────────────────────────────────────
    @SuppressLint("ClickableViewAccessibility")
    private fun renderResults() {
        val layout = resultsLayout ?: return
        layout.removeAllViews()
        if (results.isEmpty()) {
            val empty = TextView(this).apply {
                text = if (scanCount == 0) "Enter a value and press SCAN" else "No addresses — try next scan"
                setTextColor(Color.parseColor(DIM)); textSize = 11f; typeface = Typeface.MONOSPACE
                gravity = Gravity.CENTER; setPadding(0, 30, 0, 0)
            }
            layout.addView(empty); return
        }
        for (res in results.take(100)) {
            val addrHex = "0x${res.addr.toString(16)}"
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; setPadding(10, 8, 10, 8)
                setBackgroundColor(if (res.addr == selectedAddr) Color.parseColor("#CC0a1f12") else Color.TRANSPARENT)
            }
            val dot = View(this).apply {
                layoutParams = LinearLayout.LayoutParams(8, 8).apply { gravity = Gravity.CENTER_VERTICAL; marginEnd = 8; topMargin = 2 }
                setBackgroundColor(Color.parseColor(if (res.frozen) YELLOW else if (res.addr == selectedAddr) GREEN else DIM))
            }
            val addrTv = TextView(this).apply {
                text = addrHex; setTextColor(Color.parseColor(GREEN))
                textSize = 10f; typeface = Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.4f)
            }
            val valTv = TextView(this).apply {
                text = res.value; setTextColor(Color.WHITE)
                textSize = 11f; typeface = Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            val frzTv = TextView(this).apply {
                text = if (res.frozen) "❄" else ""
                setTextColor(Color.parseColor(YELLOW)); textSize = 11f; typeface = Typeface.MONOSPACE; setPadding(4, 0, 0, 0)
            }
            row.addView(dot); row.addView(addrTv); row.addView(valTv); row.addView(frzTv)
            row.setOnClickListener {
                selectedAddr = if (selectedAddr == res.addr) null else res.addr
                renderResults()
                if (selectedAddr != null) showActionPanel(res) else actionPanel?.visibility = View.GONE
            }
            layout.addView(row)
            layout.addView(View(this).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1)
                setBackgroundColor(Color.parseColor(BORDER))
            })
        }
        if (results.size > 100) {
            layout.addView(TextView(this).apply {
                text = "  … +${results.size - 100} more (narrow with NEXT SCAN)"
                setTextColor(Color.parseColor(DIM)); textSize = 9f; typeface = Typeface.MONOSPACE; setPadding(10, 6, 10, 6)
            })
        }
    }

    private fun showActionPanel(res: ScanResult) {
        val panel = actionPanel ?: return
        panel.visibility = View.VISIBLE
        panel.findViewWithTag<TextView?>("addrTv")?.text = "▶ 0x${res.addr.toString(16)}  |  val: ${res.value}"
        editValueEt?.setText(res.value)
        updateFreezeBtn(res.frozen)
    }

    private fun updateFreezeBtn(frozen: Boolean) {
        val btn = actionPanel?.findViewWithTag<TextView?>("freezeBtn") ?: return
        if (frozen) {
            btn.text = "● UNFRZ"; btn.setTextColor(Color.parseColor(DIM))
            btn.setBackgroundColor(Color.parseColor("#CC1a1a1a"))
        } else {
            btn.text = "❄ FREEZE"; btn.setTextColor(Color.parseColor(YELLOW))
            btn.setBackgroundColor(Color.parseColor("#CC1a1400"))
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    private fun resetScan() {
        results.clear(); scanCount = 0; selectedAddr = null; stopAllFreezes()
        mainHandler.post {
            renderResults(); updateScanCount()
            actionPanel?.visibility = View.GONE
            scanValueEt?.setText("")
            log("── Scan reset ──")
        }
    }

    private fun updateScanCount() {
        scanCountTv?.text = if (scanCount > 0) "Scan #$scanCount · ${results.size} addr" else ""
        searchBtn?.text = if (scanCount == 0) "🔍 SCAN" else "🔍 NEXT (${results.size})"
    }

    private fun setBusy(busy: Boolean) {
        mainHandler.post {
            searchBtn?.isEnabled = !busy
            searchBtn?.setTextColor(Color.parseColor(if (busy) DIM else GREEN))
        }
    }

    private fun log(msg: String) {
        mainHandler.post {
            logTv?.text = msg
            logTv?.setTextColor(Color.parseColor(when {
                msg.startsWith("✗") -> RED
                msg.startsWith("✓") || msg.startsWith("❄") -> GREEN
                else -> DIM
            }))
        }
    }
}

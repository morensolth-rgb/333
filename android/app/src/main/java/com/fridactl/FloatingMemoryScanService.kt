package com.fridactl

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.*
import com.topjohnwu.superuser.Shell

/**
 * FloatingMemoryScanService — GameGuardian-style overlay for memory scanning.
 * Floats above running games. Allows scanning /proc/pid/mem for int32/float/string values,
 * editing matched addresses, and freezing values — all while the game runs in the background.
 *
 * Requires SYSTEM_ALERT_WINDOW (already granted in AndroidManifest).
 */
class FloatingMemoryScanService : Service() {

    companion object {
        const val ACTION_SHOW   = "com.fridactl.MEMSCAN_SHOW"
        const val ACTION_HIDE   = "com.fridactl.MEMSCAN_HIDE"
        const val EXTRA_PKG     = "pkg"

        var instance: FloatingMemoryScanService? = null

        data class MemHit(val addr: String, var value: String, val region: String)
    }

    private var wm: WindowManager? = null
    private var rootView: LinearLayout? = null
    private var visible = false
    private val handler = Handler(Looper.getMainLooper())

    // UI refs
    private var tvStatus: TextView? = null
    private var etPkg: EditText? = null
    private var etValue: EditText? = null
    private var rgType: RadioGroup? = null
    private var resultsContainer: LinearLayout? = null
    private var scrollResults: ScrollView? = null

    // State
    private var currentPkg: String = ""
    private var currentPid: String = ""
    private var scanType: String = "int32"  // int32 / float / string
    private var hits: MutableList<MemHit> = mutableListOf()
    private val frozenAddrs: MutableMap<String, String> = mutableMapOf()  // addr → value
    private var freezeRunnable: Runnable? = null

    // Drag
    private var initX = 0; private var initY = 0
    private var initTouchX = 0f; private var initTouchY = 0f

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        buildView()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SHOW -> {
                val pkg = intent.getStringExtra(EXTRA_PKG) ?: ""
                if (pkg.isNotBlank()) {
                    currentPkg = pkg
                    handler.post { etPkg?.setText(pkg) }
                }
                showOverlay()
            }
            ACTION_HIDE -> hideOverlay()
        }
        return START_NOT_STICKY
    }

    // ─────────────────────────── BUILD VIEW ────────────────────────────────────

    private fun buildView() {
        rootView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F0080808"))
            setPadding(0, 0, 0, 0)
        }

        // ── Title bar (draggable) ──────────────────────────────────────────────
        val titleBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#CC00ff88"))
            setPadding(10, 6, 10, 6)
        }
        val tvTitle = TextView(this).apply {
            text = "🧠 MemScan"
            setTextColor(Color.BLACK)
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val btnClose = TextView(this).apply {
            text = "✕"
            setTextColor(Color.BLACK)
            textSize = 14f
            setPadding(14, 0, 6, 0)
            setOnClickListener { hideOverlay() }
        }
        titleBar.addView(tvTitle)
        titleBar.addView(btnClose)

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

        // ── Body ──────────────────────────────────────────────────────────────
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(10, 8, 10, 8)
        }

        // Package input
        val tvPkgLabel = TextView(this).apply {
            text = "PACKAGE"
            setTextColor(Color.parseColor("#00ff88"))
            textSize = 9f
            typeface = android.graphics.Typeface.MONOSPACE
        }
        etPkg = EditText(this).apply {
            hint = "com.game.package"
            setHintTextColor(Color.parseColor("#444444"))
            setTextColor(Color.WHITE)
            textSize = 10f
            typeface = android.graphics.Typeface.MONOSPACE
            background = null
            setPadding(0, 2, 0, 4)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(true)
            if (currentPkg.isNotBlank()) setText(currentPkg)
        }

        // Type selector
        val tvTypeLabel = TextView(this).apply {
            text = "TYPE"
            setTextColor(Color.parseColor("#00ff88"))
            textSize = 9f
            typeface = android.graphics.Typeface.MONOSPACE
        }
        rgType = RadioGroup(this).apply {
            orientation = RadioGroup.HORIZONTAL
        }
        listOf("int32", "float", "string").forEachIndexed { i, t ->
            val rb = RadioButton(this).apply {
                text = t
                setTextColor(Color.parseColor("#cccccc"))
                textSize = 9.5f
                typeface = android.graphics.Typeface.MONOSPACE
                isChecked = (i == 0)
                setOnClickListener { scanType = t }
                setPadding(0, 0, 16, 0)
            }
            rgType!!.addView(rb)
        }

        // Value input
        val tvValLabel = TextView(this).apply {
            text = "VALUE"
            setTextColor(Color.parseColor("#00ff88"))
            textSize = 9f
            typeface = android.graphics.Typeface.MONOSPACE
        }
        etValue = EditText(this).apply {
            hint = "e.g. 1000"
            setHintTextColor(Color.parseColor("#444444"))
            setTextColor(Color.WHITE)
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            background = null
            setPadding(0, 2, 0, 4)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(true)
        }

        // Status
        tvStatus = TextView(this).apply {
            text = "Ready"
            setTextColor(Color.parseColor("#888888"))
            textSize = 9f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(0, 2, 0, 2)
        }

        // Scan / Next buttons
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 4, 0, 4)
        }
        val btnScan = makeButton("SCAN") { doScan(false) }
        val btnNext = makeButton("NEXT SCAN") { doScan(true) }
        val btnClear = makeButton("CLR") { clearResults() }
        btnRow.addView(btnScan)
        btnRow.addView(space(6))
        btnRow.addView(btnNext)
        btnRow.addView(space(6))
        btnRow.addView(btnClear)

        // Divider
        val divider = android.view.View(this).apply {
            setBackgroundColor(Color.parseColor("#1a1a1a"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1)
        }

        // Results scroll
        scrollResults = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                220
            )
        }
        resultsContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 4, 0, 4)
        }
        scrollResults!!.addView(resultsContainer)

        body.addView(tvPkgLabel)
        body.addView(etPkg)
        body.addView(tvTypeLabel)
        body.addView(rgType)
        body.addView(tvValLabel)
        body.addView(etValue)
        body.addView(tvStatus)
        body.addView(btnRow)
        body.addView(divider)
        body.addView(scrollResults)

        rootView!!.addView(titleBar)
        rootView!!.addView(body)
    }

    private fun makeButton(label: String, onClick: () -> Unit): TextView {
        return TextView(this).apply {
            text = label
            setTextColor(Color.parseColor("#00ff88"))
            textSize = 9.5f
            typeface = android.graphics.Typeface.MONOSPACE
            background = android.graphics.drawable.GradientDrawable().apply {
                setStroke(1, Color.parseColor("#00ff88"))
                cornerRadius = 3f
                setColor(Color.TRANSPARENT)
            }
            setPadding(10, 5, 10, 5)
            setOnClickListener { onClick() }
        }
    }

    private fun space(dp: Int): android.view.View {
        return android.view.View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp, 1)
        }
    }

    // ─────────────────────────── SCAN LOGIC ────────────────────────────────────

    private fun doScan(narrowDown: Boolean) {
        val pkg = etPkg?.text?.toString()?.trim() ?: ""
        val value = etValue?.text?.toString()?.trim() ?: ""
        if (pkg.isEmpty()) { setStatus("Enter package name"); return }
        if (value.isEmpty()) { setStatus("Enter value to search"); return }

        currentPkg = pkg
        setStatus("Resolving PID...")

        Thread {
            try {
                // Resolve PID
                val pidOut = Shell.cmd("pidof '$pkg' 2>/dev/null | tr ' ' '\\n' | head -1").exec()
                    .out.firstOrNull()?.trim() ?: ""
                if (pidOut.isEmpty() || !pidOut.all { it.isDigit() }) {
                    setStatus("Process not running: $pkg"); return@Thread
                }
                currentPid = pidOut
                setStatus("Scanning PID $pidOut...")

                val newHits = mutableListOf<MemHit>()

                if (scanType == "string") {
                    // String scan via dd + grep over heap regions
                    val mapsOut = Shell.cmd(
                        "cat /proc/$pidOut/maps 2>/dev/null | grep -E 'heap|\\[anon\\]' | head -20"
                    ).exec().out
                    for (line in mapsOut) {
                        if (line.isBlank()) continue
                        val range = line.split("\\s+".toRegex()).firstOrNull() ?: continue
                        val parts = range.split("-")
                        if (parts.size != 2) continue
                        val startHex = parts[0]; val endHex = parts[1]
                        try {
                            val startDec = startHex.toLong(16)
                            val endDec = endHex.toLong(16)
                            val size = endDec - startDec
                            if (size <= 0 || size > 20 * 1024 * 1024) continue
                            val grepOut = Shell.cmd(
                                "dd if=/proc/$pidOut/mem bs=1 skip=$startDec count=$size 2>/dev/null | " +
                                "strings 2>/dev/null | grep -i '${value}' | head -5"
                            ).exec().out
                            for (match in grepOut) {
                                if (match.isNotBlank()) {
                                    newHits.add(MemHit(startHex, match.trim(), "[string in heap]"))
                                }
                            }
                        } catch (_: Exception) {}
                    }
                } else {
                    // int32 / float scan via Frida-generated script (we generate and inject via shell)
                    val numVal = if (scanType == "int32") value.toIntOrNull() ?: 0
                                 else value.toFloatOrNull() ?: 0f
                    // Use /proc/pid/mem + known writable regions
                    val mapsOut = Shell.cmd(
                        "cat /proc/$pidOut/maps 2>/dev/null | grep 'rw' | " +
                        "grep -v -E 'vvar|vdso|vsyscall' | head -40"
                    ).exec().out

                    for (line in mapsOut) {
                        if (line.isBlank()) continue
                        val cols = line.split("\\s+".toRegex())
                        val range = cols.firstOrNull() ?: continue
                        val parts = range.split("-")
                        if (parts.size != 2) continue
                        try {
                            val startDec = parts[0].toLong(16)
                            val endDec   = parts[1].toLong(16)
                            val size = endDec - startDec
                            if (size <= 0 || size > 10 * 1024 * 1024) continue
                            val regionName = cols.lastOrNull() ?: "[anon]"

                            // Use xxd/hexdump to read binary and grep for byte pattern
                            val bytePattern = if (scanType == "int32") {
                                val v = numVal as Int
                                // little-endian 4 bytes
                                "%02x%02x%02x%02x".format(
                                    v and 0xFF, (v shr 8) and 0xFF,
                                    (v shr 16) and 0xFF, (v shr 24) and 0xFF
                                )
                            } else {
                                // float to little-endian IEEE 754
                                val bits = java.lang.Float.floatToRawIntBits(numVal as Float)
                                "%02x%02x%02x%02x".format(
                                    bits and 0xFF, (bits shr 8) and 0xFF,
                                    (bits shr 16) and 0xFF, (bits shr 24) and 0xFF
                                )
                            }

                            // xxd output: address: bytes  ascii
                            val hexOut = Shell.cmd(
                                "dd if=/proc/$pidOut/mem bs=1 skip=$startDec count=$size 2>/dev/null | " +
                                "xxd 2>/dev/null | grep '$bytePattern' | head -10"
                            ).exec().out

                            for (matchLine in hexOut) {
                                if (matchLine.isBlank()) continue
                                // xxd gives offset in the dump, not real address
                                val offsetHex = matchLine.split(":").firstOrNull()?.trim() ?: continue
                                val offset = try { offsetHex.toLong(16) } catch (_: Exception) { 0L }
                                val realAddr = (startDec + offset).toString(16)
                                if (narrowDown) {
                                    if (hits.any { it.addr == realAddr }) {
                                        newHits.add(MemHit(realAddr, value, regionName))
                                    }
                                } else {
                                    newHits.add(MemHit(realAddr, value, regionName))
                                }
                                if (newHits.size >= 50) break
                            }
                        } catch (_: Exception) {}
                        if (newHits.size >= 50) break
                    }
                }

                hits = newHits
                val count = newHits.size
                setStatus("Found $count match${if (count == 1) "" else "es"}")
                handler.post { renderResults() }

            } catch (e: Exception) {
                setStatus("Error: ${e.message}")
            }
        }.start()
    }

    private fun clearResults() {
        hits.clear()
        frozenAddrs.clear()
        freezeRunnable?.let { handler.removeCallbacks(it) }
        handler.post { resultsContainer?.removeAllViews(); setStatus("Cleared") }
    }

    private fun renderResults() {
        resultsContainer?.removeAllViews()
        if (hits.isEmpty()) return

        for (hit in hits.take(30)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 3, 0, 3)
            }

            val tvAddr = TextView(this).apply {
                text = "0x${hit.addr}"
                setTextColor(Color.parseColor("#00ff88"))
                textSize = 9f
                typeface = android.graphics.Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f)
            }
            val tvVal = TextView(this).apply {
                text = hit.value
                setTextColor(Color.parseColor("#ffcc00"))
                textSize = 9f
                typeface = android.graphics.Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 0.8f)
            }
            val btnEdit = makeSmallBtn("EDIT") { showEditDialog(hit) }
            val isFrozen = frozenAddrs.containsKey(hit.addr)
            val btnFreeze = makeSmallBtn(if (isFrozen) "UNFRZ" else "FRZ",
                if (isFrozen) Color.parseColor("#ff4444") else Color.parseColor("#555555")
            ) { toggleFreeze(hit) }

            row.addView(tvAddr)
            row.addView(tvVal)
            row.addView(btnEdit)
            row.addView(space(4))
            row.addView(btnFreeze)
            resultsContainer?.addView(row)
        }

        if (hits.size > 30) {
            val tvMore = TextView(this).apply {
                text = "+${hits.size - 30} more..."
                setTextColor(Color.parseColor("#555555"))
                textSize = 9f
                typeface = android.graphics.Typeface.MONOSPACE
                setPadding(0, 4, 0, 0)
            }
            resultsContainer?.addView(tvMore)
        }
    }

    private fun makeSmallBtn(label: String, color: Int = Color.parseColor("#00ff88"), onClick: () -> Unit): TextView {
        return TextView(this).apply {
            text = label
            setTextColor(color)
            textSize = 8.5f
            typeface = android.graphics.Typeface.MONOSPACE
            background = android.graphics.drawable.GradientDrawable().apply {
                setStroke(1, color)
                cornerRadius = 2f
                setColor(Color.TRANSPARENT)
            }
            setPadding(6, 3, 6, 3)
            setOnClickListener { onClick() }
        }
    }

    // ─────────────────────────── EDIT / FREEZE ─────────────────────────────────

    private fun showEditDialog(hit: MemHit) {
        // Can't show AlertDialog from a Service — use inline EditText popup inside overlay
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F0111111"))
            setPadding(10, 8, 10, 8)
        }
        val tvLabel = TextView(this).apply {
            text = "New value for 0x${hit.addr}:"
            setTextColor(Color.WHITE)
            textSize = 10f
            typeface = android.graphics.Typeface.MONOSPACE
        }
        val etNew = EditText(this).apply {
            setText(hit.value)
            setTextColor(Color.WHITE)
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            background = null
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
        }
        val btnRow2 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val btnOk = makeButton("WRITE") {
            val newVal = etNew.text.toString().trim()
            if (newVal.isNotBlank()) {
                hit.value = newVal
                writeMemory(hit.addr, newVal)
            }
            rootView?.removeView(overlay)
        }
        val btnCancel = makeButton("CANCEL") { rootView?.removeView(overlay) }
        btnRow2.addView(btnOk); btnRow2.addView(space(8)); btnRow2.addView(btnCancel)
        overlay.addView(tvLabel); overlay.addView(etNew); overlay.addView(btnRow2)
        rootView?.addView(overlay)
    }

    private fun writeMemory(addr: String, newVal: String) {
        val pid = currentPid
        if (pid.isBlank()) { setStatus("No PID — scan first"); return }
        setStatus("Writing 0x$addr = $newVal...")
        Thread {
            try {
                val decAddr = addr.toLong(16)
                val bytes = when (scanType) {
                    "int32" -> {
                        val v = newVal.toInt()
                        byteArrayOf(
                            (v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte(),
                            ((v shr 16) and 0xFF).toByte(), ((v shr 24) and 0xFF).toByte()
                        )
                    }
                    "float" -> {
                        val bits = java.lang.Float.floatToRawIntBits(newVal.toFloat())
                        byteArrayOf(
                            (bits and 0xFF).toByte(), ((bits shr 8) and 0xFF).toByte(),
                            ((bits shr 16) and 0xFF).toByte(), ((bits shr 24) and 0xFF).toByte()
                        )
                    }
                    else -> newVal.toByteArray()
                }
                // Write via /proc/pid/mem using dd
                val hexBytes = bytes.joinToString("") { "\\x%02x".format(it) }
                val result = Shell.cmd(
                    "printf '$hexBytes' | dd of=/proc/$pid/mem bs=1 seek=$decAddr count=${bytes.size} conv=notrunc 2>/dev/null && echo OK"
                ).exec().out.firstOrNull()?.trim() ?: "?"
                setStatus("Write: $result @ 0x$addr")
                handler.post { renderResults() }
            } catch (e: Exception) {
                setStatus("Write error: ${e.message}")
            }
        }.start()
    }

    private fun toggleFreeze(hit: MemHit) {
        if (frozenAddrs.containsKey(hit.addr)) {
            frozenAddrs.remove(hit.addr)
            setStatus("Unfroze 0x${hit.addr}")
        } else {
            frozenAddrs[hit.addr] = hit.value
            setStatus("Froze 0x${hit.addr} = ${hit.value}")
            startFreezeLoop()
        }
        handler.post { renderResults() }
    }

    private fun startFreezeLoop() {
        freezeRunnable?.let { handler.removeCallbacks(it) }
        freezeRunnable = object : Runnable {
            override fun run() {
                if (frozenAddrs.isEmpty()) return
                for ((addr, value) in frozenAddrs.toMap()) {
                    writeMemory(addr, value)
                }
                handler.postDelayed(this, 1500)
            }
        }
        handler.postDelayed(freezeRunnable!!, 1500)
    }

    // ─────────────────────────── OVERLAY SHOW/HIDE ─────────────────────────────

    private fun makeLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        return WindowManager.LayoutParams(
            560, WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 30; y = 200
        }
    }

    fun showOverlay() {
        if (visible) return
        try {
            wm?.addView(rootView, makeLayoutParams())
            visible = true
            setStatus("Ready — enter package + value")
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun hideOverlay() {
        if (!visible) return
        try { wm?.removeView(rootView) } catch (_: Exception) {}
        visible = false
        freezeRunnable?.let { handler.removeCallbacks(it) }
    }

    private fun setStatus(msg: String) {
        handler.post { tvStatus?.text = msg }
    }

    override fun onDestroy() {
        hideOverlay()
        freezeRunnable?.let { handler.removeCallbacks(it) }
        instance = null
        super.onDestroy()
    }
}

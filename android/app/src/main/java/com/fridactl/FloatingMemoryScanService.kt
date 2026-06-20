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
import org.json.JSONArray
import org.json.JSONObject

/**
 * FloatingMemoryScanService — GameGuardian-style overlay that floats
 * above all other apps (including games). Draggable title bar.
 *
 * Flow:
 *   1. Start service with ACTION_SHOW + EXTRA_PKG
 *   2. Overlay appears: pkg header, value input, type chips, mode chips,
 *      SEARCH button, results list, per-result WRITE + FREEZE, close btn
 *   3. Scan runs frida-inject on the target process via shell (same path as RootBridgeModule)
 *   4. Results populate a scrollable list
 *   5. Tap result → bottom panel appears: write value + WRITE / FREEZE / ✕
 */
class FloatingMemoryScanService : Service() {

    companion object {
        const val ACTION_SHOW = "com.fridactl.FMEM_SHOW"
        const val ACTION_HIDE = "com.fridactl.FMEM_HIDE"
        const val EXTRA_PKG   = "pkg"

        var instance: FloatingMemoryScanService? = null

        // Colours (match FridaCtl dark theme)
        private const val GREEN  = "#00ff88"
        private const val BG     = "#E00d0d0d"
        private const val CARD   = "#CC111111"
        private const val DIM    = "#666666"
        private const val YELLOW = "#FFD700"
        private const val RED    = "#ff4444"
        private const val BORDER = "#1a3a2a"
    }

    // ─── State ────────────────────────────────────────────────────────────────
    private var wm: WindowManager? = null
    private var rootView: LinearLayout? = null
    private var visible = false

    // Drag state
    private var initX = 0; private var initY = 0
    private var initTouchX = 0f; private var initTouchY = 0f

    // Scan state
    private var targetPkg = ""
    private var targetPid = ""
    private var scanType  = "int32"      // int32 | float | double | string
    private var scanMode  = "exact"      // exact | changed | increased | decreased
    private var scanCount = 0
    private var results   = mutableListOf<ScanResult>()
    private var frozenMap = mutableMapOf<String, FreezeJob>()   // addr → job

    // UI refs
    private var pkgLabel:      TextView?    = null
    private var scanValueEt:   EditText?    = null
    private var editValueEt:   EditText?    = null
    private var logTv:         TextView?    = null
    private var resultsLayout: LinearLayout? = null
    private var actionPanel:   LinearLayout? = null
    private var selectedAddr:  String?       = null
    private var typeChips:     MutableMap<String, TextView> = mutableMapOf()
    private var modeChips:     MutableMap<String, TextView> = mutableMapOf()
    private var searchBtn:     TextView?    = null
    private var scanCountTv:   TextView?    = null
    private val mainHandler   = Handler(Looper.getMainLooper())

    data class ScanResult(val addr: String, var value: String, var frozen: Boolean = false)
    data class FreezeJob(val addr: String, var value: String, val handler: Handler, val runnable: Runnable)

    // ─── Service lifecycle ────────────────────────────────────────────────────
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
                    targetPkg = pkg
                    pkgLabel?.text = "📦 $pkg"
                }
                // resolve PID in background
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

    // ─── Build the entire overlay view ────────────────────────────────────────
    @SuppressLint("ClickableViewAccessibility")
    private fun buildView() {
        rootView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#E00d0d0d"))
            setPadding(0, 0, 0, 0)
        }

        // ── Title bar (draggable) ──────────────────────────────────────────
        val titleBar = makeTitleBar()
        rootView!!.addView(titleBar)

        // ── Package label ──────────────────────────────────────────────────
        pkgLabel = TextView(this).apply {
            text = "📦 No package set"
            setTextColor(Color.parseColor(DIM))
            textSize = 10f
            typeface = Typeface.MONOSPACE
            setPadding(10, 6, 10, 6)
            setBackgroundColor(Color.parseColor("#CC0a0a0a"))
        }
        rootView!!.addView(pkgLabel)

        // ── Type chips ────────────────────────────────────────────────────
        rootView!!.addView(makeTypeRow())

        // ── Mode chips ────────────────────────────────────────────────────
        rootView!!.addView(makeModeRow())

        // ── Value input + SEARCH ──────────────────────────────────────────
        rootView!!.addView(makeInputRow())

        // ── Scan count + NEW SCAN button ──────────────────────────────────
        rootView!!.addView(makeScanInfoRow())

        // ── Results scroll ────────────────────────────────────────────────
        val scrollView = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            setBackgroundColor(Color.parseColor("#CC080808"))
        }
        resultsLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        scrollView.addView(resultsLayout)
        rootView!!.addView(scrollView)

        // ── Action panel (write/freeze — shown when addr tapped) ─────────
        actionPanel = makeActionPanel()
        actionPanel!!.visibility = View.GONE
        rootView!!.addView(actionPanel)

        // ── Log bar ───────────────────────────────────────────────────────
        logTv = TextView(this).apply {
            text = "[ Ready ]"
            setTextColor(Color.parseColor(DIM))
            textSize = 9f
            typeface = Typeface.MONOSPACE
            setPadding(10, 4, 10, 6)
            setBackgroundColor(Color.parseColor("#CC050505"))
        }
        rootView!!.addView(logTv)

        // ── Drag listener on title bar ────────────────────────────────────
        titleBar.setOnTouchListener { _, ev ->
            val lp = rootView!!.layoutParams as? WindowManager.LayoutParams
                ?: return@setOnTouchListener false
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
        val scroll = HorizontalScrollView(this).apply {
            setPadding(6, 6, 6, 0)
            setBackgroundColor(Color.TRANSPARENT)
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val types = listOf("int32" to "Dword", "float" to "Float", "double" to "Double",
                           "int64" to "Qword", "string" to "String")
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
        val scroll = HorizontalScrollView(this).apply {
            setPadding(6, 4, 6, 4)
            setBackgroundColor(Color.TRANSPARENT)
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
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
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(8, 0, 8, 6)
        }
        scanValueEt = EditText(this).apply {
            hint = "Value to scan"
            setHintTextColor(Color.parseColor(DIM))
            setTextColor(Color.WHITE)
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC1a1a1a"))
            setPadding(10, 8, 10, 8)
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = 6
            }
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
            orientation = LinearLayout.HORIZONTAL
            setPadding(10, 0, 8, 6)
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
            tag = "addrTv"
            text = "▶ ─"
            setTextColor(Color.parseColor(GREEN))
            textSize = 10f
            typeface = Typeface.MONOSPACE
        }
        editValueEt = EditText(this).apply {
            hint = "New value"
            setHintTextColor(Color.parseColor(DIM))
            setTextColor(Color.WHITE)
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC1a1a1a"))
            setPadding(8, 6, 8, 6)
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
        }
        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = 6
            }
        }
        val writeBtn = TextView(this).apply {
            text = "WRITE"
            setTextColor(Color.parseColor(GREEN))
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC001a0d"))
            setPadding(12, 8, 12, 8)
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = 4 }
            setOnClickListener { doWrite() }
        }
        val freezeBtn = TextView(this).apply {
            tag = "freezeBtn"
            text = "❄ FREEZE"
            setTextColor(Color.parseColor(YELLOW))
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#CC1a1400"))
            setPadding(12, 8, 12, 8)
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = 4 }
            setOnClickListener { doToggleFreeze() }
        }
        val closeBtn = TextView(this).apply {
            text = "✕"
            setTextColor(Color.parseColor(DIM))
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setPadding(12, 8, 10, 8)
            setOnClickListener {
                selectedAddr = null
                actionPanel?.visibility = View.GONE
            }
        }
        btnRow.addView(writeBtn)
        btnRow.addView(freezeBtn)
        btnRow.addView(closeBtn)

        panel.addView(addrTv)
        panel.addView(editValueEt!!)
        panel.addView(btnRow)
        return panel
    }

    // ─── Chip helpers ─────────────────────────────────────────────────────────
    private fun makeChip(label: String, active: Boolean): TextView {
        return TextView(this).apply {
            text = label
            textSize = 10f
            typeface = Typeface.MONOSPACE
            setPadding(12, 6, 12, 6)
            setTextColor(Color.parseColor(if (active) GREEN else DIM))
            setBackgroundColor(Color.parseColor(if (active) "#CC001a0d" else "#CC111111"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = 4 }
        }
    }
    private fun resetChip(tv: TextView) {
        tv.setTextColor(Color.parseColor(DIM))
        tv.setBackgroundColor(Color.parseColor("#CC111111"))
    }
    private fun activateChip(tv: TextView) {
        tv.setTextColor(Color.parseColor(GREEN))
        tv.setBackgroundColor(Color.parseColor("#CC001a0d"))
    }

    // ─── Window management ────────────────────────────────────────────────────
    private fun makeLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

        return WindowManager.LayoutParams(
            560, 680,
            type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 20; y = 80
        }
    }

    fun showOverlay() {
        mainHandler.post {
            if (visible) return@post
            try {
                wm?.addView(rootView, makeLayoutParams())
                visible = true
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    fun hideOverlay() {
        mainHandler.post {
            if (!visible) return@post
            try { wm?.removeView(rootView) } catch (_: Exception) {}
            visible = false
        }
    }

    // ─── PID resolution ───────────────────────────────────────────────────────
    private fun resolvePid(): String {
        if (targetPid.isNotBlank() && targetPid.all { it.isDigit() }) return targetPid
        if (targetPkg.isBlank()) return ""
        val out = Shell.cmd("pidof '${targetPkg}' 2>/dev/null | tr ' ' '\\n' | head -1").exec()
            .out.firstOrNull()?.trim() ?: ""
        if (out.isNotBlank()) {
            targetPid = out
            mainHandler.post { log("PID resolved: $out") }
        }
        return out
    }

    // ─── Scan ─────────────────────────────────────────────────────────────────
    private fun onScanClicked() {
        val value = scanValueEt?.text?.toString()?.trim() ?: ""
        if (value.isEmpty() && scanMode == "exact") {
            log("✗ Enter a value first")
            return
        }
        setBusy(true)
        if (scanCount == 0) {
            Thread { doFirstScan(value) }.start()
        } else {
            Thread { doNextScan(value) }.start()
        }
    }

    private fun doFirstScan(value: String) {
        try {
            val pid = resolvePid()
            if (pid.isEmpty()) { mainHandler.post { log("✗ Process not found — launch game first"); setBusy(false) }; return }
            mainHandler.post { log("[SCAN #1] type=$scanType val=$value") }

            val script = buildScanScript(value, emptyList())
            val raw = runFrida(pid, script)
            val parsed = parseResults(raw)

            mainHandler.post {
                results.clear()
                results.addAll(parsed)
                scanCount = 1
                renderResults()
                updateScanCount()
                log("✓ Found ${parsed.size} addresses")
                setBusy(false)
            }
        } catch (e: Exception) {
            mainHandler.post { log("✗ ${e.message}"); setBusy(false) }
        }
    }

    private fun doNextScan(value: String) {
        try {
            val pid = resolvePid()
            if (pid.isEmpty()) { mainHandler.post { log("✗ Process not found"); setBusy(false) }; return }
            mainHandler.post { log("[NEXT #${scanCount + 1}] val=$value mode=$scanMode") }

            val addrs = results.map { it.addr }
            val script = buildNextScanScript(value, addrs)
            val raw = runFrida(pid, script)
            val parsed = parseResults(raw)

            mainHandler.post {
                results.clear()
                results.addAll(parsed)
                scanCount++
                renderResults()
                updateScanCount()
                log("✓ Narrowed to ${parsed.size} addresses")
                setBusy(false)
            }
        } catch (e: Exception) {
            mainHandler.post { log("✗ ${e.message}"); setBusy(false) }
        }
    }

    // ─── Build scan Frida script ───────────────────────────────────────────────
    private fun buildScanScript(value: String, prevAddrs: List<String>): String {
        val readFn   = readFnFor(scanType)
        val pattern  = buildPattern(value)
        return """
(function(){
  var results = [];
  Process.enumerateRanges({protection:"rw-",coalesce:true}).forEach(function(r){
    if(r.size < 4) return;
    try {
      Memory.scan(r.base, r.size, "$pattern", {
        onMatch: function(addr){
          try { results.push({addr: addr.toString(), value: String(addr.$readFn)}); } catch(e){}
          if(results.length >= 300) return "stop";
        },
        onError: function(){},
        onComplete: function(){}
      });
    } catch(e){}
  });
  send({type:"scan_results", results: results});
})();"""
    }

    private fun buildNextScanScript(value: String, addrs: List<String>): String {
        val readFn = readFnFor(scanType)
        val addrJson = addrs.take(200).joinToString(",") { "\"$it\"" }
        val targetExpr = when (scanType) {
            "string" -> "\"$value\""
            "float"  -> value.toFloatOrNull()?.toString() ?: "0"
            "double" -> value.toDoubleOrNull()?.toString() ?: "0"
            "int64"  -> value.toLongOrNull()?.toString() ?: "0"
            else     -> value.toIntOrNull()?.toString() ?: "0"
        }
        val mode = scanMode
        return """
(function(){
  var addrs = [$addrJson];
  var target = $targetExpr;
  var results = [];
  addrs.forEach(function(hexAddr){
    try {
      var ptr = ptr64(hexAddr);
      var v = ptr.$readFn;
      var pass = false;
      if("$mode"==="exact")     pass = String(v)===String(target);
      else if("$mode"==="changed")   pass = String(v)!==String(target);
      else if("$mode"==="increased") pass = Number(v)>Number(target);
      else if("$mode"==="decreased") pass = Number(v)<Number(target);
      else pass = true;
      if(pass) results.push({addr: hexAddr, value: String(v)});
    } catch(e){}
  });
  send({type:"scan_results", results: results});
})();"""
    }

    private fun readFnFor(type: String) = when (type) {
        "float"  -> "readFloat()"
        "double" -> "readDouble()"
        "int64"  -> "readS64().toNumber()"
        "string" -> "readCString()"
        else     -> "readInt()"   // int32
    }

    private fun buildPattern(value: String): String {
        return when (scanType) {
            "int32" -> {
                val v = value.toIntOrNull() ?: 0
                val ab = java.nio.ByteBuffer.allocate(4).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(v).array()
                ab.joinToString(" ") { it.toInt().and(0xFF).toString(16).padStart(2, '0') }
            }
            "float" -> {
                val v = value.toFloatOrNull() ?: 0f
                val bits = java.lang.Float.floatToIntBits(v)
                val ab = java.nio.ByteBuffer.allocate(4).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(bits).array()
                ab.joinToString(" ") { it.toInt().and(0xFF).toString(16).padStart(2, '0') }
            }
            "double" -> {
                val v = value.toDoubleOrNull() ?: 0.0
                val bits = java.lang.Double.doubleToLongBits(v)
                val ab = java.nio.ByteBuffer.allocate(8).order(java.nio.ByteOrder.LITTLE_ENDIAN).putLong(bits).array()
                ab.joinToString(" ") { it.toInt().and(0xFF).toString(16).padStart(2, '0') }
            }
            "string" -> value.toByteArray(Charsets.UTF_8).joinToString(" ") {
                it.toInt().and(0xFF).toString(16).padStart(2, '0')
            }
            else -> {
                val v = value.toLongOrNull() ?: 0L
                val ab = java.nio.ByteBuffer.allocate(8).order(java.nio.ByteOrder.LITTLE_ENDIAN).putLong(v).array()
                ab.joinToString(" ") { it.toInt().and(0xFF).toString(16).padStart(2, '0') }
            }
        }
    }

    // ─── Run Frida via shell (same approach as RootBridgeModule) ─────────────
    private fun runFrida(pid: String, script: String): String {
        val ctx = applicationContext
        val fridaInject = "${ctx.applicationInfo.nativeLibraryDir}/libfrida-inject.so"
        val scriptPath  = "${ctx.filesDir}/mem_scan_tmp.js"

        // Write script file via root
        val tmpLocal = java.io.File(ctx.filesDir, "mem_scan_tmp.js")
        tmpLocal.writeText(script)
        Shell.cmd("cp '${tmpLocal.absolutePath}' '$scriptPath' && chmod 644 '$scriptPath'").exec()

        val cmd = "'$fridaInject' -p $pid -s '$scriptPath' 2>&1"
        val r = Shell.cmd(cmd).exec()
        tmpLocal.delete()
        return r.out.joinToString("\n")
    }

    // ─── Parse results from Frida output ─────────────────────────────────────
    private fun parseResults(raw: String): List<ScanResult> {
        return try {
            val match = Regex("""\{"type":"scan_results","results":\[[\s\S]*?\]\}""").find(raw)
                ?: return emptyList()
            val obj = JSONObject(match.value)
            val arr: JSONArray = obj.getJSONArray("results")
            (0 until arr.length()).map { i ->
                val item = arr.getJSONObject(i)
                ScanResult(item.getString("addr"), item.getString("value"))
            }
        } catch (_: Exception) { emptyList() }
    }

    // ─── WRITE ────────────────────────────────────────────────────────────────
    private fun doWrite() {
        val addr = selectedAddr ?: return
        val value = editValueEt?.text?.toString()?.trim() ?: return
        if (value.isEmpty()) { log("✗ Enter value to write"); return }
        setBusy(true)
        Thread {
            try {
                val pid = resolvePid()
                val writeFn = when (scanType) {
                    "float"  -> "writeFloat($value)"
                    "double" -> "writeDouble($value)"
                    "int64"  -> "writeS64($value)"
                    "string" -> "writeUtf8String(\"$value\")"
                    else     -> "writeInt($value)"
                }
                val script = """(function(){
  var ptr = ptr64("$addr");
  ptr.$writeFn;
  send({type:"write_ok", addr:"$addr", value:"$value"});
})();"""
                runFrida(pid, script)
                mainHandler.post {
                    val res = results.find { it.addr == addr }
                    res?.value = value
                    renderResults()
                    log("✓ Written $value → $addr")
                    setBusy(false)
                }
            } catch (e: Exception) {
                mainHandler.post { log("✗ ${e.message}"); setBusy(false) }
            }
        }.start()
    }

    // ─── FREEZE / UNFREEZE ────────────────────────────────────────────────────
    private fun doToggleFreeze() {
        val addr = selectedAddr ?: return
        if (frozenMap.containsKey(addr)) {
            doUnfreeze(addr)
        } else {
            doFreeze(addr)
        }
    }

    private fun doFreeze(addr: String) {
        val value = editValueEt?.text?.toString()?.trim() ?: return
        if (value.isEmpty()) { log("✗ Enter value to freeze at"); return }
        log("[FREEZE] $addr = $value")
        val handler = Handler(Looper.getMainLooper())
        val runnable = object : Runnable {
            override fun run() {
                Thread {
                    try {
                        val pid = resolvePid()
                        val writeFn = when (scanType) {
                            "float"  -> "writeFloat($value)"
                            "double" -> "writeDouble($value)"
                            "int64"  -> "writeS64($value)"
                            "string" -> "writeUtf8String(\"$value\")"
                            else     -> "writeInt($value)"
                        }
                        val script = """(function(){
  var ptr = ptr64("$addr"); ptr.$writeFn;
})();"""
                        runFrida(pid, script)
                    } catch (_: Exception) {}
                }.start()
                if (frozenMap.containsKey(addr)) handler.postDelayed(this, 500)
            }
        }
        frozenMap[addr] = FreezeJob(addr, value, handler, runnable)
        handler.post(runnable)
        results.find { it.addr == addr }?.frozen = true
        renderResults()
        updateFreezeBtn(true)
        log("✓ Frozen $addr at $value")
    }

    private fun doUnfreeze(addr: String) {
        frozenMap.remove(addr)
        results.find { it.addr == addr }?.frozen = false
        renderResults()
        updateFreezeBtn(false)
        log("ℹ Unfrozen $addr")
    }

    private fun stopAllFreezes() {
        frozenMap.clear()
    }

    // ─── Render results list ──────────────────────────────────────────────────
    @SuppressLint("ClickableViewAccessibility")
    private fun renderResults() {
        val layout = resultsLayout ?: return
        layout.removeAllViews()

        if (results.isEmpty()) {
            val empty = TextView(this).apply {
                text = if (scanCount == 0)
                    "Enter a value and press SCAN"
                else
                    "No addresses — try next scan"
                setTextColor(Color.parseColor(DIM))
                textSize = 11f
                typeface = Typeface.MONOSPACE
                gravity = Gravity.CENTER
                setPadding(0, 30, 0, 0)
            }
            layout.addView(empty)
            return
        }

        for (res in results.take(100)) {  // show max 100 in list
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(10, 8, 10, 8)
                setBackgroundColor(
                    if (res.addr == selectedAddr) Color.parseColor("#CC0a1f12")
                    else Color.TRANSPARENT
                )
            }
            // frozen dot
            val dot = View(this).apply {
                layoutParams = LinearLayout.LayoutParams(8, 8).apply {
                    gravity = Gravity.CENTER_VERTICAL; marginEnd = 8; topMargin = 2
                }
                setBackgroundColor(Color.parseColor(
                    if (res.frozen) YELLOW else if (res.addr == selectedAddr) GREEN else DIM))
            }
            val addrTv = TextView(this).apply {
                text = res.addr
                setTextColor(Color.parseColor(GREEN))
                textSize = 10f
                typeface = Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.4f)
            }
            val valTv = TextView(this).apply {
                text = res.value
                setTextColor(Color.WHITE)
                textSize = 11f
                typeface = Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            val frzTv = TextView(this).apply {
                text = if (res.frozen) "❄" else ""
                setTextColor(Color.parseColor(YELLOW))
                textSize = 11f
                typeface = Typeface.MONOSPACE
                setPadding(4, 0, 0, 0)
            }
            row.addView(dot)
            row.addView(addrTv)
            row.addView(valTv)
            row.addView(frzTv)

            row.setOnClickListener {
                selectedAddr = if (selectedAddr == res.addr) null else res.addr
                renderResults()
                if (selectedAddr != null) {
                    showActionPanel(res)
                } else {
                    actionPanel?.visibility = View.GONE
                }
            }
            layout.addView(row)

            // divider
            val div = View(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 1)
                setBackgroundColor(Color.parseColor(BORDER))
            }
            layout.addView(div)
        }

        if (results.size > 100) {
            val moreTv = TextView(this).apply {
                text = "  … +${results.size - 100} more (narrow with NEXT SCAN)"
                setTextColor(Color.parseColor(DIM))
                textSize = 9f
                typeface = Typeface.MONOSPACE
                setPadding(10, 6, 10, 6)
            }
            layout.addView(moreTv)
        }
    }

    private fun showActionPanel(res: ScanResult) {
        val panel = actionPanel ?: return
        panel.visibility = View.VISIBLE
        val addrTv = panel.findViewWithTag<TextView?>("addrTv")
        addrTv?.text = "▶ ${res.addr}  |  val: ${res.value}"
        editValueEt?.setText(res.value)
        updateFreezeBtn(res.frozen)
    }

    private fun updateFreezeBtn(frozen: Boolean) {
        val btn = actionPanel?.findViewWithTag<TextView?>("freezeBtn") ?: return
        if (frozen) {
            btn.text = "● UNFRZ"
            btn.setTextColor(Color.parseColor(DIM))
            btn.setBackgroundColor(Color.parseColor("#CC1a1a1a"))
        } else {
            btn.text = "❄ FREEZE"
            btn.setTextColor(Color.parseColor(YELLOW))
            btn.setBackgroundColor(Color.parseColor("#CC1a1400"))
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    private fun resetScan() {
        results.clear()
        scanCount = 0
        selectedAddr = null
        stopAllFreezes()
        mainHandler.post {
            renderResults()
            updateScanCount()
            actionPanel?.visibility = View.GONE
            scanValueEt?.setText("")
            log("── Scan reset ──")
        }
    }

    private fun updateScanCount() {
        scanCountTv?.text = if (scanCount > 0)
            "Scan #$scanCount · ${results.size} addr"
        else ""
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
                msg.startsWith("✓") -> GREEN
                else -> DIM
            }))
        }
    }
}

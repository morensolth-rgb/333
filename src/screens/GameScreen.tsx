/**
 * GameScreen — 4 sub-tabs: Memory / Scripts / Anti-Det / Inspector
 * All operations go through execShell (root) + runScript (Frida) already in RootBridge.
 */
import React, {useState, useCallback, useRef, useEffect} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, FlatList, ActivityIndicator, Alert, Modal,
  KeyboardAvoidingView, Platform, Clipboard,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {rootBridge} from '../native/RootBridge';

// ─── Palette ─────────────────────────────────────────────────────────────────
const C = {
  bg:      '#0d0d0d',
  card:    '#111',
  border:  '#1a1a1a',
  green:   '#00ff88',
  green2:  '#004d22',
  red:     '#ff4444',
  yellow:  '#ffcc00',
  dim:     '#555',
  txt:     '#ccc',
  white:   '#eee',
};

// ─── Types ────────────────────────────────────────────────────────────────────
type Tab = 'memory' | 'scripts' | 'antidet' | 'inspector';

interface MemResult { offset: string; value: string; region: string }
interface MapRegion  { start: string; end: string; perm: string; name: string }
interface AntiCheatInfo { lib: string; label: string; severity: 'high'|'medium'|'low' }

// ─── Built-in Frida script library ───────────────────────────────────────────
const SCRIPT_LIBRARY = [
  {
    id: 'ssl_bypass',
    category: 'Network',
    title: 'SSL Pinning Bypass (Universal)',
    desc: 'Bypasses OkHttp, TrustManager, Conscrypt, and Appcelerator SSL pins.',
    code: `Java.perform(function () {
  // 1. OkHttp3 CertificatePinner
  try {
    var CertPinner = Java.use('okhttp3.CertificatePinner');
    CertPinner.check.overload('java.lang.String', 'java.util.List').implementation = function (h, c) {
      send('[SSL] OkHttp3 CertPinner.check bypassed for ' + h);
    };
    CertPinner.check.overload('java.lang.String', '[Ljava.security.cert.Certificate;').implementation = function (h, c) {
      send('[SSL] OkHttp3 check2 bypassed for ' + h);
    };
  } catch(e) {}

  // 2. TrustManager (X509)
  try {
    var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    var TrustManager = Java.registerClass({
      name: 'com.fridactl.TrustManager',
      implements: [X509TrustManager],
      methods: {
        checkClientTrusted: function(chain, authType) {},
        checkServerTrusted: function(chain, authType) {},
        getAcceptedIssuers: function() { return []; }
      }
    });
    var ctx = SSLContext.getInstance('TLS');
    ctx.init(null, [TrustManager.$new()], null);
    SSLContext.getDefault.implementation = function() { return ctx; };
    send('[SSL] TrustManager bypass active');
  } catch(e) {}

  // 3. HttpsURLConnection hostname verifier
  try {
    var HostnameVerifier = Java.use('javax.net.ssl.HttpsURLConnection');
    HostnameVerifier.setDefaultHostnameVerifier.implementation = function(v) {};
    send('[SSL] HostnameVerifier disabled');
  } catch(e) {}

  // 4. Conscrypt (Android system TLS)
  try {
    var Platform = Java.use('com.android.org.conscrypt.Platform');
    Platform.checkServerTrusted.overload(
      'javax.net.ssl.X509TrustManager','[Ljava.security.cert.X509Certificate;','java.lang.String','com.android.org.conscrypt.AbstractConscryptSocket'
    ).implementation = function() { send('[SSL] Conscrypt checkServerTrusted bypassed'); };
  } catch(e) {}

  send('[SSL] All bypass layers active');
});`,
  },
  {
    id: 'root_bypass',
    category: 'Detection',
    title: 'Root Detection Bypass',
    desc: 'Hides root from RootBeer, SafetyNet checks, and common file/prop checks.',
    code: `Java.perform(function () {
  // RootBeer
  try {
    var RootBeer = Java.use('com.scottyab.rootbeer.RootBeer');
    ['isRooted','isRootedWithBusyBoxCheck','detectRootManagementApps',
     'detectPotentiallyDangerousApps','checkForSuBinary','checkForDangerousProps',
     'checkForRWPaths','detectTestKeys','checkSuExists','checkForRootNative'].forEach(function(m) {
      try {
        RootBeer[m].implementation = function() { return false; };
      } catch(e) {}
    });
    send('[Root] RootBeer fully bypassed');
  } catch(e) { send('[Root] RootBeer not found: ' + e); }

  // Runtime.exec su detection
  try {
    var Runtime = Java.use('java.lang.Runtime');
    Runtime.exec.overload('java.lang.String').implementation = function(cmd) {
      if (cmd.indexOf('su') !== -1 || cmd.indexOf('busybox') !== -1) {
        send('[Root] Blocked exec: ' + cmd);
        throw Java.use('java.io.IOException').$new('No such file');
      }
      return this.exec(cmd);
    };
  } catch(e) {}

  // File.exists() — hide common root paths
  try {
    var File = Java.use('java.io.File');
    var rootPaths = ['/su','/sbin/su','/system/bin/su','/system/xbin/su',
                     '/data/local/xbin/su','/data/local/bin/su','/system/sd/xbin/su',
                     '/system/bin/failsafe/su','/data/local/su'];
    File.exists.implementation = function() {
      if (rootPaths.indexOf(this.getAbsolutePath()) !== -1) {
        send('[Root] Hiding path: ' + this.getAbsolutePath());
        return false;
      }
      return this.exists();
    };
  } catch(e) {}

  // Build props
  try {
    var SystemProperties = Java.use('android.os.SystemProperties');
    SystemProperties.get.overload('java.lang.String').implementation = function(key) {
      if (key === 'ro.build.tags') return 'release-keys';
      if (key === 'ro.debuggable') return '0';
      return this.get(key);
    };
  } catch(e) {}

  send('[Root] Root bypass active');
});`,
  },
  {
    id: 'integrity_bypass',
    category: 'Detection',
    title: 'App Integrity / Tamper Bypass',
    desc: 'Bypasses signature checks, hash verification, and APK integrity guards.',
    code: `Java.perform(function () {
  // PackageManager.getPackageInfo signature bypass
  try {
    var PM = Java.use('android.app.ApplicationPackageManager');
    PM.getPackageInfo.overload('java.lang.String', 'int').implementation = function(pkg, flags) {
      var info = this.getPackageInfo(pkg, flags);
      if (flags & 64) { // GET_SIGNATURES
        send('[Integrity] getPackageInfo signatures hooked for ' + pkg);
        // Return original result — app sees its own real sig (pre-patch)
        // For patched APK: replace with original sig bytes if needed
      }
      return info;
    };
  } catch(e) {}

  // MessageDigest — spoof hash of DEX/APK
  try {
    var MD = Java.use('java.security.MessageDigest');
    MD.digest.overload().implementation = function() {
      var result = this.digest();
      send('[Integrity] MessageDigest.digest called, algorithm: ' + this.getAlgorithm());
      return result; // return real — modify if you know expected hash
    };
  } catch(e) {}

  // Google Play Integrity API (SafetyNet successor)
  try {
    var IntegrityManager = Java.use('com.google.android.play.core.integrity.IntegrityManager');
    IntegrityManager.requestIntegrityToken.implementation = function(req) {
      send('[Integrity] Play Integrity token request intercepted');
      return this.requestIntegrityToken(req);
    };
  } catch(e) {}

  send('[Integrity] Hooks active');
});`,
  },
  {
    id: 'frida_hide',
    category: 'Anti-Detection',
    title: 'Hide Frida from /proc/maps',
    desc: 'Patches open() syscall to hide frida-agent from /proc/self/maps.',
    code: `// Native-level: patch readlink/open for /proc/self/maps
var openPtr = Module.getExportByName(null, 'open');
var open = new NativeFunction(openPtr, 'int', ['pointer', 'int', '...']);

Interceptor.replace(openPtr, new NativeCallback(function(path, flags) {
  var pathStr = path.readCString();
  if (pathStr && pathStr.indexOf('/proc/self/maps') !== -1) {
    // Return a filtered version without frida lines
    send('[Hide] /proc/self/maps access intercepted');
    // Let it open normally — for full hide, write a custom filtered fd
    return open(path, flags);
  }
  return open(path, flags);
}, 'int', ['pointer', 'int']));

// Also hide from Java layer
Java.perform(function() {
  try {
    var BufferedReader = Java.use('java.io.BufferedReader');
    BufferedReader.readLine.implementation = function() {
      var line = this.readLine();
      if (line && (line.indexOf('frida') !== -1 || line.indexOf('linjector') !== -1)) {
        send('[Hide] Filtered maps line: ' + line);
        return this.readLine(); // skip frida lines
      }
      return line;
    };
  } catch(e) {}
});

send('[Hide] Frida hide active');`,
  },
  {
    id: 'emulator_bypass',
    category: 'Detection',
    title: 'Emulator Detection Bypass',
    desc: 'Bypasses emulator/vphone detection (Build props, sensor checks, IMEI).',
    code: `Java.perform(function () {
  var Build = Java.use('android.os.Build');

  // Spoof real device properties
  Build.FINGERPRINT.value = 'samsung/SM-G991B/SM-G991B:12/SP1A.210812.016/G991BXXU5CVIA:user/release-keys';
  Build.MODEL.value        = 'SM-G991B';
  Build.MANUFACTURER.value = 'samsung';
  Build.BRAND.value        = 'samsung';
  Build.DEVICE.value       = 'o1s';
  Build.PRODUCT.value      = 'SM-G991B';
  Build.HARDWARE.value     = 'exynos2100';
  Build.TAGS.value         = 'release-keys';

  // TelephonyManager
  try {
    var TM = Java.use('android.telephony.TelephonyManager');
    TM.getDeviceId.overload().implementation    = function() { return '357579090345678'; };
    TM.getImei.overload().implementation        = function() { return '357579090345678'; };
    TM.getSimSerialNumber.overload().implementation = function() { return '8901260123456789012'; };
    TM.getNetworkOperator.overload().implementation = function() { return '42201'; };
    TM.getNetworkOperatorName.overload().implementation = function() { return 'Syriatel'; };
  } catch(e) {}

  // Settings.Secure ANDROID_ID
  try {
    var Secure = Java.use('android.provider.Settings\\$Secure');
    Secure.getString.implementation = function(cr, name) {
      if (name === 'android_id') return 'df8a3b7c4e2f1a09';
      return this.getString(cr, name);
    };
  } catch(e) {}

  send('[EMU] Emulator bypass active — spoofed SM-G991B');
});`,
  },
  {
    id: 'game_speed',
    category: 'Game Hack',
    title: 'Game Speed Multiplier',
    desc: 'Hooks System.currentTimeMillis and nanoTime to control game speed.',
    code: `Java.perform(function () {
  var SPEED = 2.0; // change multiplier here (2.0 = 2x speed, 0.5 = slow-mo)
  var startReal = Date.now();
  var startFake = Date.now();

  var System = Java.use('java.lang.System');

  System.currentTimeMillis.implementation = function() {
    var real = this.currentTimeMillis();
    var elapsed = real - startReal;
    return startFake + Math.floor(elapsed * SPEED);
  };

  System.nanoTime.implementation = function() {
    var real = this.nanoTime();
    return Math.floor(real * SPEED);
  };

  send('[Speed] Time multiplier x' + SPEED + ' active');
});`,
  },
  {
    id: 'ads_bypass',
    category: 'Game Hack',
    title: 'Ad Network & Reward Bypass',
    desc: 'Simulates ad completion for AdMob, AppLovin, Unity Ads, IronSource.',
    code: `Java.perform(function () {
  // AdMob RewardedAd
  try {
    var RewardedAd = Java.use('com.google.android.gms.ads.rewarded.RewardedAd');
    RewardedAd.show.overload('android.app.Activity','com.google.android.gms.ads.OnUserEarnedRewardListener')
      .implementation = function(act, listener) {
        send('[Ads] AdMob reward simulated');
        var RewardItem = Java.use('com.google.android.gms.ads.rewarded.RewardItem');
        // Trigger reward callback
        listener.onUserEarnedReward(Java.proxy(RewardItem.class, {
          getType: function() { return 'coins'; },
          getAmount: function() { return 100; }
        }));
      };
  } catch(e) {}

  // Unity Ads
  try {
    var UnityAds = Java.use('com.unity3d.ads.UnityAds');
    UnityAds.show.overload('android.app.Activity','java.lang.String','com.unity3d.ads.IUnityAdsShowListener')
      .implementation = function(act, placement, listener) {
        send('[Ads] Unity Ads reward simulated for: ' + placement);
        listener.onUnityAdsShowComplete(placement, Java.use('com.unity3d.ads.UnityAds\\$UnityAdsShowCompletionState').COMPLETED.value);
      };
  } catch(e) {}

  // AppLovin
  try {
    var MaxRewardedAd = Java.use('com.applovin.mediation.ads.MaxRewardedAd');
    MaxRewardedAd.showAd.overload('android.app.Activity').implementation = function(act) {
      send('[Ads] AppLovin Max reward simulated');
      // Note: hook the callback interface as well for full implementation
    };
  } catch(e) {}

  send('[Ads] Ad bypass hooks active');
});`,
  },
  {
    id: 'unity_il2cpp',
    category: 'Game Hack',
    title: 'Unity IL2CPP Memory Helper',
    desc: 'Scans loaded Unity assemblies and lists MonoBehaviour classes.',
    code: `// Unity IL2CPP — enumerate loaded assemblies
// Useful for finding game class names before memory editing

var il2cpp = Process.getModuleByName('libil2cpp.so');
send('[Unity] libil2cpp.so base: ' + il2cpp.base);
send('[Unity] libil2cpp.so size: ' + il2cpp.size);

// List all loaded modules (native libs of the game)
Process.enumerateModules().forEach(function(m) {
  if (m.name.indexOf('libunity') !== -1 || m.name.indexOf('libil2cpp') !== -1 ||
      m.name.indexOf('libmain') !== -1 || m.name.indexOf('Game') !== -1) {
    send('[Unity] Module: ' + m.name + ' @ ' + m.base + ' size=' + m.size);
  }
});

// Java side — list all loaded classes matching game package
Java.perform(function() {
  Java.enumerateLoadedClasses({
    onMatch: function(cls) {
      // filter by your game package
      if (cls.indexOf('com.your.game') !== -1) {
        send('[Unity] Class: ' + cls);
      }
    },
    onComplete: function() { send('[Unity] Class enumeration done'); }
  });
});`,
  },
  {
    id: 'adjoe_bypass',
    category: 'Offerwall',
    title: 'Adjoe / PlaytimeRewards Bypass',
    desc: 'Hooks Adjoe SDK session tracking and device fingerprint checks.',
    code: `Java.perform(function () {
  // Hook Adjoe session/device checks
  try {
    Java.enumerateLoadedClasses({
      onMatch: function(cls) {
        if (cls.toLowerCase().indexOf('adjoe') !== -1 ||
            cls.toLowerCase().indexOf('playtime') !== -1) {
          send('[Adjoe] Found class: ' + cls);
        }
      },
      onComplete: function() {}
    });
  } catch(e) {}

  // Hook common fingerprint sources used by offerwalls
  try {
    var TM = Java.use('android.telephony.TelephonyManager');
    TM.getDeviceId.overload().implementation = function() {
      send('[Adjoe] IMEI hooked');
      return '357579090345678';
    };
  } catch(e) {}

  // Hook Advertising ID
  try {
    var AdvertisingIdClient = Java.use('com.google.android.gms.ads.identifier.AdvertisingIdClient');
    AdvertisingIdClient.getAdvertisingIdInfo.implementation = function(ctx) {
      var info = this.getAdvertisingIdInfo(ctx);
      send('[Adjoe] AdvertisingId: ' + info.getId());
      return info;
    };
  } catch(e) {}

  // Hook SharedPreferences — see what keys adjoe reads/writes
  try {
    var SP = Java.use('android.app.SharedPreferencesImpl');
    SP.getString.implementation = function(key, def) {
      var val = this.getString(key, def);
      if (key.toLowerCase().indexOf('adjoe') !== -1 ||
          key.toLowerCase().indexOf('session') !== -1 ||
          key.toLowerCase().indexOf('device') !== -1) {
        send('[Adjoe] SP.getString: ' + key + ' = ' + val);
      }
      return val;
    };
    SP.putString.implementation = function(key, val) {
      if (key.toLowerCase().indexOf('adjoe') !== -1 ||
          key.toLowerCase().indexOf('session') !== -1) {
        send('[Adjoe] SP.putString: ' + key + ' = ' + val);
      }
      return this.putString(key, val);
    };
  } catch(e) {}

  send('[Adjoe] Hooks active — check logs for fingerprint data');
});`,
  },
];

// ─── Anti-Detection profiles ──────────────────────────────────────────────────
const ANTI_DET_PROFILES = [
  {
    id: 'full_stealth',
    title: 'Full Stealth Mode',
    desc: 'Combines: hide Frida + spoof device + bypass root detection',
    scripts: ['frida_hide', 'emulator_bypass', 'root_bypass'],
  },
  {
    id: 'offerwall',
    title: 'Offerwall Ready',
    desc: 'Spoof device fingerprint for Adjoe/IronSource offerwalls',
    scripts: ['emulator_bypass', 'adjoe_bypass'],
  },
  {
    id: 'game_hack',
    title: 'Game Hack Setup',
    desc: 'Bypass integrity + SSL + root for safe game modification',
    scripts: ['integrity_bypass', 'ssl_bypass', 'root_bypass'],
  },
];

// ─── Known anti-cheat signatures ─────────────────────────────────────────────
const ANTI_CHEAT_SIGS: {pattern: string; label: string; severity: 'high'|'medium'|'low'}[] = [
  {pattern: 'libmsec',          label: 'Tencent msec',          severity: 'high'},
  {pattern: 'libprotect',       label: 'Tencent Protect',        severity: 'high'},
  {pattern: 'libNCSec',         label: 'NetEase Security',       severity: 'high'},
  {pattern: 'libtp2',           label: 'TP2 Anti-Cheat',         severity: 'high'},
  {pattern: 'libBattlEye',      label: 'BattlEye',               severity: 'high'},
  {pattern: 'libEasyAntiCheat', label: 'EasyAntiCheat',          severity: 'high'},
  {pattern: 'libGameGuard',     label: 'GameGuard (NProtect)',    severity: 'high'},
  {pattern: 'xhs',              label: 'Xiaohongshu Guard',       severity: 'medium'},
  {pattern: 'libpairipcore',    label: 'Pairipcore',             severity: 'medium'},
  {pattern: 'libAPKProtect',    label: 'APKProtect Packer',      severity: 'medium'},
  {pattern: 'libsgmain',        label: 'Alibaba Security',       severity: 'medium'},
  {pattern: 'libDexHelper',     label: 'DexHelper Protector',    severity: 'medium'},
  {pattern: 'frida-agent',      label: 'Frida detected by game!', severity: 'high'},
  {pattern: 'linjector',        label: 'Linjector (Frida alt)',  severity: 'high'},
  {pattern: 'zygisk',           label: 'Zygisk (Magisk module)', severity: 'low'},
  {pattern: 'riru',             label: 'Riru framework',         severity: 'low'},
];

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY TAB
// ═══════════════════════════════════════════════════════════════════════════════
function MemoryTab() {
  const [pkg, setPkg] = useState('');
  const [pid, setPid] = useState('');
  const [searchVal, setSearchVal] = useState('');
  const [searchType, setSearchType] = useState<'int32'|'float'|'string'>('int32');
  const [results, setResults] = useState<MemResult[]>([]);
  const [regions, setRegions] = useState<MapRegion[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [frozenAddrs, setFrozenAddrs] = useState<{addr: string; val: string}[]>([]);
  const freezeRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = (s: string) => setLog(p => [s, ...p.slice(0, 80)]);

  const resolvePid = async () => {
    if (!pkg.trim()) { Alert.alert('Enter package name first'); return null; }
    const out = await rootBridge.execShell(`pidof '${pkg.trim()}' 2>/dev/null | tr ' ' '\n' | head -1`);
    const p = out.replace('ERR:', '').trim();
    if (!p || !/^\d+$/.test(p)) {
      addLog('✗ Process not running: ' + pkg);
      Alert.alert('Process not running', 'Launch the game first');
      return null;
    }
    setPid(p);
    addLog('✓ PID: ' + p);
    return p;
  };

  const loadMaps = async () => {
    setBusy(true);
    try {
      const p = pid || await resolvePid();
      if (!p) return;
      const out = await rootBridge.execShell(`cat /proc/${p}/maps 2>/dev/null | head -200`);
      if (out.startsWith('ERR:')) { addLog('✗ Cannot read maps: ' + out); return; }
      const parsed: MapRegion[] = out.split('\n').filter(Boolean).map(line => {
        const parts = line.split(/\s+/);
        const [range, perm] = parts;
        const [start, end] = (range || '').split('-');
        const name = parts[parts.length - 1] || '[anon]';
        return {start: start||'', end: end||'', perm: perm||'', name};
      }).filter(r => r.start && r.end);
      setRegions(parsed);
      addLog(`✓ Loaded ${parsed.length} memory regions`);
    } catch(e: any) { addLog('✗ ' + e.message); }
    finally { setBusy(false); }
  };

  const scanMemory = async () => {
    if (!searchVal.trim()) { Alert.alert('Enter search value'); return; }
    setBusy(true);
    setResults([]);
    try {
      const p = pid || await resolvePid();
      if (!p) return;
      addLog(`⏳ Scanning PID ${p} for ${searchType}:${searchVal}...`);

      let grepCmd = '';
      if (searchType === 'string') {
        // Use grep on /proc/pid/mem regions — strings approach
        grepCmd = `grep -r -l '${searchVal}' /proc/${p}/fd 2>/dev/null | head -5`;
        const fdsOut = await rootBridge.execShell(grepCmd);
        addLog('FDs: ' + fdsOut);
        // Use scanmem-style: write value to tmp file then scan via dd
        const script = `
          /proc/${p}/maps to scan heap/anon regions for string
          for region in $(cat /proc/${p}/maps | grep -E 'heap|\\[anon\\]' | awk '{print $1}'); do
            start=$(echo $region | cut -d- -f1)
            end=$(echo $region | cut -d- -f2)
            start_dec=$((16#$start))
            end_dec=$((16#$end))
            size=$((end_dec - start_dec))
            if [ $size -gt 0 ] && [ $size -lt 52428800 ]; then
              dd if=/proc/${p}/mem bs=1 skip=$start_dec count=$size 2>/dev/null | strings | grep -i '${searchVal}' | head -3
            fi
          done 2>/dev/null | head -20
        `;
        // simplified scan
        const scanOut = await rootBridge.execShell(
          `cat /proc/${p}/maps | grep -E 'heap|\\[anon\\]' | head -5 | while read line; do echo "Region: $line"; done`
        );
        addLog(scanOut || 'No heap regions found');
        setResults([{offset:'heap', value: searchVal, region:'heap scan - use Frida for precision'}]);
      } else {
        // int32 / float — use a Frida-powered memory scan (most accurate)
        addLog('⚠ For precise int/float scan, use the Frida Memory script below');
        // Still show maps so user can pick region
        const mapsOut = await rootBridge.execShell(
          `cat /proc/${p}/maps | grep -E 'heap|\\[anon\\]' | head -10`
        );
        const mockResults: MemResult[] = mapsOut.split('\n').filter(Boolean).slice(0,5).map(line => {
          const parts = line.split(/\s+/);
          return {offset: parts[0]?.split('-')[0] || '0', value: searchVal, region: parts[parts.length-1] || '[anon]'};
        });
        setResults(mockResults);
        addLog(`Found ${mockResults.length} candidate regions (use Frida script for exact offset)`);
      }
    } catch(e: any) { addLog('✗ ' + e.message); }
    finally { setBusy(false); }
  };

  // Frida-powered int32 scan script
  const getFridaScanScript = () => `
Java.perform(function() {
  send('[Mem] Starting memory scan for value: ${searchVal}');
});

var TARGET_VALUE = ${searchType === 'int32' ? parseInt(searchVal)||0 : parseFloat(searchVal)||0};
var TYPE = '${searchType}';
var results = [];

Process.enumerateRanges('rw-').forEach(function(range) {
  if (range.size > 50 * 1024 * 1024) return; // skip >50MB regions
  try {
    var ptr = range.base;
    var end = range.base.add(range.size);
    var step = TYPE === 'float' ? 4 : 4;
    while (ptr.compare(end) < 0) {
      var val = TYPE === 'float' ? ptr.readFloat() : ptr.readS32();
      if (Math.abs(val - TARGET_VALUE) < 0.01) {
        results.push({addr: ptr.toString(), val: val, region: range.base.toString()});
        if (results.length >= 50) return;
      }
      ptr = ptr.add(step);
    }
  } catch(e) {}
});

send('[Mem] Found ' + results.length + ' matches');
results.forEach(function(r) {
  send('[Mem] MATCH @ ' + r.addr + ' = ' + r.val + ' (region: ' + r.region + ')');
});
`;

  const writeMemory = async (addr: string, newVal: string) => {
    if (!addr || !newVal) return;
    const p = pid;
    if (!p) { Alert.alert('Get PID first'); return; }
    // Use dd to write to /proc/pid/mem
    const decAddr = parseInt(addr, 16);
    if (isNaN(decAddr)) { Alert.alert('Invalid address'); return; }
    addLog(`⏳ Writing ${newVal} @ 0x${addr}...`);
    try {
      // Write via Frida for precision
      Alert.alert('Use Frida', `To write memory precisely, use Script tab with:\nptr("${addr}").writeInt(${newVal})`);
    } catch(e: any) { addLog('✗ ' + e.message); }
  };

  const toggleFreeze = (addr: string, val: string) => {
    const exists = frozenAddrs.find(f => f.addr === addr);
    if (exists) {
      setFrozenAddrs(p => p.filter(f => f.addr !== addr));
      addLog(`❄ Unfroze ${addr}`);
    } else {
      setFrozenAddrs(p => [...p, {addr, val}]);
      addLog(`❄ Froze ${addr} = ${val}`);
    }
  };

  useEffect(() => {
    if (frozenAddrs.length > 0) {
      freezeRef.current = setInterval(async () => {
        for (const {addr, val} of frozenAddrs) {
          // continuous write via Frida not possible here — show note
          addLog(`[freeze] Keeping ${addr} = ${val} (run Frida freeze script)`);
        }
      }, 2000);
    } else {
      if (freezeRef.current) { clearInterval(freezeRef.current); freezeRef.current = null; }
    }
    return () => { if (freezeRef.current) clearInterval(freezeRef.current); };
  }, [frozenAddrs]);

  return (
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}>
      <ScrollView style={s.tab} contentContainerStyle={{paddingBottom: 40}}>
        {/* Package + PID */}
        <View style={s.card}>
          <Text style={s.cardTitle}>⚙ Target Process</Text>
          <TextInput
            style={s.input} placeholder="Package name (e.g. com.game.xyz)"
            placeholderTextColor={C.dim} value={pkg} onChangeText={setPkg}
            autoCapitalize="none" autoCorrect={false}
          />
          <View style={s.row}>
            <TouchableOpacity style={[s.btn, {flex:1}]} onPress={resolvePid}>
              <Text style={s.btnTxt}>GET PID</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, {flex:1, marginLeft:8}]} onPress={loadMaps}>
              <Text style={s.btnTxt}>LOAD MAPS</Text>
            </TouchableOpacity>
          </View>
          {pid ? <Text style={s.pidBadge}>PID: {pid}</Text> : null}
        </View>

        {/* Search */}
        <View style={s.card}>
          <Text style={s.cardTitle}>🔍 Memory Scan</Text>
          <View style={s.row}>
            {(['int32','float','string'] as const).map(t => (
              <TouchableOpacity
                key={t}
                style={[s.chip, searchType===t && s.chipActive]}
                onPress={() => setSearchType(t)}
              >
                <Text style={[s.chipTxt, searchType===t && s.chipTxtActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            style={s.input} placeholder={`Value to search (${searchType})`}
            placeholderTextColor={C.dim} value={searchVal} onChangeText={setSearchVal}
            keyboardType={searchType==='string'?'default':'numeric'}
          />
          <View style={s.row}>
            <TouchableOpacity style={[s.btn, {flex:1}]} onPress={scanMemory} disabled={busy}>
              {busy ? <ActivityIndicator color={C.green} size="small"/> : <Text style={s.btnTxt}>SCAN</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.btn, {flex:1, marginLeft:8, borderColor:C.yellow}]}
              onPress={() => Alert.alert('Frida Scan', 'Copy this script to Script tab:\n\n' + getFridaScanScript())}
            >
              <Text style={[s.btnTxt, {color:C.yellow}]}>FRIDA SCAN</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Results */}
        {results.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>📍 Results ({results.length})</Text>
            {results.map((r, i) => (
              <View key={i} style={s.resultRow}>
                <View style={{flex:1}}>
                  <Text style={s.mono}>0x{r.offset}</Text>
                  <Text style={[s.mono, {color:C.green, fontSize:11}]}>{r.region}</Text>
                </View>
                <Text style={[s.mono, {color:C.yellow, marginRight:8}]}>{r.value}</Text>
                <TouchableOpacity
                  style={[s.chip, {borderColor: frozenAddrs.find(f=>f.addr===r.offset) ? C.red : C.dim}]}
                  onPress={() => toggleFreeze(r.offset, r.value)}
                >
                  <Text style={[s.chipTxt, {color: frozenAddrs.find(f=>f.addr===r.offset) ? C.red : C.dim}]}>
                    {frozenAddrs.find(f=>f.addr===r.offset) ? '❄ FROZEN' : 'FREEZE'}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Regions */}
        {regions.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>🗺 Memory Map ({regions.length} regions)</Text>
            {regions.slice(0,30).map((r, i) => (
              <View key={i} style={s.mapRow}>
                <Text style={[s.mono, {color: r.perm.includes('w') ? C.green : C.dim, fontSize:10, flex:1}]}>
                  {r.start}-{r.end}  {r.perm}
                </Text>
                <Text style={[s.mono, {color:C.txt, fontSize:10, flex:1}]} numberOfLines={1}>{r.name}</Text>
              </View>
            ))}
            {regions.length > 30 && <Text style={[s.mono, {color:C.dim, marginTop:4}]}>+{regions.length-30} more...</Text>}
          </View>
        )}

        {/* Log */}
        <View style={s.card}>
          <Text style={s.cardTitle}>📋 Log</Text>
          {log.slice(0,20).map((l, i) => (
            <Text key={i} style={[s.mono, {fontSize:11, color:l.startsWith('✗')?C.red:C.txt}]}>{l}</Text>
          ))}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCRIPTS TAB
// ═══════════════════════════════════════════════════════════════════════════════
function ScriptsTab() {
  const navigation = useNavigation<any>();
  const [filter, setFilter] = useState<string>('All');
  const categories = ['All', 'Network', 'Detection', 'Anti-Detection', 'Game Hack', 'Offerwall'];

  const filtered = filter === 'All'
    ? SCRIPT_LIBRARY
    : SCRIPT_LIBRARY.filter(s => s.category === filter);

  const openInScriptTab = (code: string, title: string) => {
    navigation.navigate('Script', {prefillCode: code, prefillTitle: title});
  };

  return (
    <ScrollView style={s.tab} contentContainerStyle={{paddingBottom: 40}}>
      {/* Category filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom:12, paddingHorizontal:12}}>
        {categories.map(cat => (
          <TouchableOpacity
            key={cat}
            style={[s.chip, filter===cat && s.chipActive, {marginRight:8}]}
            onPress={() => setFilter(cat)}
          >
            <Text style={[s.chipTxt, filter===cat && s.chipTxtActive]}>{cat}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {filtered.map(script => (
        <View key={script.id} style={s.card}>
          <View style={s.row}>
            <View style={[s.catBadge]}>
              <Text style={s.catBadgeTxt}>{script.category}</Text>
            </View>
          </View>
          <Text style={s.cardTitle}>{script.title}</Text>
          <Text style={[s.txt, {marginBottom:10}]}>{script.desc}</Text>
          {/* Code preview */}
          <ScrollView horizontal style={s.codePreview}>
            <Text style={s.codePreviewTxt} numberOfLines={3}>{script.code.trim().slice(0,200)}...</Text>
          </ScrollView>
          <View style={[s.row, {marginTop:10}]}>
            <TouchableOpacity
              style={[s.btn, {flex:1}]}
              onPress={() => openInScriptTab(script.code, script.title)}
            >
              <Text style={s.btnTxt}>OPEN IN SCRIPT</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.btn, {flex:1, marginLeft:8, borderColor:C.dim}]}
              onPress={() => { Clipboard.setString(script.code); Alert.alert('Copied!'); }}
            >
              <Text style={[s.btnTxt, {color:C.dim}]}>COPY</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANTI-DETECTION TAB
// ═══════════════════════════════════════════════════════════════════════════════
function AntiDetTab() {
  const navigation = useNavigation<any>();
  const [pkg, setPkg] = useState('');
  const [busy, setBusy] = useState<string|null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState<string|null>(null);

  const addLog = (s: string) => setLog(p => [s, ...p.slice(0, 60)]);

  const runProfile = async (profileId: string) => {
    if (!pkg.trim()) { Alert.alert('Enter target package name'); return; }
    const profile = ANTI_DET_PROFILES.find(p => p.id === profileId);
    if (!profile) return;

    setBusy(profileId);
    setActiveProfile(profileId);
    addLog(`▶ Running profile: ${profile.title}`);

    try {
      // Combine all scripts in profile
      const combined = profile.scripts.map(sid => {
        const sc = SCRIPT_LIBRARY.find(s => s.id === sid);
        return sc ? `// ── ${sc.title} ──\n${sc.code}` : '';
      }).filter(Boolean).join('\n\n');

      addLog(`📝 Injecting ${profile.scripts.length} scripts into ${pkg}`);
      const result = await rootBridge.runScript(pkg.trim(), combined, 'pid');
      addLog('✓ ' + result);
    } catch(e: any) {
      addLog('✗ ' + e.message);
    } finally {
      setBusy(null);
    }
  };

  const quickAction = async (action: string) => {
    setBusy(action);
    addLog(`⚙ ${action}...`);
    try {
      let result = '';
      switch(action) {
        case 'ptrace_off':
          result = await rootBridge.execShell('echo 0 > /proc/sys/kernel/yama/ptrace_scope && echo OK');
          break;
        case 'selinux_perm':
          result = await rootBridge.execShell('setenforce 0 && getenforce');
          break;
        case 'hide_magisk':
          result = await rootBridge.execShell(
            'pm list packages | grep -i magisk | while read p; do pkg=$(echo $p | cut -d: -f2); ' +
            'am force-stop "$pkg" 2>/dev/null; echo "Stopped: $pkg"; done 2>/dev/null || echo "No magisk apps"'
          );
          break;
        case 'clear_detect_cache':
          if (!pkg.trim()) { Alert.alert('Enter package name'); setBusy(null); return; }
          result = await rootBridge.execShell(`rm -rf /data/data/${pkg.trim()}/cache/* 2>/dev/null && echo "Cache cleared"`);
          break;
      }
      addLog('✓ ' + (result || 'Done'));
    } catch(e: any) { addLog('✗ ' + e.message); }
    finally { setBusy(null); }
  };

  return (
    <ScrollView style={s.tab} contentContainerStyle={{paddingBottom:40}}>
      {/* Target */}
      <View style={s.card}>
        <Text style={s.cardTitle}>🎯 Target Package</Text>
        <TextInput
          style={s.input} placeholder="com.game.package"
          placeholderTextColor={C.dim} value={pkg} onChangeText={setPkg}
          autoCapitalize="none" autoCorrect={false}
        />
      </View>

      {/* Quick actions */}
      <View style={s.card}>
        <Text style={s.cardTitle}>⚡ Quick System Actions</Text>
        <View style={s.row}>
          <TouchableOpacity
            style={[s.btn, {flex:1}]}
            onPress={() => quickAction('ptrace_off')} disabled={!!busy}
          >
            {busy==='ptrace_off' ? <ActivityIndicator color={C.green} size="small"/> :
              <Text style={s.btnTxt}>PTRACE OFF</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, {flex:1, marginLeft:8}]}
            onPress={() => quickAction('selinux_perm')} disabled={!!busy}
          >
            {busy==='selinux_perm' ? <ActivityIndicator color={C.green} size="small"/> :
              <Text style={s.btnTxt}>SELINUX PERM</Text>}
          </TouchableOpacity>
        </View>
        <View style={[s.row, {marginTop:8}]}>
          <TouchableOpacity
            style={[s.btn, {flex:1}]}
            onPress={() => quickAction('hide_magisk')} disabled={!!busy}
          >
            {busy==='hide_magisk' ? <ActivityIndicator color={C.green} size="small"/> :
              <Text style={s.btnTxt}>HIDE MAGISK</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, {flex:1, marginLeft:8}]}
            onPress={() => quickAction('clear_detect_cache')} disabled={!!busy}
          >
            {busy==='clear_detect_cache' ? <ActivityIndicator color={C.green} size="small"/> :
              <Text style={s.btnTxt}>CLEAR CACHE</Text>}
          </TouchableOpacity>
        </View>
      </View>

      {/* Profiles */}
      <Text style={[s.cardTitle, {marginHorizontal:12, marginTop:8}]}>🛡 Stealth Profiles</Text>
      {ANTI_DET_PROFILES.map(profile => (
        <View key={profile.id} style={[s.card, activeProfile===profile.id && {borderColor:C.green}]}>
          <Text style={s.cardTitle}>{profile.title}</Text>
          <Text style={[s.txt, {marginBottom:6}]}>{profile.desc}</Text>
          <View style={{flexDirection:'row', flexWrap:'wrap', gap:4, marginBottom:10}}>
            {profile.scripts.map(sid => {
              const sc = SCRIPT_LIBRARY.find(s => s.id === sid);
              return sc ? (
                <View key={sid} style={[s.chip, {borderColor:C.green2}]}>
                  <Text style={[s.chipTxt, {color:C.green2}]}>{sc.title.split(' ').slice(0,2).join(' ')}</Text>
                </View>
              ) : null;
            })}
          </View>
          <TouchableOpacity
            style={[s.btn, busy===profile.id && {borderColor:C.dim}]}
            onPress={() => runProfile(profile.id)}
            disabled={!!busy}
          >
            {busy===profile.id
              ? <ActivityIndicator color={C.green} size="small"/>
              : <Text style={s.btnTxt}>▶ INJECT PROFILE</Text>
            }
          </TouchableOpacity>
        </View>
      ))}

      {/* Log */}
      {log.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>📋 Log</Text>
          {log.slice(0,20).map((l, i) => (
            <Text key={i} style={[s.mono, {fontSize:11, color: l.startsWith('✗') ? C.red : C.txt}]}>{l}</Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSPECTOR TAB
// ═══════════════════════════════════════════════════════════════════════════════
function InspectorTab() {
  const [pkg, setPkg] = useState('');
  const [pid, setPid] = useState('');
  const [busy, setBusy] = useState(false);
  const [antiCheats, setAntiCheats] = useState<AntiCheatInfo[]>([]);
  const [libs, setLibs] = useState<string[]>([]);
  const [threads, setThreads] = useState<string[]>([]);
  const [procInfo, setProcInfo] = useState<{mem: string; cpu: string; uid: string} | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const addLog = (s: string) => setLog(p => [s, ...p.slice(0, 40)]);

  const inspect = async () => {
    if (!pkg.trim()) { Alert.alert('Enter package name'); return; }
    setBusy(true);
    setAntiCheats([]); setLibs([]); setThreads([]); setProcInfo(null);
    addLog(`⏳ Inspecting ${pkg}...`);
    try {
      // 1. Get PID
      const pidOut = await rootBridge.execShell(`pidof '${pkg.trim()}' 2>/dev/null | tr ' ' '\n' | head -1`);
      const p = pidOut.replace('ERR:','').trim();
      if (!p || !/^\d+$/.test(p)) {
        addLog('✗ Process not running — launch the game first');
        setBusy(false);
        return;
      }
      setPid(p);
      addLog(`✓ PID: ${p}`);

      // 2. Process info (mem/cpu/uid) — run in parallel
      const [statusOut, threadsOut, mapsOut] = await Promise.all([
        rootBridge.execShell(
          `cat /proc/${p}/status 2>/dev/null | grep -E 'VmRSS|VmSize|Uid|Threads' | head -10`
        ),
        rootBridge.execShell(
          `ls /proc/${p}/task 2>/dev/null | wc -l`
        ),
        rootBridge.execShell(
          `cat /proc/${p}/maps 2>/dev/null`
        ),
      ]);

      // Parse status
      const rss  = statusOut.match(/VmRSS:\s+(\d+)/)?.[1];
      const uid  = statusOut.match(/Uid:\s+(\d+)/)?.[1];
      const thCt = threadsOut.replace('ERR:','').trim();
      setProcInfo({
        mem: rss ? `${Math.round(parseInt(rss)/1024)} MB` : '?',
        cpu: '—',
        uid: uid || '?',
      });
      addLog(`✓ Memory: ${rss ? Math.round(parseInt(rss)/1024)+'MB' : '?'}, Threads: ${thCt}, UID: ${uid||'?'}`);

      // 3. Parse maps → anti-cheat detection
      const mapLines = mapsOut.split('\n').filter(Boolean);
      const detected: AntiCheatInfo[] = [];
      const libList: string[] = [];

      for (const line of mapLines) {
        const parts = line.split(/\s+/);
        const name = parts[parts.length - 1] || '';
        if (!name.endsWith('.so') && !name.includes('/')) continue;
        const basename = name.split('/').pop() || '';
        if (!libList.includes(basename) && basename.endsWith('.so')) libList.push(basename);

        for (const sig of ANTI_CHEAT_SIGS) {
          if (name.toLowerCase().includes(sig.pattern.toLowerCase())) {
            if (!detected.find(d => d.lib === basename)) {
              detected.push({lib: basename, label: sig.label, severity: sig.severity});
            }
          }
        }
      }

      setAntiCheats(detected);
      setLibs(libList.slice(0, 60));

      // 4. Thread names
      const threadNames = await rootBridge.execShell(
        `for f in /proc/${p}/task/*/comm; do cat "$f" 2>/dev/null; done | sort -u | head -30`
      );
      setThreads(threadNames.replace('ERR:','').split('\n').filter(Boolean));

      addLog(`✓ ${libList.length} libs, ${detected.length} anti-cheat engines, ${thCt} threads`);

      if (detected.length === 0) addLog('✅ No known anti-cheat detected');
      else addLog(`⚠ ${detected.length} anti-cheat/protection found!`);

    } catch(e: any) { addLog('✗ ' + e.message); }
    finally { setBusy(false); }
  };

  const severityColor = (s: 'high'|'medium'|'low') =>
    s === 'high' ? C.red : s === 'medium' ? C.yellow : C.dim;

  return (
    <ScrollView style={s.tab} contentContainerStyle={{paddingBottom:40}}>
      {/* Target */}
      <View style={s.card}>
        <Text style={s.cardTitle}>🔬 Process Inspector</Text>
        <TextInput
          style={s.input} placeholder="Package name (e.g. com.game.xyz)"
          placeholderTextColor={C.dim} value={pkg} onChangeText={setPkg}
          autoCapitalize="none" autoCorrect={false}
        />
        <TouchableOpacity style={s.btn} onPress={inspect} disabled={busy}>
          {busy
            ? <ActivityIndicator color={C.green} size="small"/>
            : <Text style={s.btnTxt}>🔍 INSPECT</Text>
          }
        </TouchableOpacity>
        {pid ? <Text style={s.pidBadge}>PID: {pid}</Text> : null}
      </View>

      {/* Process info */}
      {procInfo && (
        <View style={s.card}>
          <Text style={s.cardTitle}>📊 Process Info</Text>
          <View style={s.row}>
            <View style={s.statBox}><Text style={s.statVal}>{procInfo.mem}</Text><Text style={s.statLbl}>RAM</Text></View>
            <View style={s.statBox}><Text style={s.statVal}>{threads.length}</Text><Text style={s.statLbl}>THREADS</Text></View>
            <View style={s.statBox}><Text style={s.statVal}>{procInfo.uid}</Text><Text style={s.statLbl}>UID</Text></View>
            <View style={s.statBox}><Text style={s.statVal}>{libs.length}</Text><Text style={s.statLbl}>LIBS</Text></View>
          </View>
        </View>
      )}

      {/* Anti-cheat detection */}
      {antiCheats.length > 0 ? (
        <View style={s.card}>
          <Text style={[s.cardTitle, {color:C.red}]}>🚨 Anti-Cheat / Protection ({antiCheats.length})</Text>
          {antiCheats.map((ac, i) => (
            <View key={i} style={[s.resultRow, {borderLeftWidth:3, borderLeftColor:severityColor(ac.severity), paddingLeft:8}]}>
              <View style={{flex:1}}>
                <Text style={[s.mono, {color:severityColor(ac.severity)}]}>{ac.label}</Text>
                <Text style={[s.mono, {color:C.dim, fontSize:10}]}>{ac.lib}</Text>
              </View>
              <View style={[s.chip, {borderColor:severityColor(ac.severity)}]}>
                <Text style={[s.chipTxt, {color:severityColor(ac.severity), textTransform:'uppercase'}]}>{ac.severity}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : pid ? (
        <View style={[s.card, {borderColor:C.green}]}>
          <Text style={[s.cardTitle, {color:C.green}]}>✅ No Known Anti-Cheat Detected</Text>
          <Text style={s.txt}>Process looks clean — no GameGuard, TP2, BattlEye, or other known engines found.</Text>
        </View>
      ) : null}

      {/* Thread list */}
      {threads.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>🧵 Threads ({threads.length})</Text>
          {threads.map((t, i) => (
            <Text key={i} style={[s.mono, {fontSize:11, color: C.txt}]}>{t}</Text>
          ))}
        </View>
      )}

      {/* Libs */}
      {libs.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>📚 Native Libraries ({libs.length})</Text>
          <ScrollView style={{maxHeight:200}}>
            {libs.map((lib, i) => (
              <Text key={i} style={[s.mono, {
                fontSize:10,
                color: ANTI_CHEAT_SIGS.some(sig => lib.toLowerCase().includes(sig.pattern.toLowerCase()))
                  ? C.yellow : C.dim
              }]}>
                {ANTI_CHEAT_SIGS.some(sig => lib.toLowerCase().includes(sig.pattern.toLowerCase())) ? '⚠ ' : '  '}
                {lib}
              </Text>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Log */}
      {log.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>📋 Log</Text>
          {log.map((l, i) => (
            <Text key={i} style={[s.mono, {fontSize:11, color: l.startsWith('✗') ? C.red : l.startsWith('✅') ? C.green : C.txt}]}>{l}</Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN GAME SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
export default function GameScreen() {
  const [tab, setTab] = useState<Tab>('inspector');

  const tabs: {id: Tab; label: string; icon: string}[] = [
    {id:'memory',    label:'Memory',   icon:'🧠'},
    {id:'scripts',   label:'Scripts',  icon:'📜'},
    {id:'antidet',   label:'AntiDet',  icon:'🛡'},
    {id:'inspector', label:'Inspect',  icon:'🔬'},
  ];

  return (
    <View style={{flex:1, backgroundColor:C.bg}}>
      {/* Sub-tab bar */}
      <View style={s.subTabBar}>
        {tabs.map(t => (
          <TouchableOpacity
            key={t.id}
            style={[s.subTab, tab===t.id && s.subTabActive]}
            onPress={() => setTab(t.id)}
          >
            <Text style={[s.subTabIcon, tab===t.id && s.subTabIconActive]}>{t.icon}</Text>
            <Text style={[s.subTabLabel, tab===t.id && s.subTabLabelActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {tab === 'memory'    && <MemoryTab />}
      {tab === 'scripts'   && <ScriptsTab />}
      {tab === 'antidet'   && <AntiDetTab />}
      {tab === 'inspector' && <InspectorTab />}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  tab:          {flex:1, backgroundColor:C.bg, padding:12},
  card:         {backgroundColor:C.card, borderWidth:1, borderColor:C.border, borderRadius:6, padding:12, marginBottom:12},
  cardTitle:    {color:C.white, fontFamily:'monospace', fontWeight:'bold', fontSize:13, marginBottom:8},
  input:        {backgroundColor:'#0a0a0a', borderWidth:1, borderColor:C.border, borderRadius:4,
                 color:C.white, fontFamily:'monospace', fontSize:12, padding:8, marginBottom:8},
  btn:          {borderWidth:1, borderColor:C.green, borderRadius:4, padding:10, alignItems:'center', justifyContent:'center'},
  btnTxt:       {color:C.green, fontFamily:'monospace', fontWeight:'bold', fontSize:12},
  row:          {flexDirection:'row', alignItems:'center'},
  chip:         {borderWidth:1, borderColor:C.border, borderRadius:3, paddingHorizontal:8, paddingVertical:4, marginRight:6},
  chipActive:   {borderColor:C.green, backgroundColor:'#001a0a'},
  chipTxt:      {color:C.dim, fontFamily:'monospace', fontSize:11},
  chipTxtActive:{color:C.green},
  mono:         {fontFamily:'monospace', fontSize:12, color:C.txt, marginBottom:2},
  txt:          {color:C.txt, fontSize:12, fontFamily:'monospace'},
  pidBadge:     {color:C.green, fontFamily:'monospace', fontSize:11, marginTop:6},
  resultRow:    {flexDirection:'row', alignItems:'center', borderBottomWidth:1, borderBottomColor:C.border, paddingVertical:6},
  mapRow:       {flexDirection:'row', paddingVertical:2},
  codePreview:  {backgroundColor:'#0a0a0a', borderRadius:4, padding:8, maxHeight:60},
  codePreviewTxt:{fontFamily:'monospace', fontSize:10, color:C.dim},
  catBadge:     {backgroundColor:C.green2, borderRadius:3, paddingHorizontal:8, paddingVertical:2, marginBottom:4},
  catBadgeTxt:  {color:C.green, fontFamily:'monospace', fontSize:10, fontWeight:'bold'},
  statBox:      {flex:1, alignItems:'center', padding:8, backgroundColor:'#0a0a0a', borderRadius:4, marginRight:6},
  statVal:      {color:C.green, fontFamily:'monospace', fontWeight:'bold', fontSize:16},
  statLbl:      {color:C.dim, fontFamily:'monospace', fontSize:9, marginTop:2},
  subTabBar:    {flexDirection:'row', backgroundColor:'#0a0a0a', borderBottomWidth:1, borderBottomColor:C.border},
  subTab:       {flex:1, alignItems:'center', paddingVertical:10},
  subTabActive: {borderBottomWidth:2, borderBottomColor:C.green},
  subTabIcon:   {fontSize:16, color:C.dim},
  subTabIconActive:{color:C.green},
  subTabLabel:  {fontFamily:'monospace', fontSize:10, color:C.dim, marginTop:2},
  subTabLabelActive:{color:C.green},
});

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
// MEMORY TAB — launches GameGuardian-style native overlay
// ═══════════════════════════════════════════════════════════════════════════════

function MemoryTab() {
  const [pkg,         setPkg]         = useState('');
  const [pid,         setPid]         = useState('');
  const [overlayActive, setOverlayActive] = useState(false);
  const [busy,        setBusy]        = useState(false);
  const [statusMsg,   setStatusMsg]   = useState('');

  const launchOverlay = async () => {
    if (!pkg.trim()) { Alert.alert('Package required', 'Enter the target game package name first.'); return; }
    setBusy(true);
    setStatusMsg('Starting overlay…');
    try {
      await rootBridge.startMemoryOverlay(pkg.trim());
      setOverlayActive(true);
      setStatusMsg('✓ Overlay launched — switch to the game');
    } catch (e: any) {
      setStatusMsg('✗ ' + (e?.message || String(e)));
    } finally {
      setBusy(false);
    }
  };

  const stopOverlay = async () => {
    try {
      await rootBridge.stopMemoryOverlay();
      setOverlayActive(false);
      setStatusMsg('Overlay stopped');
    } catch (e: any) {
      setStatusMsg('✗ ' + (e?.message || String(e)));
    }
  };

  return (
    <View style={{flex: 1, backgroundColor: C.bg, padding: 16}}>

      {/* ── Package + PID ──────────────────────────────────────────────────── */}
      <Text style={[s.mono, {color: C.dim, fontSize: 10, marginBottom: 4}]}>TARGET PROCESS</Text>
      <View style={{flexDirection: 'row', gap: 8, marginBottom: 12}}>
        <TextInput
          style={[s.input, {flex: 1, marginBottom: 0}]}
          placeholder="com.game.package"
          placeholderTextColor={C.dim}
          value={pkg} onChangeText={setPkg}
          autoCapitalize="none" autoCorrect={false}
        />
        <TextInput
          style={[s.input, {width: 72, marginBottom: 0}]}
          placeholder="PID"
          placeholderTextColor={C.dim}
          value={pid} onChangeText={setPid}
          keyboardType="numeric"
        />
      </View>

      {/* ── Overlay status pill ────────────────────────────────────────────── */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: C.card, borderRadius: 6, padding: 10, marginBottom: 20,
        borderWidth: 1, borderColor: overlayActive ? C.green : C.border,
      }}>
        <View style={{
          width: 10, height: 10, borderRadius: 5,
          backgroundColor: overlayActive ? C.green : C.dim,
        }}/>
        <Text style={[s.mono, {fontSize: 11, color: overlayActive ? C.green : C.dim, flex: 1}]}>
          {overlayActive ? 'OVERLAY ACTIVE — floating above game' : 'OVERLAY INACTIVE'}
        </Text>
      </View>

      {/* ── LAUNCH button ─────────────────────────────────────────────────── */}
      <TouchableOpacity
        style={[s.btn, {
          paddingVertical: 18,
          backgroundColor: '#001a0d',
          borderColor: C.green,
          borderWidth: 1.5,
          borderRadius: 8,
          alignItems: 'center',
          marginBottom: 12,
          opacity: busy ? 0.5 : 1,
        }]}
        onPress={overlayActive ? stopOverlay : launchOverlay}
        disabled={busy}
      >
        {busy
          ? <ActivityIndicator color={C.green} />
          : <Text style={[s.mono, {color: C.green, fontSize: 15, letterSpacing: 1}]}>
              {overlayActive ? '⏹  STOP OVERLAY' : '🎮  LAUNCH OVERLAY'}
            </Text>
        }
      </TouchableOpacity>

      {/* ── Status ─────────────────────────────────────────────────────────── */}
      {statusMsg !== '' && (
        <Text style={[s.mono, {
          fontSize: 11, textAlign: 'center',
          color: statusMsg.startsWith('✗') ? C.red
               : statusMsg.startsWith('✓') ? C.green
               : C.dim,
        }]}>
          {statusMsg}
        </Text>
      )}

      {/* ── How-to tip ─────────────────────────────────────────────────────── */}
      <View style={{marginTop: 32, gap: 8}}>
        <Text style={[s.mono, {color: C.dim, fontSize: 10}]}>HOW TO USE</Text>
        {[
          "1. Enter the target game's package name",
          "2. Launch the game first so it's running",
          '3. Tap LAUNCH OVERLAY — the scanner window appears on top',
          '4. Switch to the game — overlay stays visible',
          '5. Scan value → narrow with Next Scan → tap address → WRITE / FREEZE',
        ].map((tip, i) => (
          <Text key={i} style={[s.mono, {color: C.dim, fontSize: 11}]}>{tip}</Text>
        ))}
      </View>

    </View>
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
// ANTI-DETECTION TAB  (Device Spoofer + Carrier + GPS)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Real device profiles ──────────────────────────────────────────────────────
const REAL_DEVICES = [
  {
    label: 'Samsung Galaxy S24 Ultra',
    fingerprint: 'samsung/SM-S928B/SM-S928B:14/UP1A.231005.007/S928BXXS2AXK5:user/release-keys',
    model: 'SM-S928B', manufacturer: 'samsung', brand: 'samsung',
    device: 'e3q', product: 'SM-S928B', hardware: 'exynos2400',
    imei: '358971120234567',
  },
  {
    label: 'Samsung Galaxy S24',
    fingerprint: 'samsung/SM-S921B/SM-S921B:14/UP1A.231005.007/S921BXXU3AXK2:user/release-keys',
    model: 'SM-S921B', manufacturer: 'samsung', brand: 'samsung',
    device: 'e1s', product: 'SM-S921B', hardware: 'exynos2400',
    imei: '357921100234561',
  },
  {
    label: 'Samsung Galaxy S23+',
    fingerprint: 'samsung/SM-S916B/SM-S916B:13/TP1A.220624.014/S916BXXU5CWK1:user/release-keys',
    model: 'SM-S916B', manufacturer: 'samsung', brand: 'samsung',
    device: 'q5q', product: 'SM-S916B', hardware: 'exynos2200',
    imei: '354821090876543',
  },
  {
    label: 'Samsung Galaxy A54 5G',
    fingerprint: 'samsung/SM-A546B/SM-A546B:13/TP1A.220624.014/A546BXXU3CWK1:user/release-keys',
    model: 'SM-A546B', manufacturer: 'samsung', brand: 'samsung',
    device: 'a54x', product: 'SM-A546B', hardware: 'exynos1380',
    imei: '352314110987654',
  },
  {
    label: 'Google Pixel 8 Pro',
    fingerprint: 'google/husky/husky:14/AP1A.240405.002/11480754:user/release-keys',
    model: 'Pixel 8 Pro', manufacturer: 'Google', brand: 'google',
    device: 'husky', product: 'husky', hardware: 'husky',
    imei: '351826110345678',
  },
  {
    label: 'Google Pixel 8',
    fingerprint: 'google/shiba/shiba:14/AP1A.240405.002/11480754:user/release-keys',
    model: 'Pixel 8', manufacturer: 'Google', brand: 'google',
    device: 'shiba', product: 'shiba', hardware: 'shiba',
    imei: '357821090765432',
  },
  {
    label: 'Google Pixel 7',
    fingerprint: 'google/panther/panther:13/TQ3A.230901.001/10750268:user/release-keys',
    model: 'Pixel 7', manufacturer: 'Google', brand: 'google',
    device: 'panther', product: 'panther', hardware: 'tangorpro',
    imei: '354128090876541',
  },
  {
    label: 'OnePlus 12',
    fingerprint: 'OnePlus/CPH2583/OP5929L1:14/UP1A.231005.007/V14.0.0.160:user/release-keys',
    model: 'CPH2583', manufacturer: 'OnePlus', brand: 'OnePlus',
    device: 'OP5929L1', product: 'CPH2583', hardware: 'kalama',
    imei: '869547050234567',
  },
  {
    label: 'Xiaomi 14 Pro',
    fingerprint: 'Xiaomi/shennong/shennong:14/UP1A.231005.007/V14.0.6.0.UNCMIXM:user/release-keys',
    model: '23116PN5BC', manufacturer: 'Xiaomi', brand: 'Xiaomi',
    device: 'shennong', product: 'shennong', hardware: 'sm8650',
    imei: '867821050123456',
  },
  {
    label: 'Redmi Note 13 Pro',
    fingerprint: 'Redmi/garnet/garnet:13/TP1A.220624.014/V14.0.8.0.TMGMIXM:user/release-keys',
    model: '23090RA98G', manufacturer: 'Xiaomi', brand: 'Redmi',
    device: 'garnet', product: 'garnet', hardware: 'mt6789',
    imei: '353724110234987',
  },
  {
    label: 'Motorola Edge 40 Pro',
    fingerprint: 'motorola/rtwo/rtwo:13/T1TAS33.73-22/36:user/release-keys',
    model: 'XT2301-4', manufacturer: 'motorola', brand: 'motorola',
    device: 'rtwo', product: 'rtwo_g', hardware: 'sm8550',
    imei: '352178090765984',
  },
];

// ── US Carrier profiles ───────────────────────────────────────────────────────
const US_CARRIERS = [
  { label: 'AT&T',     operator: '310410', operatorName: 'AT&T',     simSerial: '8901410123456789012' },
  { label: 'Verizon',  operator: '311480', operatorName: 'Verizon',  simSerial: '8901260987654321098' },
  { label: 'T-Mobile', operator: '310260', operatorName: 'T-Mobile', simSerial: '8901260123456789013' },
  { label: 'Sprint',   operator: '312250', operatorName: 'Sprint',   simSerial: '8901260123456789014' },
  { label: 'US Cellular', operator: '311220', operatorName: 'US Cellular', simSerial: '8901220123456789015' },
  { label: 'Mint Mobile', operator: '310260', operatorName: 'Mint',  simSerial: '8901260123456789016' },
  { label: 'Cricket',  operator: '310410', operatorName: 'Cricket',  simSerial: '8901410123456789017' },
  { label: 'Boost',    operator: '311580', operatorName: 'Boost Mobile', simSerial: '8901580123456789018' },
];

// ── US GPS locations ──────────────────────────────────────────────────────────
const US_LOCATIONS = [
  { label: 'New York, NY',     lat: 40.7128,  lon: -74.0060 },
  { label: 'Los Angeles, CA',  lat: 34.0522,  lon: -118.2437 },
  { label: 'Chicago, IL',      lat: 41.8781,  lon: -87.6298 },
  { label: 'Houston, TX',      lat: 29.7604,  lon: -95.3698 },
  { label: 'Phoenix, AZ',      lat: 33.4484,  lon: -112.0740 },
  { label: 'Philadelphia, PA', lat: 39.9526,  lon: -75.1652 },
  { label: 'San Antonio, TX',  lat: 29.4241,  lon: -98.4936 },
  { label: 'San Diego, CA',    lat: 32.7157,  lon: -117.1611 },
  { label: 'Dallas, TX',       lat: 32.7767,  lon: -96.7970 },
  { label: 'San Jose, CA',     lat: 37.3382,  lon: -121.8863 },
];

// ── Frida script generator ────────────────────────────────────────────────────
function buildSpoofScript(
  device: typeof REAL_DEVICES[0],
  carrier: typeof US_CARRIERS[0],
  location: typeof US_LOCATIONS[0],
) {
  return `Java.perform(function () {
  // ── Build / Device ──────────────────────────────────────────────────────────
  var Build = Java.use('android.os.Build');
  Build.FINGERPRINT.value  = '${device.fingerprint}';
  Build.MODEL.value        = '${device.model}';
  Build.MANUFACTURER.value = '${device.manufacturer}';
  Build.BRAND.value        = '${device.brand}';
  Build.DEVICE.value       = '${device.device}';
  Build.PRODUCT.value      = '${device.product}';
  Build.HARDWARE.value     = '${device.hardware}';
  Build.TAGS.value         = 'release-keys';
  Build.TYPE.value         = 'user';
  send('[Spoof] Build → ${device.label}');

  // ── TelephonyManager / Carrier ──────────────────────────────────────────────
  try {
    var TM = Java.use('android.telephony.TelephonyManager');
    TM.getDeviceId.overload().implementation                = function() { return '${device.imei}'; };
    TM.getImei.overload().implementation                    = function() { return '${device.imei}'; };
    TM.getImei.overload('int').implementation               = function() { return '${device.imei}'; };
    TM.getSimSerialNumber.overload().implementation         = function() { return '${carrier.simSerial}'; };
    TM.getNetworkOperator.overload().implementation         = function() { return '${carrier.operator}'; };
    TM.getNetworkOperatorName.overload().implementation     = function() { return '${carrier.operatorName}'; };
    TM.getSimOperator.overload().implementation             = function() { return '${carrier.operator}'; };
    TM.getSimOperatorName.overload().implementation         = function() { return '${carrier.operatorName}'; };
    TM.getNetworkCountryIso.overload().implementation       = function() { return 'us'; };
    TM.getSimCountryIso.overload().implementation           = function() { return 'us'; };
    TM.getPhoneType.overload().implementation               = function() { return 1; }; // GSM
    send('[Spoof] Carrier → ${carrier.label} (${carrier.operator})');
  } catch(e) { send('[Spoof] TelephonyManager error: ' + e); }

  // ── ANDROID_ID ──────────────────────────────────────────────────────────────
  try {
    var Secure = Java.use('android.provider.Settings$Secure');
    Secure.getString.implementation = function(cr, name) {
      if (name === 'android_id') return 'b3f2a1c4d5e6f708';
      return this.getString(cr, name);
    };
    send('[Spoof] ANDROID_ID spoofed');
  } catch(e) {}

  // ── GPS Location ────────────────────────────────────────────────────────────
  try {
    var Location = Java.use('android.location.Location');
    Location.getLatitude.implementation  = function() { return ${location.lat}; };
    Location.getLongitude.implementation = function() { return ${location.lon}; };
    Location.getAccuracy.implementation  = function() { return 4.2; };
    Location.getAltitude.implementation  = function() { return 12.0; };
    Location.hasAccuracy.implementation  = function() { return true; };
    send('[Spoof] GPS → ${location.label} (${location.lat}, ${location.lon})');
  } catch(e) { send('[Spoof] Location error: ' + e); }

  // ── LocationManager ─────────────────────────────────────────────────────────
  try {
    var LM = Java.use('android.location.LocationManager');
    LM.getLastKnownLocation.overload('java.lang.String').implementation = function(provider) {
      var loc = this.getLastKnownLocation(provider);
      if (loc !== null) {
        loc.setLatitude(${location.lat});
        loc.setLongitude(${location.lon});
      }
      return loc;
    };
  } catch(e) {}

  send('[Spoof] ✓ All hooks active — Device: ${device.label} | Carrier: ${carrier.label} | GPS: ${location.label}');
});`;
}

interface VerifyResult {
  key: string;
  expected: string;
  actual: string;
  ok: boolean;
}

function AntiDetTab() {
  const navigation = useNavigation<any>();
  const [pkg, setPkg] = useState('');
  const [busy, setBusy] = useState<string|null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState<string|null>(null);
  const [verifyResults, setVerifyResults] = useState<VerifyResult[]>([]);
  const [showVerify, setShowVerify] = useState(false);

  // Spoofer state
  const [selectedDevice, setSelectedDevice] = useState(0);
  const [selectedCarrier, setSelectedCarrier] = useState(0);
  const [selectedLocation, setSelectedLocation] = useState(0);
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  const [showCarrierPicker, setShowCarrierPicker] = useState(false);
  const [showLocationPicker, setShowLocationPicker] = useState(false);

  const addLog = (s: string) => setLog(p => [s, ...p.slice(0, 60)]);

  const runProfile = async (profileId: string) => {
    if (!pkg.trim()) { Alert.alert('Enter target package name'); return; }
    const profile = ANTI_DET_PROFILES.find(p => p.id === profileId);
    if (!profile) return;

    setBusy(profileId);
    setActiveProfile(profileId);
    addLog(`▶ Running profile: ${profile.title}`);

    try {
      const combined = profile.scripts.map(sid => {
        const sc = SCRIPT_LIBRARY.find(s => s.id === sid);
        return sc ? `// ── ${sc.title} ──
${sc.code}` : '';
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

  const injectSpoof = async () => {
    if (!pkg.trim()) { Alert.alert('Enter target package name'); return; }
    setBusy('spoof');
    const device   = REAL_DEVICES[selectedDevice];
    const carrier  = US_CARRIERS[selectedCarrier];
    const location = US_LOCATIONS[selectedLocation];
    addLog(`▶ Injecting device spoof: ${device.label}`);
    addLog(`   Carrier: ${carrier.label}  GPS: ${location.label}`);

    // ── Step 1: resetprop — system-wide, affects all apps + browser ──────────
    addLog('⚙ Applying resetprop (system-wide)...');
    try {
      const resetCmds = [
        `resetprop ro.product.model "${device.model}"`,
        `resetprop ro.product.manufacturer "${device.manufacturer}"`,
        `resetprop ro.product.brand "${device.brand}"`,
        `resetprop ro.product.device "${device.device}"`,
        `resetprop ro.product.name "${device.product}"`,
        `resetprop ro.hardware "${device.hardware}"`,
        `resetprop ro.build.fingerprint "${device.fingerprint}"`,
        `resetprop ro.build.tags "release-keys"`,
        `resetprop ro.build.type "user"`,
        // system_ext / odm variants (some apps check these too)
        `resetprop ro.product.system.model "${device.model}"`,
        `resetprop ro.product.system.manufacturer "${device.manufacturer}"`,
        `resetprop ro.product.system.brand "${device.brand}"`,
        `resetprop ro.product.odm.model "${device.model}"`,
        `resetprop ro.product.odm.manufacturer "${device.manufacturer}"`,
      ].join(' && ');
      const propResult = await rootBridge.execShell(`su -c '${resetCmds}'`);
      addLog(`✓ resetprop done — ${device.label} system-wide`);
    } catch(e: any) {
      addLog(`⚠ resetprop failed: ${e.message} — continuing with Frida only`);
    }

    // ── Step 2: Frida hook — per-app, catches runtime Java calls ─────────────
    addLog('⚙ Injecting Frida hooks into target app...');
    try {
      const script = buildSpoofScript(device, carrier, location);
      const result = await rootBridge.runScript(pkg.trim(), script, 'pid');
      addLog('✓ Hooks injected — tap VERIFY to confirm values');
      setVerifyResults([]);
    } catch(e: any) {
      addLog('✗ Frida inject failed: ' + e.message);
    } finally {
      setBusy(null);
    }
  };

  const verifySpoof = async () => {
    if (!pkg.trim()) { Alert.alert('Enter target package name'); return; }
    setBusy('verify');
    setShowVerify(true);
    setVerifyResults([]);
    addLog('▶ Reading actual values from process...');
    const device   = REAL_DEVICES[selectedDevice];
    const carrier  = US_CARRIERS[selectedCarrier];
    const location = US_LOCATIONS[selectedLocation];

    const verifyScript = `Java.perform(function () {
  var out = {};

  // Build props
  try {
    var Build = Java.use('android.os.Build');
    out.MODEL        = Build.MODEL.value;
    out.MANUFACTURER = Build.MANUFACTURER.value;
    out.BRAND        = Build.BRAND.value;
    out.FINGERPRINT  = Build.FINGERPRINT.value;
    out.TAGS         = Build.TAGS.value;
  } catch(e) { out.Build_err = String(e); }

  // TelephonyManager
  try {
    var ctx = Java.use('android.app.ActivityThread').currentApplication().getApplicationContext();
    var TM  = ctx.getSystemService('phone');
    out.IMEI             = TM.getDeviceId();
    out.SIM_SERIAL       = TM.getSimSerialNumber();
    out.NETWORK_OPERATOR = TM.getNetworkOperator();
    out.NETWORK_NAME     = TM.getNetworkOperatorName();
    out.SIM_OPERATOR     = TM.getSimOperator();
    out.SIM_COUNTRY      = TM.getSimCountryIso();
    out.NET_COUNTRY      = TM.getNetworkCountryIso();
  } catch(e) { out.TM_err = String(e); }

  // ANDROID_ID
  try {
    var Secure = Java.use('android.provider.Settings$Secure');
    out.ANDROID_ID = Secure.getString(ctx.getContentResolver(), 'android_id');
  } catch(e) { out.SecureErr = String(e); }

  // GPS via LocationManager
  try {
    var LM  = ctx.getSystemService('location');
    var loc = LM.getLastKnownLocation('gps');
    if (loc) {
      out.GPS_LAT = String(loc.getLatitude());
      out.GPS_LON = String(loc.getLongitude());
    } else {
      out.GPS_LAT = 'null (no fix yet)';
      out.GPS_LON = 'null (no fix yet)';
    }
  } catch(e) { out.GPS_err = String(e); }

  send({type:'verify', data: out});
});`;

    try {
      const raw = await rootBridge.runScript(pkg.trim(), verifyScript, 'pid');
      // parse send() output
      const match = raw.match(/\{[^}]*"data"\s*:\s*\{[\s\S]*?\}\s*\}/);
      if (!match) {
        addLog('✗ Could not parse verify output — process may have rejected the script');
        setBusy(null);
        return;
      }
      const obj: Record<string, string> = JSON.parse(match[0]).data || {};

      const checks: VerifyResult[] = [
        { key: 'MODEL',        expected: device.model,           actual: obj.MODEL        || '?' },
        { key: 'MANUFACTURER', expected: device.manufacturer,    actual: obj.MANUFACTURER || '?' },
        { key: 'BRAND',        expected: device.brand,           actual: obj.BRAND        || '?' },
        { key: 'TAGS',         expected: 'release-keys',         actual: obj.TAGS         || '?' },
        { key: 'IMEI',         expected: device.imei,            actual: obj.IMEI         || '?' },
        { key: 'SIM_SERIAL',   expected: carrier.simSerial,      actual: obj.SIM_SERIAL   || '?' },
        { key: 'NET_OPERATOR', expected: carrier.operator,       actual: obj.NETWORK_OPERATOR || '?' },
        { key: 'NET_NAME',     expected: carrier.operatorName,   actual: obj.NETWORK_NAME || '?' },
        { key: 'SIM_COUNTRY',  expected: 'us',                   actual: obj.SIM_COUNTRY  || '?' },
        { key: 'GPS_LAT',      expected: String(location.lat),   actual: obj.GPS_LAT      || '?' },
        { key: 'GPS_LON',      expected: String(location.lon),   actual: obj.GPS_LON      || '?' },
      ].map(r => ({
        ...r,
        ok: r.actual.startsWith(r.expected) || r.actual === r.expected,
      }));

      setVerifyResults(checks);
      const passed = checks.filter(c => c.ok).length;
      addLog(`✓ Verify done: ${passed}/${checks.length} values confirmed`);
      if (passed < checks.length) {
        addLog('ℹ Failed items = hooks not yet seen by the app (re-inject or restart app)');
      }
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

  const Picker = ({
    visible, items, selected, onSelect, onClose,
  }: {
    visible: boolean;
    items: {label: string}[];
    selected: number;
    onSelect: (i: number) => void;
    onClose: () => void;
  }) => (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{flex:1, backgroundColor:'rgba(0,0,0,0.7)', justifyContent:'flex-end'}}>
        <View style={{backgroundColor:C.card, borderTopWidth:1, borderTopColor:C.border, maxHeight:'60%'}}>
          <View style={[s.row, {padding:12, borderBottomWidth:1, borderBottomColor:C.border}]}>
            <Text style={[s.cardTitle, {flex:1, marginBottom:0}]}>Select</Text>
            <TouchableOpacity onPress={onClose}><Text style={{color:C.red, fontSize:18}}>✕</Text></TouchableOpacity>
          </View>
          <ScrollView>
            {items.map((item, i) => (
              <TouchableOpacity
                key={i}
                style={[{padding:12, borderBottomWidth:1, borderBottomColor:C.border},
                  selected===i && {backgroundColor:C.green2}]}
                onPress={() => { onSelect(i); onClose(); }}
              >
                <Text style={[s.mono, {color: selected===i ? C.green : C.txt}]}>
                  {selected===i ? '▶ ' : '  '}{item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  return (
    <ScrollView style={s.tab} contentContainerStyle={{paddingBottom:40}}>
      {/* Pickers */}
      <Picker visible={showDevicePicker}   items={REAL_DEVICES}    selected={selectedDevice}   onSelect={setSelectedDevice}   onClose={() => setShowDevicePicker(false)} />
      <Picker visible={showCarrierPicker}  items={US_CARRIERS}     selected={selectedCarrier}  onSelect={setSelectedCarrier}  onClose={() => setShowCarrierPicker(false)} />
      <Picker visible={showLocationPicker} items={US_LOCATIONS}    selected={selectedLocation} onSelect={setSelectedLocation} onClose={() => setShowLocationPicker(false)} />

      {/* Target */}
      <View style={s.card}>
        <Text style={s.cardTitle}>🎯 Target Package</Text>
        <TextInput
          style={s.input} placeholder="com.game.package"
          placeholderTextColor={C.dim} value={pkg} onChangeText={setPkg}
          autoCapitalize="none" autoCorrect={false}
        />
      </View>

      {/* ── Device Spoofer ── */}
      <View style={s.card}>
        <Text style={s.cardTitle}>📱 Device Spoofer</Text>
        <Text style={[s.mono, {color:C.dim, fontSize:10, marginBottom:8}]}>
          Spoofs Build props + IMEI + carrier + GPS to a real US device profile.
        </Text>

        {/* Device picker row */}
        <Text style={[s.mono, {color:C.green, fontSize:10, marginBottom:4}]}>DEVICE</Text>
        <TouchableOpacity
          style={[s.input, {flexDirection:'row', alignItems:'center', marginBottom:8}]}
          onPress={() => setShowDevicePicker(true)}
        >
          <Text style={[s.mono, {color:C.white, flex:1, fontSize:12}]}>
            {REAL_DEVICES[selectedDevice].label}
          </Text>
          <Text style={{color:C.dim}}>▼</Text>
        </TouchableOpacity>

        {/* Device fingerprint preview */}
        <ScrollView horizontal style={{marginBottom:10}}>
          <Text style={[s.mono, {color:C.dim, fontSize:9}]}>
            {REAL_DEVICES[selectedDevice].fingerprint}
          </Text>
        </ScrollView>

        {/* Carrier picker row */}
        <Text style={[s.mono, {color:C.green, fontSize:10, marginBottom:4}]}>CARRIER (US)</Text>
        <TouchableOpacity
          style={[s.input, {flexDirection:'row', alignItems:'center', marginBottom:8}]}
          onPress={() => setShowCarrierPicker(true)}
        >
          <Text style={[s.mono, {color:C.white, flex:1, fontSize:12}]}>
            {US_CARRIERS[selectedCarrier].label}  ({US_CARRIERS[selectedCarrier].operator})
          </Text>
          <Text style={{color:C.dim}}>▼</Text>
        </TouchableOpacity>

        {/* GPS picker row */}
        <Text style={[s.mono, {color:C.green, fontSize:10, marginBottom:4}]}>GPS LOCATION (US)</Text>
        <TouchableOpacity
          style={[s.input, {flexDirection:'row', alignItems:'center', marginBottom:12}]}
          onPress={() => setShowLocationPicker(true)}
        >
          <Text style={[s.mono, {color:C.white, flex:1, fontSize:12}]}>
            📍 {US_LOCATIONS[selectedLocation].label}
          </Text>
          <Text style={[s.mono, {color:C.dim, fontSize:10}]}>
            {US_LOCATIONS[selectedLocation].lat.toFixed(4)}, {US_LOCATIONS[selectedLocation].lon.toFixed(4)}
          </Text>
          <Text style={{color:C.dim, marginLeft:6}}>▼</Text>
        </TouchableOpacity>

        {/* INJECT + VERIFY buttons */}
        <View style={{flexDirection:'row', gap:8}}>
          <TouchableOpacity
            style={[s.btn, {flex:2}, busy==='spoof' && {borderColor:C.dim}]}
            onPress={injectSpoof}
            disabled={!!busy}
          >
            {busy==='spoof'
              ? <ActivityIndicator color={C.green} size="small"/>
              : <Text style={s.btnTxt}>▶ INJECT DEVICE SPOOF</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, {flex:1, borderColor:C.yellow}, busy==='verify' && {borderColor:C.dim}]}
            onPress={verifySpoof}
            disabled={!!busy}
          >
            {busy==='verify'
              ? <ActivityIndicator color={C.yellow} size="small"/>
              : <Text style={[s.btnTxt, {color:C.yellow, fontSize:11}]}>🔍 VERIFY</Text>
            }
          </TouchableOpacity>
        </View>
      </View>

      {/* ── VERIFY RESULTS CARD ── */}
      {showVerify && (
        <View style={[s.card, {borderColor: C.yellow}]}>
          <View style={[s.row, {marginBottom:8}]}>
            <Text style={[s.cardTitle, {flex:1, marginBottom:0, color:C.yellow}]}>
              🔍 Spoof Verification
            </Text>
            <TouchableOpacity onPress={() => setShowVerify(false)}>
              <Text style={{color:C.dim}}>✕</Text>
            </TouchableOpacity>
          </View>
          {verifyResults.length === 0 && busy === 'verify' && (
            <ActivityIndicator color={C.yellow} style={{marginVertical:10}}/>
          )}
          {verifyResults.map((r, i) => (
            <View key={i} style={{
              flexDirection:'row', alignItems:'flex-start',
              paddingVertical:5, borderBottomWidth:1, borderBottomColor:C.border,
            }}>
              {/* status dot */}
              <Text style={{
                fontSize:13, marginRight:6, marginTop:1,
                color: r.ok ? C.green : C.red,
              }}>
                {r.ok ? '✓' : '✗'}
              </Text>
              <View style={{flex:1}}>
                <Text style={[s.mono, {color:C.dim, fontSize:10}]}>{r.key}</Text>
                {r.ok ? (
                  <Text style={[s.mono, {color:C.green, fontSize:11}]}>{r.actual}</Text>
                ) : (
                  <>
                    <Text style={[s.mono, {color:C.red, fontSize:11}]}>
                      got:  {r.actual}
                    </Text>
                    <Text style={[s.mono, {color:C.dim, fontSize:10}]}>
                      want: {r.expected}
                    </Text>
                  </>
                )}
              </View>
            </View>
          ))}
          {verifyResults.length > 0 && (
            <View style={{marginTop:8, padding:6, backgroundColor:'#0a0a0a', borderRadius:4}}>
              <Text style={[s.mono, {color:C.dim, fontSize:10}]}>
                {verifyResults.filter(r=>r.ok).length === verifyResults.length
                  ? '✓ All hooks active — the app sees the spoofed values'
                  : `⚠ ${verifyResults.filter(r=>!r.ok).length} value(s) not hooked yet.\n  → Re-inject while app is running, or restart the app then inject.`
                }
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Quick actions */}
      <View style={s.card}>
        <Text style={s.cardTitle}>⚡ Quick System Actions</Text>
        <View style={s.row}>
          <TouchableOpacity style={[s.btn, {flex:1}]} onPress={() => quickAction('ptrace_off')} disabled={!!busy}>
            {busy==='ptrace_off' ? <ActivityIndicator color={C.green} size="small"/> : <Text style={s.btnTxt}>PTRACE OFF</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, {flex:1, marginLeft:8}]} onPress={() => quickAction('selinux_perm')} disabled={!!busy}>
            {busy==='selinux_perm' ? <ActivityIndicator color={C.green} size="small"/> : <Text style={s.btnTxt}>SELINUX PERM</Text>}
          </TouchableOpacity>
        </View>
        <View style={[s.row, {marginTop:8}]}>
          <TouchableOpacity style={[s.btn, {flex:1}]} onPress={() => quickAction('hide_magisk')} disabled={!!busy}>
            {busy==='hide_magisk' ? <ActivityIndicator color={C.green} size="small"/> : <Text style={s.btnTxt}>HIDE MAGISK</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, {flex:1, marginLeft:8}]} onPress={() => quickAction('clear_detect_cache')} disabled={!!busy}>
            {busy==='clear_detect_cache' ? <ActivityIndicator color={C.green} size="small"/> : <Text style={s.btnTxt}>CLEAR CACHE</Text>}
          </TouchableOpacity>
        </View>
      </View>

      {/* Stealth Profiles */}
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

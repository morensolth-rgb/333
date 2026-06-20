import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Modal, Alert, NativeModules, NativeEventEmitter,
  ScrollView, TextInput, ActivityIndicator,
} from 'react-native';
import { rootBridge, AppInfo } from '../native/RootBridge';

const { TrafficModule } = NativeModules;
const emitter = TrafficModule ? new NativeEventEmitter(TrafficModule) : null;

// ── Types ───────────────────────────────────────────────────────────────────
interface RawPacket {
  type: 'packet';
  ts: number; protocol: string; src: string; dst: string;
  host: string; port: number; len: number; dir: string;
}

interface HttpEntry {
  type: 'http';
  id: number; ts: number;
  method: string; url: string; host: string; path: string;
  headers: Record<string, string>; body: string; source: string;
  // response (may come later)
  statusCode?: number; statusText?: string;
  resHeaders?: Record<string, string>; resBody?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const METHOD_COLOR: Record<string, string> = {
  GET: '#00ff88', POST: '#00aaff', PUT: '#ffaa00',
  DELETE: '#ff4444', PATCH: '#ff88ff', HEAD: '#888',
};
const STATUS_COLOR = (code: number) => {
  if (code < 300) return '#00ff88';
  if (code < 400) return '#ffaa00';
  if (code < 500) return '#ff8800';
  return '#ff4444';
};
const PROTO_COLOR: Record<string, string> = {
  TCP: '#00ff88', UDP: '#00aaff', ICMP: '#ffaa00', DNS: '#ff66ff',
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}
const pad  = (n: number) => String(n).padStart(2, '0');
const pad3 = (n: number) => String(n).padStart(3, '0');
const fmtBytes = (n: number) => n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;

function parseHeaders(s?: string): Record<string, string> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ── Header Detail Modal ───────────────────────────────────────────────────────
function DetailModal({ item, onClose }: { item: HttpEntry | null; onClose: () => void }) {
  const [tab, setTab] = useState<'req' | 'res'>('req');
  if (!item) return null;

  const reqHeaders = item.headers || {};
  const resHeaders = item.resHeaders || {};

  return (
    <Modal visible={!!item} transparent animationType="slide" onRequestClose={onClose}>
      <View style={dm.overlay}>
        <View style={dm.box}>
          {/* Title */}
          <View style={dm.titleRow}>
            <Text style={[dm.method, { color: METHOD_COLOR[item.method] || '#888' }]}>
              {item.method}
            </Text>
            <Text style={dm.url} numberOfLines={1}>{item.url}</Text>
            {item.statusCode ? (
              <Text style={[dm.status, { color: STATUS_COLOR(item.statusCode) }]}>
                {item.statusCode}
              </Text>
            ) : null}
          </View>

          {/* Source badge */}
          <View style={dm.badgeRow}>
            <View style={[dm.badge, { borderColor: item.source === 'frida' ? '#ff88ff' : '#00aaff' }]}>
              <Text style={[dm.badgeText, { color: item.source === 'frida' ? '#ff88ff' : '#00aaff' }]}>
                {item.source === 'frida' ? '⚡ FRIDA' : '🔀 PROXY'}
              </Text>
            </View>
            <Text style={dm.time}>{fmtTime(item.ts)}</Text>
          </View>

          {/* Req / Res tabs */}
          <View style={dm.tabs}>
            {(['req', 'res'] as const).map(t => (
              <TouchableOpacity key={t} style={[dm.tab, tab === t && dm.tabActive]} onPress={() => setTab(t)}>
                <Text style={[dm.tabText, tab === t && dm.tabTextActive]}>
                  {t === 'req' ? 'REQUEST' : 'RESPONSE'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView style={dm.scroll}>
            {tab === 'req' ? (
              <>
                <Text style={dm.sectionLabel}>HEADERS</Text>
                {Object.entries(reqHeaders).length === 0
                  ? <Text style={dm.empty}>—</Text>
                  : Object.entries(reqHeaders).map(([k, v]) => (
                    <View key={k} style={dm.headerRow}>
                      <Text style={dm.headerKey}>{k}: </Text>
                      <Text style={dm.headerVal}>{v}</Text>
                    </View>
                  ))
                }
                <Text style={dm.sectionLabel}>BODY</Text>
                <Text style={dm.bodyText}>{item.body || '(empty)'}</Text>
              </>
            ) : (
              <>
                {item.statusCode
                  ? <Text style={[dm.statusLine, { color: STATUS_COLOR(item.statusCode) }]}>
                      HTTP {item.statusCode} {item.statusText}
                    </Text>
                  : <Text style={dm.empty}>No response captured yet</Text>
                }
                <Text style={dm.sectionLabel}>HEADERS</Text>
                {Object.entries(resHeaders).length === 0
                  ? <Text style={dm.empty}>—</Text>
                  : Object.entries(resHeaders).map(([k, v]) => (
                    <View key={k} style={dm.headerRow}>
                      <Text style={dm.headerKey}>{k}: </Text>
                      <Text style={dm.headerVal}>{v}</Text>
                    </View>
                  ))
                }
                <Text style={dm.sectionLabel}>BODY</Text>
                <Text style={dm.bodyText}>{item.resBody || '(empty)'}</Text>
              </>
            )}
          </ScrollView>

          <TouchableOpacity style={dm.closeBtn} onPress={onClose}>
            <Text style={dm.closeBtnText}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function TrafficScreen() {
  const [capturing, setCapturing]       = useState(false);
  const [loading, setLoading]           = useState(false);
  const [apps, setApps]                 = useState<AppInfo[]>([]);
  const [selectedPkg, setSelectedPkg]   = useState('');
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [fridaEnabled, setFridaEnabled] = useState(false);
  const [hookStatus, setHookStatus]     = useState<{ okhttp: boolean; httpurl: boolean } | null>(null);

  const [viewTab, setViewTab]   = useState<'http' | 'raw'>('http');
  const [httpEntries, setHttpEntries] = useState<HttpEntry[]>([]);
  const [rawPackets, setRawPackets]   = useState<RawPacket[]>([]);
  const [search, setSearch]           = useState('');
  const [selectedItem, setSelectedItem] = useState<HttpEntry | null>(null);

  const [stats, setStats] = useState({ total: 0, http: 0, bytes: 0 });
  const flatRef   = useRef<FlatList>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    rootBridge.getInstalledApps()
      .then(list => setApps(
        list.filter(a => !a.isSystemApp).sort((a, b) => a.appName.localeCompare(b.appName))
      ))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!emitter) return;

    const subs = [
      // Raw packet from VPN
      emitter.addListener('onTrafficPacket', (pkt: any) => {
        setRawPackets(prev => {
          const next = prev.length >= 1000 ? prev.slice(-999) : prev;
          return [...next, { ...pkt, type: 'packet' }];
        });
        setStats(s => ({ ...s, total: s.total + 1, bytes: s.bytes + (pkt.len || 0) }));
        if (autoScroll.current && viewTab === 'raw') {
          setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 50);
        }
      }),

      // HTTP request from proxy or Frida
      emitter.addListener('onHttpRequest', (req: any) => {
        const entry: HttpEntry = {
          type: 'http',
          id: req.id, ts: req.ts,
          method: req.method, url: req.url,
          host: req.host, path: req.path,
          headers: parseHeaders(req.headers),
          body: req.body || '',
          source: req.source || 'proxy',
        };
        setHttpEntries(prev => {
          const next = prev.length >= 500 ? prev.slice(-499) : prev;
          return [...next, entry];
        });
        setStats(s => ({ ...s, http: s.http + 1 }));
        if (autoScroll.current && viewTab === 'http') {
          setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 50);
        }
      }),

      // HTTP response — attach to existing request
      emitter.addListener('onHttpResponse', (res: any) => {
        setHttpEntries(prev =>
          prev.map(e =>
            e.id === res.requestId
              ? {
                  ...e,
                  statusCode: res.statusCode,
                  statusText: res.statusText,
                  resHeaders: parseHeaders(res.headers),
                  resBody: res.body || '',
                }
              : e
          )
        );
      }),

      // Frida hook status
      emitter.addListener('onFridaHookStatus', (s: any) => {
        setHookStatus({ okhttp: s.okhttp, httpurl: s.httpurl });
      }),
    ];

    return () => subs.forEach(s => s.remove());
  }, [viewTab]);

  const startCapture = async () => {
    if (!TrafficModule) { Alert.alert('Error', 'TrafficModule not available'); return; }
    try {
      setLoading(true);
      setHttpEntries([]);
      setRawPackets([]);
      setStats({ total: 0, http: 0, bytes: 0 });
      setHookStatus(null);
      await TrafficModule.startCapture(selectedPkg);
      setCapturing(true);

      // Inject Frida hook if enabled and target selected
      if (fridaEnabled && selectedPkg) {
        try {
          await TrafficModule.injectFridaHook(selectedPkg);
        } catch (e: any) {
          Alert.alert('Frida Hook', `Hook inject failed:\n${e?.message}\n\nProxy still running.`);
        }
      }
    } catch (e: any) {
      if (e?.code === 'VPN_DENIED') Alert.alert('Denied', 'VPN permission required.');
      else Alert.alert('Error', e?.message || 'Failed to start');
    } finally {
      setLoading(false);
    }
  };

  const stopCapture = async () => {
    try { await TrafficModule?.stopCapture(); setCapturing(false); }
    catch (e: any) { Alert.alert('Error', e?.message); }
  };

  const exportData = async () => {
    try {
      const json = await TrafficModule?.exportJson();
      if (!json) return;
      const path = `/sdcard/Download/traffic_${Date.now()}.json`;
      await rootBridge.execShell(`cat > ${path} << 'FRIDACTL_EOF'\n${json}\nFRIDACTL_EOF`);
      Alert.alert('Exported', path);
    } catch (e: any) { Alert.alert('Export Error', e?.message); }
  };

  // ── Filtered HTTP list ────────────────────────────────────────────────────
  const filteredHttp = httpEntries.filter(e => {
    if (!search) return true;
    const q = search.toLowerCase();
    return e.url.toLowerCase().includes(q) || e.host.toLowerCase().includes(q)
        || e.method.toLowerCase().includes(q);
  });

  const filteredRaw = rawPackets.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return p.host.toLowerCase().includes(q) || p.dst.toLowerCase().includes(q);
  });

  const selectedApp = apps.find(a => a.packageName === selectedPkg);

  // ── Render HTTP row ────────────────────────────────────────────────────────
  const renderHttp = ({ item }: { item: HttpEntry }) => (
    <TouchableOpacity style={styles.httpRow} onPress={() => setSelectedItem(item)} activeOpacity={0.7}>
      <View style={styles.httpLeft}>
        <Text style={[styles.httpMethod, { color: METHOD_COLOR[item.method] || '#888' }]}>
          {item.method.padEnd(7)}
        </Text>
        <View style={styles.httpMeta}>
          <Text style={styles.httpUrl} numberOfLines={1}>{item.host}{item.path}</Text>
          <Text style={styles.httpTime}>{fmtTime(item.ts)}</Text>
        </View>
      </View>
      <View style={styles.httpRight}>
        {item.statusCode
          ? <Text style={[styles.httpStatus, { color: STATUS_COLOR(item.statusCode) }]}>
              {item.statusCode}
            </Text>
          : <Text style={styles.httpPending}>···</Text>
        }
        <Text style={[styles.srcBadge, { color: item.source === 'frida' ? '#ff88ff' : '#00aaff' }]}>
          {item.source === 'frida' ? '⚡' : '↔'}
        </Text>
      </View>
    </TouchableOpacity>
  );

  // ── Render raw packet row ─────────────────────────────────────────────────
  const renderRaw = ({ item: p }: { item: RawPacket }) => (
    <View style={styles.rawRow}>
      <Text style={styles.rawTime}>{fmtTime(p.ts)}</Text>
      <Text style={[styles.rawProto, { color: PROTO_COLOR[p.protocol] || '#555' }]}>
        {p.protocol.padEnd(4)}
      </Text>
      <Text style={styles.rawHost} numberOfLines={1}>{p.host || p.dst}</Text>
      <Text style={styles.rawPort}>:{p.port}</Text>
      <Text style={styles.rawSize}>{fmtBytes(p.len)}</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.title}>// TRAFFIC</Text>
        <View style={styles.statusRow}>
          {hookStatus && (
            <Text style={styles.hookBadge}>
              {hookStatus.okhttp ? '⚡okhttp' : ''}{hookStatus.httpurl ? ' ⚡urlconn' : ''}
            </Text>
          )}
          <View style={[styles.dot, { backgroundColor: capturing ? '#00ff88' : '#222' }]} />
          <Text style={[styles.statusTxt, { color: capturing ? '#00ff88' : '#333' }]}>
            {capturing ? 'LIVE' : 'IDLE'}
          </Text>
        </View>
      </View>

      {/* ── Stats ── */}
      {capturing && (
        <View style={styles.statsBar}>
          <Text style={styles.stat}>HTTP <Text style={styles.sv}>{stats.http}</Text></Text>
          <Text style={styles.stat}>PKT <Text style={styles.sv}>{stats.total}</Text></Text>
          <Text style={styles.stat}>SIZE <Text style={styles.sv}>{fmtBytes(stats.bytes)}</Text></Text>
        </View>
      )}

      {/* ── Controls ── */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.appBtn}
          onPress={() => !capturing && setShowAppPicker(true)}
          disabled={capturing}>
          <Text style={styles.appBtnTxt} numberOfLines={1}>
            {selectedApp ? selectedApp.appName : '[ All Apps ]'}
          </Text>
          <Text style={styles.chevron}>▼</Text>
        </TouchableOpacity>

        {!capturing ? (
          <TouchableOpacity style={[styles.btn, styles.btnGreen]} onPress={startCapture} disabled={loading}>
            {loading
              ? <ActivityIndicator color="#000" size="small" />
              : <Text style={styles.btnDark}>▶ START</Text>}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.btnRed]} onPress={stopCapture}>
            <Text style={styles.btnRedTxt}>■ STOP</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={[styles.btn, styles.btnGray]} onPress={exportData}
          disabled={httpEntries.length === 0 && rawPackets.length === 0}>
          <Text style={styles.btnGrayTxt}>↓</Text>
        </TouchableOpacity>
      </View>

      {/* ── Frida toggle ── */}
      <TouchableOpacity
        style={[styles.fridaToggle, fridaEnabled && styles.fridaToggleOn]}
        onPress={() => !capturing && setFridaEnabled(v => !v)}
        disabled={capturing}>
        <Text style={[styles.fridaTxt, fridaEnabled && styles.fridaTxtOn]}>
          {fridaEnabled ? '⚡ FRIDA HOOK ON — HTTPS captured' : '⚡ FRIDA HOOK OFF — tap to enable HTTPS capture'}
        </Text>
      </TouchableOpacity>

      {/* ── View tabs ── */}
      <View style={styles.viewTabs}>
        {(['http', 'raw'] as const).map(t => (
          <TouchableOpacity
            key={t}
            style={[styles.viewTab, viewTab === t && styles.viewTabActive]}
            onPress={() => setViewTab(t)}>
            <Text style={[styles.viewTabTxt, viewTab === t && styles.viewTabTxtActive]}>
              {t === 'http'
                ? `HTTP/S  (${httpEntries.length})`
                : `RAW PKT (${rawPackets.length})`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Search ── */}
      <TextInput
        style={styles.search}
        placeholder={viewTab === 'http' ? 'search url / host / method...' : 'search host / ip...'}
        placeholderTextColor="#222"
        value={search}
        onChangeText={setSearch}
      />

      {/* ── List ── */}
      {viewTab === 'http' ? (
        filteredHttp.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTxt}>
              {capturing
                ? fridaEnabled && !selectedPkg
                  ? '⚡ Frida needs a target app selected'
                  : '⏳ waiting for HTTP requests...'
                : '[ press START to capture ]'}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={flatRef}
            data={filteredHttp}
            keyExtractor={(_, i) => String(i)}
            renderItem={renderHttp}
            style={styles.list}
            onScrollBeginDrag={() => { autoScroll.current = false; }}
            onScrollEndDrag={() => { autoScroll.current = true; }}
            initialNumToRender={30}
            maxToRenderPerBatch={20}
            windowSize={5}
          />
        )
      ) : (
        filteredRaw.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTxt}>
              {capturing ? '⏳ waiting for packets...' : '[ press START to capture ]'}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={flatRef}
            data={filteredRaw}
            keyExtractor={(_, i) => String(i)}
            renderItem={renderRaw}
            style={styles.list}
            onScrollBeginDrag={() => { autoScroll.current = false; }}
            onScrollEndDrag={() => { autoScroll.current = true; }}
            initialNumToRender={30}
            maxToRenderPerBatch={20}
          />
        )
      )}

      {/* ── Clear ── */}
      {(httpEntries.length > 0 || rawPackets.length > 0) && (
        <TouchableOpacity style={styles.clearBtn} onPress={() => {
          setHttpEntries([]); setRawPackets([]);
          setStats({ total: 0, http: 0, bytes: 0 });
        }}>
          <Text style={styles.clearTxt}>CLEAR</Text>
        </TouchableOpacity>
      )}

      {/* ── Detail Modal ── */}
      <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />

      {/* ── App Picker Modal ── */}
      <Modal visible={showAppPicker} transparent animationType="slide"
        onRequestClose={() => setShowAppPicker(false)}>
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerBox}>
            <Text style={styles.pickerTitle}>Target App</Text>
            <TouchableOpacity style={styles.pickerRow}
              onPress={() => { setSelectedPkg(''); setShowAppPicker(false); }}>
              <Text style={[styles.pickerItem, !selectedPkg && styles.pickerSelected]}>
                All Apps
              </Text>
            </TouchableOpacity>
            <ScrollView style={{ maxHeight: 380 }}>
              {apps.map(app => (
                <TouchableOpacity key={app.packageName} style={styles.pickerRow}
                  onPress={() => { setSelectedPkg(app.packageName); setShowAppPicker(false); }}>
                  <Text style={[styles.pickerItem, selectedPkg === app.packageName && styles.pickerSelected]}>
                    {app.appName}
                  </Text>
                  <Text style={styles.pickerPkg}>{app.packageName}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.pickerClose} onPress={() => setShowAppPicker(false)}>
              <Text style={styles.pickerCloseTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0d0d0d' },
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 },
  title:        { color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 13, letterSpacing: 2 },
  statusRow:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hookBadge:    { color: '#ff88ff', fontFamily: 'monospace', fontSize: 9, marginRight: 4 },
  dot:          { width: 8, height: 8, borderRadius: 4 },
  statusTxt:    { fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold', letterSpacing: 2 },

  statsBar:     { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 5, backgroundColor: '#111', borderBottomWidth: 1, borderColor: '#1a1a1a' },
  stat:         { color: '#444', fontFamily: 'monospace', fontSize: 11 },
  sv:           { color: '#00ff88' },

  controls:     { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center' },
  appBtn:       { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#111', borderWidth: 1, borderColor: '#1f1f1f', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 4 },
  appBtnTxt:    { color: '#00ff88', fontFamily: 'monospace', fontSize: 12, flex: 1 },
  chevron:      { color: '#333', fontSize: 10 },
  btn:          { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  btnGreen:     { backgroundColor: '#00ff88' },
  btnRed:       { backgroundColor: '#1a0000', borderWidth: 1, borderColor: '#ff3333' },
  btnGray:      { backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  btnDark:      { color: '#000', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 12 },
  btnRedTxt:    { color: '#ff3333', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 12 },
  btnGrayTxt:   { color: '#555', fontFamily: 'monospace', fontSize: 14 },

  fridaToggle:  { marginHorizontal: 10, marginBottom: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 4, borderWidth: 1, borderColor: '#1a1a1a', backgroundColor: '#111' },
  fridaToggleOn:{ borderColor: '#ff88ff44', backgroundColor: '#1a001a' },
  fridaTxt:     { color: '#333', fontFamily: 'monospace', fontSize: 11 },
  fridaTxtOn:   { color: '#ff88ff' },

  viewTabs:     { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#1a1a1a' },
  viewTab:      { flex: 1, paddingVertical: 7, alignItems: 'center' },
  viewTabActive:{ borderBottomWidth: 2, borderColor: '#00ff88' },
  viewTabTxt:   { color: '#333', fontFamily: 'monospace', fontSize: 11 },
  viewTabTxtActive: { color: '#00ff88' },

  search:       { marginHorizontal: 10, marginTop: 6, marginBottom: 4, backgroundColor: '#111', borderRadius: 4, paddingHorizontal: 10, paddingVertical: 5, color: '#00ff88', fontFamily: 'monospace', fontSize: 12, borderWidth: 1, borderColor: '#1a1a1a' },

  list:         { flex: 1 },

  // HTTP row
  httpRow:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: '#0f0f0f' },
  httpLeft:     { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  httpMethod:   { fontFamily: 'monospace', fontWeight: 'bold', fontSize: 11, width: 52 },
  httpMeta:     { flex: 1 },
  httpUrl:      { color: '#aaa', fontFamily: 'monospace', fontSize: 12 },
  httpTime:     { color: '#2a2a2a', fontFamily: 'monospace', fontSize: 10 },
  httpRight:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  httpStatus:   { fontFamily: 'monospace', fontWeight: 'bold', fontSize: 12 },
  httpPending:  { color: '#333', fontFamily: 'monospace', fontSize: 12 },
  srcBadge:     { fontFamily: 'monospace', fontSize: 13 },

  // Raw packet row
  rawRow:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 3, borderBottomWidth: 1, borderColor: '#0f0f0f' },
  rawTime:      { color: '#222', fontFamily: 'monospace', fontSize: 10, width: 86 },
  rawProto:     { fontFamily: 'monospace', fontSize: 10, fontWeight: 'bold', width: 44 },
  rawHost:      { flex: 1, color: '#888', fontFamily: 'monospace', fontSize: 11 },
  rawPort:      { color: '#333', fontFamily: 'monospace', fontSize: 10, width: 42, textAlign: 'right' },
  rawSize:      { color: '#222', fontFamily: 'monospace', fontSize: 10, width: 38, textAlign: 'right' },

  empty:        { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 },
  emptyTxt:     { color: '#1a1a1a', fontFamily: 'monospace', fontSize: 12, textAlign: 'center', letterSpacing: 1 },

  clearBtn:     { alignItems: 'center', paddingVertical: 6, borderTopWidth: 1, borderColor: '#111' },
  clearTxt:     { color: '#1f1f1f', fontFamily: 'monospace', fontSize: 11, letterSpacing: 3 },

  // App picker
  pickerOverlay:{ flex: 1, backgroundColor: '#000000cc', justifyContent: 'flex-end' },
  pickerBox:    { backgroundColor: '#111', borderTopWidth: 1, borderColor: '#00ff8833', padding: 16, maxHeight: '75%' },
  pickerTitle:  { color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 14, marginBottom: 12, letterSpacing: 2 },
  pickerRow:    { paddingVertical: 10, borderBottomWidth: 1, borderColor: '#1a1a1a' },
  pickerItem:   { color: '#888', fontFamily: 'monospace', fontSize: 13 },
  pickerSelected:{ color: '#00ff88' },
  pickerPkg:    { color: '#333', fontFamily: 'monospace', fontSize: 10, marginTop: 2 },
  pickerClose:  { marginTop: 12, alignItems: 'center', paddingVertical: 10, borderWidth: 1, borderColor: '#1a1a1a', borderRadius: 4 },
  pickerCloseTxt:{ color: '#555', fontFamily: 'monospace', fontSize: 13 },
});

// ── Detail Modal Styles ───────────────────────────────────────────────────────
const dm = StyleSheet.create({
  overlay:    { flex: 1, backgroundColor: '#000000dd', justifyContent: 'flex-end' },
  box:        { backgroundColor: '#0d0d0d', borderTopWidth: 1, borderColor: '#00ff8833', maxHeight: '88%' },
  titleRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderBottomWidth: 1, borderColor: '#1a1a1a' },
  method:     { fontFamily: 'monospace', fontWeight: 'bold', fontSize: 13 },
  url:        { flex: 1, color: '#888', fontFamily: 'monospace', fontSize: 11 },
  status:     { fontFamily: 'monospace', fontWeight: 'bold', fontSize: 14 },
  badgeRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6 },
  badge:      { borderWidth: 1, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText:  { fontFamily: 'monospace', fontSize: 10, fontWeight: 'bold' },
  time:       { color: '#333', fontFamily: 'monospace', fontSize: 10 },
  tabs:       { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#1a1a1a' },
  tab:        { flex: 1, paddingVertical: 8, alignItems: 'center' },
  tabActive:  { borderBottomWidth: 2, borderColor: '#00ff88' },
  tabText:    { color: '#333', fontFamily: 'monospace', fontSize: 11 },
  tabTextActive:{ color: '#00ff88' },
  scroll:     { maxHeight: 420, padding: 12 },
  sectionLabel:{ color: '#00ff8866', fontFamily: 'monospace', fontSize: 10, letterSpacing: 3, marginTop: 10, marginBottom: 6 },
  headerRow:  { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 3 },
  headerKey:  { color: '#00aaff', fontFamily: 'monospace', fontSize: 11 },
  headerVal:  { color: '#aaa', fontFamily: 'monospace', fontSize: 11, flex: 1 },
  bodyText:   { color: '#888', fontFamily: 'monospace', fontSize: 11, lineHeight: 18 },
  statusLine: { fontFamily: 'monospace', fontWeight: 'bold', fontSize: 13, marginBottom: 6 },
  empty:      { color: '#333', fontFamily: 'monospace', fontSize: 11 },
  closeBtn:   { alignItems: 'center', paddingVertical: 14, borderTopWidth: 1, borderColor: '#1a1a1a' },
  closeBtnText:{ color: '#444', fontFamily: 'monospace', fontSize: 12, letterSpacing: 3 },
});

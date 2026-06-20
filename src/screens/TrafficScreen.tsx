import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Alert,
  NativeModules,
  NativeEventEmitter,
  NativeAppEventEmitter,
  Platform,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { rootBridge, AppInfo } from '../native/RootBridge';

const { TrafficModule } = NativeModules;
const trafficEmitter = TrafficModule ? new NativeEventEmitter(TrafficModule) : null;

interface Packet {
  ts: number;
  protocol: string;
  src: string;
  dst: string;
  host: string;
  port: number;
  len: number;
  dir: string;
}

const PROTO_COLOR: Record<string, string> = {
  TCP:  '#00ff88',
  UDP:  '#00aaff',
  ICMP: '#ffaa00',
  DNS:  '#ff66ff',
  HTTP: '#ffff00',
  HTTPS:'#00ff88',
};

const PORT_LABEL: Record<number, string> = {
  80: 'HTTP', 443: 'HTTPS', 8080: 'HTTP', 8443: 'HTTPS',
  53: 'DNS', 22: 'SSH', 21: 'FTP',
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n/1024).toFixed(1)}KB`;
}

export default function TrafficScreen() {
  const [packets, setPackets]         = useState<Packet[]>([]);
  const [capturing, setCapturing]     = useState(false);
  const [apps, setApps]               = useState<AppInfo[]>([]);
  const [selectedPkg, setSelectedPkg] = useState('');
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [filter, setFilter]           = useState<'ALL'|'TCP'|'UDP'|'DNS'|'HTTP'>('ALL');
  const [search, setSearch]           = useState('');
  const [loading, setLoading]         = useState(false);
  const [stats, setStats]             = useState({ total: 0, bytes: 0, tcp: 0, udp: 0 });
  const flatRef = useRef<FlatList>(null);
  const autoScroll = useRef(true);

  // Load apps once
  useEffect(() => {
    rootBridge.getInstalledApps().then(list => {
      setApps(list.filter(a => !a.isSystemApp).sort((a,b) => a.appName.localeCompare(b.appName)));
    }).catch(() => {});
  }, []);

  // Listen for live packets
  useEffect(() => {
    if (!trafficEmitter) return;
    const sub = trafficEmitter.addListener('onTrafficPacket', (pkt: Packet) => {
      setPackets(prev => {
        const next = prev.length >= 1000 ? prev.slice(-999) : prev;
        return [...next, pkt];
      });
      setStats(s => ({
        total: s.total + 1,
        bytes: s.bytes + (pkt.len || 0),
        tcp: s.tcp + (pkt.protocol === 'TCP' ? 1 : 0),
        udp: s.udp + (pkt.protocol === 'UDP' ? 1 : 0),
      }));
      if (autoScroll.current) {
        setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 50);
      }
    });
    return () => sub.remove();
  }, []);

  const startCapture = async () => {
    if (!TrafficModule) {
      Alert.alert('Error', 'TrafficModule not available');
      return;
    }
    try {
      setLoading(true);
      // Check VPN permission
      const perm = await TrafficModule.prepareVpn();
      if (perm === 'needs_permission') {
        Alert.alert(
          'VPN Permission Required',
          'Android will show a VPN permission dialog. Please accept it to start capturing.',
          [{ text: 'OK' }]
        );
        setLoading(false);
        return;
      }
      setPackets([]);
      setStats({ total: 0, bytes: 0, tcp: 0, udp: 0 });
      const result = await TrafficModule.startCapture(selectedPkg);
      setCapturing(true);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to start capture');
    } finally {
      setLoading(false);
    }
  };

  const stopCapture = async () => {
    try {
      await TrafficModule?.stopCapture();
      setCapturing(false);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to stop capture');
    }
  };

  const exportData = async () => {
    try {
      const json = await TrafficModule?.exportJson();
      if (!json) return;
      // Save via shell to /sdcard/Download/
      const ts = Date.now();
      const path = `/sdcard/Download/traffic_${ts}.json`;
      await rootBridge.execShell(`echo '${json.replace(/'/g, "\\'")}' > ${path}`);
      Alert.alert('Exported', `Saved to:\n${path}`);
    } catch (e: any) {
      Alert.alert('Export Error', e?.message);
    }
  };

  const filtered = packets.filter(p => {
    if (filter !== 'ALL') {
      const portLabel = PORT_LABEL[p.port] || '';
      if (filter === 'HTTP' && portLabel !== 'HTTP') return false;
      if (filter === 'DNS'  && p.port !== 53) return false;
      if (filter !== 'HTTP' && filter !== 'DNS' && p.protocol !== filter) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      return p.host?.toLowerCase().includes(q) || p.dst?.toLowerCase().includes(q);
    }
    return true;
  });

  const renderPacket = ({ item: p }: { item: Packet }) => {
    const portLabel = PORT_LABEL[p.port];
    const protoLabel = portLabel || p.protocol;
    const color = PROTO_COLOR[protoLabel] || PROTO_COLOR[p.protocol] || '#888';
    return (
      <View style={styles.row}>
        <Text style={styles.time}>{fmtTime(p.ts)}</Text>
        <Text style={[styles.proto, { color }]}>{protoLabel.padEnd(5)}</Text>
        <Text style={styles.host} numberOfLines={1}>
          {p.host || p.dst}
        </Text>
        <Text style={styles.port}>:{p.port}</Text>
        <Text style={styles.size}>{fmtBytes(p.len)}</Text>
      </View>
    );
  };

  const selectedApp = apps.find(a => a.packageName === selectedPkg);

  return (
    <View style={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{'// TRAFFIC CAPTURE'}</Text>
        <View style={styles.statusDot}>
          <View style={[styles.dot, { backgroundColor: capturing ? '#00ff88' : '#333' }]} />
          <Text style={[styles.statusText, { color: capturing ? '#00ff88' : '#555' }]}>
            {capturing ? 'LIVE' : 'IDLE'}
          </Text>
        </View>
      </View>

      {/* ── Stats ── */}
      {capturing && (
        <View style={styles.statsBar}>
          <Text style={styles.stat}>PKT: <Text style={styles.statVal}>{stats.total}</Text></Text>
          <Text style={styles.stat}>TCP: <Text style={styles.statVal}>{stats.tcp}</Text></Text>
          <Text style={styles.stat}>UDP: <Text style={styles.statVal}>{stats.udp}</Text></Text>
          <Text style={styles.stat}>SIZE: <Text style={styles.statVal}>{fmtBytes(stats.bytes)}</Text></Text>
        </View>
      )}

      {/* ── Controls ── */}
      <View style={styles.controls}>
        {/* App picker */}
        <TouchableOpacity
          style={styles.appPickerBtn}
          onPress={() => !capturing && setShowAppPicker(true)}
          disabled={capturing}>
          <Text style={styles.appPickerText} numberOfLines={1}>
            {selectedApp ? selectedApp.appName : '[ All Apps ]'}
          </Text>
          <Text style={styles.chevron}>▼</Text>
        </TouchableOpacity>

        {/* Start/Stop */}
        {!capturing ? (
          <TouchableOpacity
            style={[styles.btn, styles.btnStart]}
            onPress={startCapture}
            disabled={loading}>
            {loading
              ? <ActivityIndicator color="#000" size="small" />
              : <Text style={styles.btnTextDark}>▶ START</Text>}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.btnStop]} onPress={stopCapture}>
            <Text style={styles.btnTextRed}>■ STOP</Text>
          </TouchableOpacity>
        )}

        {/* Export */}
        <TouchableOpacity
          style={[styles.btn, styles.btnExport]}
          onPress={exportData}
          disabled={packets.length === 0}>
          <Text style={styles.btnTextGray}>↓ JSON</Text>
        </TouchableOpacity>
      </View>

      {/* ── Filter tabs ── */}
      <View style={styles.filterBar}>
        {(['ALL','TCP','UDP','DNS','HTTP'] as const).map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterBtn, filter === f && styles.filterActive]}
            onPress={() => setFilter(f)}>
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Search ── */}
      <TextInput
        style={styles.search}
        placeholder="search host / ip..."
        placeholderTextColor="#333"
        value={search}
        onChangeText={setSearch}
      />

      {/* ── Column headers ── */}
      <View style={styles.colHeader}>
        <Text style={styles.colText}>TIME         PROTO HOST                    PORT  SIZE</Text>
      </View>

      {/* ── Packet list ── */}
      {filtered.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {capturing ? '⏳ waiting for packets...' : '[ press START to begin capture ]'}
          </Text>
        </View>
      ) : (
        <FlatList
          ref={flatRef}
          data={filtered}
          keyExtractor={(_, i) => String(i)}
          renderItem={renderPacket}
          style={styles.list}
          onScrollBeginDrag={() => { autoScroll.current = false; }}
          onScrollEndDrag={() => { autoScroll.current = true; }}
          initialNumToRender={30}
          maxToRenderPerBatch={20}
          windowSize={5}
        />
      )}

      {/* ── Clear btn ── */}
      {packets.length > 0 && (
        <TouchableOpacity
          style={styles.clearBtn}
          onPress={() => { setPackets([]); setStats({ total:0, bytes:0, tcp:0, udp:0 }); }}>
          <Text style={styles.clearText}>CLEAR</Text>
        </TouchableOpacity>
      )}

      {/* ── App Picker Modal ── */}
      <Modal
        visible={showAppPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAppPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Select Target App</Text>
            <TouchableOpacity
              style={styles.modalRow}
              onPress={() => { setSelectedPkg(''); setShowAppPicker(false); }}>
              <Text style={[styles.modalItem, selectedPkg === '' && styles.modalItemSelected]}>
                All Apps (no filter)
              </Text>
            </TouchableOpacity>
            <ScrollView style={{ maxHeight: 380 }}>
              {apps.map(app => (
                <TouchableOpacity
                  key={app.packageName}
                  style={styles.modalRow}
                  onPress={() => { setSelectedPkg(app.packageName); setShowAppPicker(false); }}>
                  <Text style={[styles.modalItem, selectedPkg === app.packageName && styles.modalItemSelected]}>
                    {app.appName}
                  </Text>
                  <Text style={styles.modalPkg}>{app.packageName}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowAppPicker(false)}>
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0d0d0d' },
  header:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 },
  headerTitle: { color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 13, letterSpacing: 2 },
  statusDot:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot:         { width: 8, height: 8, borderRadius: 4 },
  statusText:  { fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold', letterSpacing: 2 },

  statsBar:    { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 6, backgroundColor: '#111', marginHorizontal: 0, borderBottomWidth: 1, borderColor: '#1a1a1a' },
  stat:        { color: '#555', fontFamily: 'monospace', fontSize: 11 },
  statVal:     { color: '#00ff88' },

  controls:    { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center' },
  appPickerBtn:{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#111', borderWidth: 1, borderColor: '#1f1f1f', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 4 },
  appPickerText:{ color: '#00ff88', fontFamily: 'monospace', fontSize: 12, flex: 1 },
  chevron:     { color: '#333', fontSize: 10, marginLeft: 4 },
  btn:         { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  btnStart:    { backgroundColor: '#00ff88' },
  btnStop:     { backgroundColor: '#1a0000', borderWidth: 1, borderColor: '#ff3333' },
  btnExport:   { backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  btnTextDark: { color: '#000', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 12 },
  btnTextRed:  { color: '#ff3333', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 12 },
  btnTextGray: { color: '#555', fontFamily: 'monospace', fontSize: 12 },

  filterBar:   { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingBottom: 6 },
  filterBtn:   { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 3, borderWidth: 1, borderColor: '#1a1a1a', backgroundColor: '#111' },
  filterActive:{ borderColor: '#00ff88', backgroundColor: '#001a0d' },
  filterText:  { color: '#444', fontFamily: 'monospace', fontSize: 11 },
  filterTextActive: { color: '#00ff88' },

  search:      { marginHorizontal: 10, marginBottom: 4, backgroundColor: '#111', borderRadius: 4, paddingHorizontal: 10, paddingVertical: 5, color: '#00ff88', fontFamily: 'monospace', fontSize: 12, borderWidth: 1, borderColor: '#1a1a1a' },

  colHeader:   { paddingHorizontal: 10, paddingBottom: 4 },
  colText:     { color: '#222', fontFamily: 'monospace', fontSize: 10 },

  list:        { flex: 1 },
  row:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 3, borderBottomWidth: 1, borderColor: '#0f0f0f' },
  time:        { color: '#2a2a2a', fontFamily: 'monospace', fontSize: 10, width: 90 },
  proto:       { fontFamily: 'monospace', fontSize: 10, fontWeight: 'bold', width: 50 },
  host:        { flex: 1, color: '#aaaaaa', fontFamily: 'monospace', fontSize: 11 },
  port:        { color: '#333', fontFamily: 'monospace', fontSize: 10, width: 42, textAlign: 'right' },
  size:        { color: '#222', fontFamily: 'monospace', fontSize: 10, width: 38, textAlign: 'right' },

  empty:       { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText:   { color: '#1a1a1a', fontFamily: 'monospace', fontSize: 13, letterSpacing: 1 },

  clearBtn:    { alignItems: 'center', paddingVertical: 6, borderTopWidth: 1, borderColor: '#111' },
  clearText:   { color: '#1f1f1f', fontFamily: 'monospace', fontSize: 11, letterSpacing: 3 },

  // Modal
  modalOverlay:{ flex: 1, backgroundColor: '#000000cc', justifyContent: 'flex-end' },
  modalBox:    { backgroundColor: '#111', borderTopWidth: 1, borderColor: '#00ff8833', padding: 16, maxHeight: '75%' },
  modalTitle:  { color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 14, marginBottom: 12, letterSpacing: 2 },
  modalRow:    { paddingVertical: 10, borderBottomWidth: 1, borderColor: '#1a1a1a' },
  modalItem:   { color: '#888', fontFamily: 'monospace', fontSize: 13 },
  modalItemSelected: { color: '#00ff88' },
  modalPkg:    { color: '#333', fontFamily: 'monospace', fontSize: 10, marginTop: 2 },
  modalClose:  { marginTop: 12, alignItems: 'center', paddingVertical: 10, borderWidth: 1, borderColor: '#1a1a1a', borderRadius: 4 },
  modalCloseText: { color: '#555', fontFamily: 'monospace', fontSize: 13 },
});

import React, {useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  DeviceEventEmitter,
  EmitterSubscription,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {rootBridge} from '../native/RootBridge';

// Latest stable frida version — update when new releases come out
const FRIDA_VERSION = '16.5.9';
const BINARIES_READY_KEY = 'fridaBinariesReady_' + FRIDA_VERSION;

export default function HomeScreen() {
  const [rootStatus, setRootStatus] = useState<'checking' | 'granted' | 'denied'>('checking');
  const [fridaStatus, setFridaStatus] = useState<'stopped' | 'starting' | 'running' | 'error'>('stopped');
  const [setupStatus, setSetupStatus] = useState<'idle' | 'checking' | 'downloading' | 'done' | 'error'>('idle');
  const [log, setLog] = useState<string[]>([]);
  const dlListeners = useRef<EmitterSubscription[]>([]);

  const addLog = (msg: string) =>
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 50)]);

  useEffect(() => {
    checkRoot();
  }, []);

  const checkRoot = async () => {
    try {
      const hasRoot = await rootBridge.checkRoot();
      setRootStatus(hasRoot ? 'granted' : 'denied');
      addLog(hasRoot ? '✓ Root access granted' : '✗ Root access denied');
      if (hasRoot) {
        checkFridaStatus();
        // Only run ensureBinaries if not already confirmed ready this session
        const alreadyReady = await AsyncStorage.getItem(BINARIES_READY_KEY);
        if (alreadyReady === '1') {
          setSetupStatus('done');
          addLog('✓ Binaries already present');
        } else {
          ensureBinaries();
        }
      }
    } catch (e) {
      setRootStatus('denied');
      addLog('✗ Root check failed: ' + e);
    }
  };

  const checkFridaStatus = async () => {
    try {
      const running = await rootBridge.isFridaRunning();
      setFridaStatus(running ? 'running' : 'stopped');
      addLog(running ? '✓ frida-server already running' : '○ frida-server stopped');
    } catch (e) {
      addLog('frida check error: ' + e);
    }
  };

  // Cleanup download event listeners
  const removeDownloadListeners = () => {
    dlListeners.current.forEach(s => s.remove());
    dlListeners.current = [];
  };

  // Auto-setup: check binaries, launch DownloadService if missing, listen for events
  const ensureBinaries = async () => {
    setSetupStatus('checking');
    try {
      const status = await rootBridge.checkBinaries();
      if (status.fridaServer && status.fridaCli && status.fridaGadget) {
        addLog(`✓ Binaries ready — server:${status.fridaServerSize} inject:${status.fridaCliSize} gadget:${status.fridaGadgetSize}`);
        setSetupStatus('done');
        await AsyncStorage.setItem(BINARIES_READY_KEY, '1');
        return;
      }
      const missing = [
        !status.fridaServer  && 'frida-server',
        !status.fridaCli     && 'frida-inject',
        !status.fridaGadget  && 'frida-gadget',
      ].filter(Boolean).join(', ');

      addLog(`▶ Missing: ${missing} — launching download service...`);
      setSetupStatus('downloading');

      // Remove any stale listeners first
      removeDownloadListeners();

      // Listen to broadcast events forwarded from RootBridgeModule
      dlListeners.current.push(
        DeviceEventEmitter.addListener('FridaDownloadProgress', (e: {binary: string; percent: number}) => {
          addLog(`  ${e.binary}: ${e.percent}%`);
        }),
        DeviceEventEmitter.addListener('FridaDownloadDone', async (e: {message: string}) => {
          removeDownloadListeners();
          e.message.split('\n').filter(Boolean).forEach(l => addLog(l));
          // Verify binaries are actually in place
          try {
            const after = await rootBridge.checkBinaries();
            if (after.fridaServer) {
              addLog(`✓ Setup complete (server: ${after.fridaServerSize})`);
              setSetupStatus('done');
              // Save flag so we skip download check on next app open
              await AsyncStorage.setItem(BINARIES_READY_KEY, '1');
            } else {
              addLog('✗ frida-server still missing after download');
              setSetupStatus('error');
            }
          } catch {
            setSetupStatus('done');
            await AsyncStorage.setItem(BINARIES_READY_KEY, '1');
          }
        }),
        DeviceEventEmitter.addListener('FridaDownloadError', (e: {message: string}) => {
          removeDownloadListeners();
          addLog(`✗ Download failed: ${e.message}`);
          setSetupStatus('error');
        }),
      );

      // Start the ForegroundService — promise resolves immediately with "started"
      await rootBridge.downloadFridaBinaries(FRIDA_VERSION);

    } catch (e: any) {
      removeDownloadListeners();
      addLog('✗ Setup error: ' + e.message);
      setSetupStatus('error');
    }
  };

  const toggleFrida = async () => {
    if (fridaStatus === 'running') {
      try {
        await rootBridge.stopFridaServer();
        setFridaStatus('stopped');
        addLog('○ frida-server stopped');
      } catch (e) {
        addLog('Stop error: ' + e);
      }
    } else {
      setFridaStatus('starting');
      addLog('▶ Starting frida-server...');
      try {
        const result = await rootBridge.startFridaServer();
        setFridaStatus('running');
        addLog('✓ ' + result);
      } catch (e) {
        setFridaStatus('error');
        addLog('✗ Start failed: ' + e);
      }
    }
  };

  const statusColor = {
    checking: '#888',
    granted: '#00ff88',
    denied: '#ff4444',
  }[rootStatus];

  const fridaColor = {
    stopped: '#888',
    starting: '#ffaa00',
    running: '#00ff88',
    error: '#ff4444',
  }[fridaStatus];

  const setupColor = {idle:'#555', checking:'#ffaa00', downloading:'#ffaa00', done:'#00ff88', error:'#ff4444'}[setupStatus];
  const setupLabel = {idle:'—', checking:'CHECKING...', downloading:'DOWNLOADING...', done:'READY', error:'ERROR'}[setupStatus];

  return (
    <View style={s.container}>
      <View style={s.card}>
        <Text style={s.label}>ROOT STATUS</Text>
        <Text style={[s.status, {color: statusColor}]}>
          {rootStatus.toUpperCase()}
        </Text>
      </View>

      <View style={s.card}>
        <Text style={s.label}>FRIDA BINARIES</Text>
        <View style={s.row}>
          {(setupStatus === 'checking' || setupStatus === 'downloading') &&
            <ActivityIndicator color="#ffaa00" size="small" style={{marginRight: 8}} />}
          <Text style={[s.status, {color: setupColor, fontSize: 16}]}>{setupLabel}</Text>
        </View>
        {setupStatus === 'error' && (
          <TouchableOpacity style={[s.btn, s.btnGreen, {marginTop: 6}]} onPress={ensureBinaries}>
            <Text style={s.btnText}>RETRY SETUP</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={s.card}>
        <Text style={s.label}>FRIDA-SERVER</Text>
        <Text style={[s.status, {color: fridaColor}]}>
          {fridaStatus.toUpperCase()}
        </Text>
        <TouchableOpacity
          style={[s.btn, fridaStatus === 'running' ? s.btnRed : s.btnGreen]}
          onPress={toggleFrida}
          disabled={fridaStatus === 'starting' || rootStatus !== 'granted'}>
          <Text style={s.btnText}>
            {fridaStatus === 'running' ? 'STOP' : fridaStatus === 'starting' ? 'STARTING...' : 'START'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={[s.card, {flex: 1}]}>
        <Text style={s.label}>LOG</Text>
        <ScrollView>
          {log.map((l, i) => (
            <Text key={i} style={s.logLine}>{l}</Text>
          ))}
        </ScrollView>
      </View>

      {/* Permanent developer credit */}
      <View style={s.creditBar}>
        <Text style={s.creditText}>Developer Haider (Apex tracker) 💀</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d', padding: 12, gap: 10},
  card: {backgroundColor: '#111', borderRadius: 8, padding: 14, borderWidth: 1, borderColor: '#1e1e1e'},
  label: {color: '#444', fontSize: 11, fontFamily: 'monospace', marginBottom: 4},
  status: {fontSize: 22, fontFamily: 'monospace', fontWeight: 'bold'},
  btn: {marginTop: 10, padding: 10, borderRadius: 6, alignItems: 'center'},
  btnGreen: {backgroundColor: '#003d22'},
  btnRed: {backgroundColor: '#3d0000'},
  btnText: {color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold'},
  logLine: {color: '#00cc66', fontFamily: 'monospace', fontSize: 11, marginBottom: 2},
  row: {flexDirection: 'row', alignItems: 'center', marginBottom: 2},
  creditBar: {
    alignItems: 'center',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#1a1a1a',
  },
  creditText: {
    color: '#1a3a22',
    fontFamily: 'monospace',
    fontSize: 11,
    letterSpacing: 2,
  },
});

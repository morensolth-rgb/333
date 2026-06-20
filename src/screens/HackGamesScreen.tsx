import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  Alert, NativeEventEmitter, NativeModules, AppState, AppStateStatus,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rootBridge } from '../native/RootBridge';
import { LICENSE_KEY_STORAGE, LICENSE_EMAIL_STORAGE } from './LicenseScreen';

const API = 'https://fridact-6mzysus-preview-4200.runable.site/api';

const eventEmitter = new NativeEventEmitter(NativeModules.RootBridge);

type Game = { id: number; name: string; package: string; company: string };

const COMPANY_COLOR: Record<string, string> = {
  appsflyer: '#e85d04',
  adjust:    '#0077b6',
  singular:  '#7b2d8b',
};

export default function HackGamesScreen() {
  const [games, setGames]         = useState<Game[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [running, setRunning]     = useState(false);
  const [activeGame, setActiveGame] = useState<Game | null>(null);
  const [output, setOutput]       = useState<string[]>([]);
  const [overlayActive, setOverlayActive] = useState(false);

  const listenerRef = useRef<any>(null);
  const runningRef  = useRef(false);

  // flush logs when app comes to foreground
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', async (s: AppStateStatus) => {
      if (s === 'active' && runningRef.current) {
        try {
          const lines: string[] = await rootBridge.flushPendingLogs();
          if (lines.length > 0) setOutput(p => [...p, ...lines].slice(-500));
        } catch (_) {}
      }
    });
    return () => sub.remove();
  }, []);

  React.useEffect(() => {
    return () => { listenerRef.current?.remove(); };
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchGames();
    }, []),
  );

  const fetchGames = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${API}/games`);
      const j = await r.json() as { games?: Game[]; error?: string };
      if (j.error) { setError(j.error); }
      else setGames(j.games ?? []);
    } catch (e: any) {
      setError('Network error — ' + (e?.message ?? ''));
    }
    setLoading(false);
  };

  const addOut = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setOutput(prev => {
      const next = [...prev, `[${ts}] ${msg}`];
      return next.length > 500 ? next.slice(-500) : next;
    });
  };

  const stopScript = async () => {
    try { await rootBridge.stopScript(); } catch (_) {}
    listenerRef.current?.remove();
    listenerRef.current = null;
    runningRef.current = false;
    setRunning(false);
    setActiveGame(null);
    addOut('⏹ Stopped');
    try { await rootBridge.hideFloatingLog(); } catch (_) {}
    setOverlayActive(false);
  };

  const runGame = async (game: Game) => {
    if (running) {
      Alert.alert('Running', 'Stop the current session first');
      return;
    }

    // get license
    const licenseKey = await AsyncStorage.getItem(LICENSE_KEY_STORAGE);
    const email      = await AsyncStorage.getItem(LICENSE_EMAIL_STORAGE);
    if (!licenseKey || !email) {
      Alert.alert('License Required', 'Open the License tab and activate first');
      return;
    }

    // fetch script from server
    setLoading(true);
    let script = '';
    try {
      const r = await fetch(`${API}/games/${game.id}/script`, {
        headers: {
          'X-License-Key': licenseKey,
          'X-User-Email':  email,
        },
      });
      const j = await r.json() as { script?: string; error?: string };
      if (j.error || !j.script) {
        Alert.alert('Error', j.error ?? 'Failed to fetch script');
        setLoading(false);
        return;
      }
      script = j.script;
    } catch (e: any) {
      Alert.alert('Network Error', e?.message ?? 'Failed to reach server');
      setLoading(false);
      return;
    }
    setLoading(false);

    // run
    listenerRef.current?.remove();
    listenerRef.current = eventEmitter.addListener('FridaScriptLog', (data: { line: string }) => {
      addOut(data.line);
    });

    setRunning(true);
    runningRef.current = true;
    setActiveGame(game);
    setOutput([]);
    addOut(`▶ Targeting ${game.package} [${game.company}]...`);

    try {
      await rootBridge.showFloatingLog();
      setOverlayActive(true);
    } catch (_) {}

    try {
      const result = await rootBridge.runScript(game.package, script, 'name');
      if (result.startsWith('running:')) {
        addOut('✓ Injected — streaming live');
      } else {
        addOut(result);
        runningRef.current = false;
        setRunning(false);
        setActiveGame(null);
        listenerRef.current?.remove();
        listenerRef.current = null;
        try { await rootBridge.hideFloatingLog(); } catch (_) {}
        setOverlayActive(false);
      }
    } catch (e: any) {
      addOut('✗ ' + (e?.message ?? String(e)));
      runningRef.current = false;
      setRunning(false);
      setActiveGame(null);
      listenerRef.current?.remove();
      listenerRef.current = null;
      try { await rootBridge.hideFloatingLog(); } catch (_) {}
      setOverlayActive(false);
    }
  };

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.headerRow}>
        <Text style={s.title}>HACK GAMES AUTO</Text>
        <TouchableOpacity onPress={fetchGames} style={s.refreshBtn}>
          <Text style={s.refreshText}>↻</Text>
        </TouchableOpacity>
      </View>

      {/* Running banner */}
      {running && activeGame && (
        <View style={s.runBanner}>
          <View style={s.runDot} />
          <Text style={s.runBannerText} numberOfLines={1}>
            LIVE — {activeGame.name}
          </Text>
          <TouchableOpacity style={s.stopBtn} onPress={stopScript}>
            <Text style={s.stopBtnText}>■ STOP</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Error */}
      {!!error && (
        <View style={s.errorBox}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      )}

      {/* Games list */}
      {loading && !games.length
        ? <Text style={s.hint}>Loading...</Text>
        : games.length === 0
        ? <Text style={s.hint}>No games available</Text>
        : (
          <FlatList
            data={games}
            keyExtractor={g => String(g.id)}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: 12 }}
            renderItem={({ item }) => {
              const color = COMPANY_COLOR[item.company] ?? '#00ff88';
              const isActive = activeGame?.id === item.id;
              return (
                <View style={[s.card, isActive && s.cardActive]}>
                  <View style={{ flex: 1 }}>
                    <View style={s.cardTop}>
                      <Text style={s.gameName}>{item.name}</Text>
                      <View style={[s.badge, { borderColor: color + '55', backgroundColor: color + '18' }]}>
                        <Text style={[s.badgeText, { color }]}>{item.company.toUpperCase()}</Text>
                      </View>
                    </View>
                    <Text style={s.gamePkg} numberOfLines={1}>{item.package}</Text>
                  </View>
                  <TouchableOpacity
                    style={[s.runBtn, isActive && s.runBtnActive, running && !isActive && s.runBtnDim]}
                    onPress={() => runGame(item)}
                    disabled={running && !isActive}
                  >
                    <Text style={s.runBtnText}>{isActive ? '■ STOP' : '▶ RUN'}</Text>
                  </TouchableOpacity>
                </View>
              );
            }}
          />
        )
      }

      {/* Output console */}
      {output.length > 0 && (
        <View style={s.console}>
          <View style={s.consoleHeader}>
            <Text style={s.consoleLabel}>OUTPUT ({output.length})</Text>
            <TouchableOpacity onPress={() => setOutput([])}>
              <Text style={s.consoleClear}>CLEAR</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={output}
            keyExtractor={(_, i) => String(i)}
            style={s.consoleList}
            onContentSizeChange={() => {}}
            initialNumToRender={20}
            maxToRenderPerBatch={20}
            renderItem={({ item }) => (
              <Text style={[s.consoleLine, item.includes('✗') && s.consoleErr]}>{item}</Text>
            )}
          />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0d0d0d', padding: 12, gap: 10 },
  headerRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title:       { color: '#00ff88', fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold', letterSpacing: 1 },
  refreshBtn:  { padding: 6 },
  refreshText: { color: '#333', fontSize: 18 },
  hint:        { color: '#333', fontFamily: 'monospace', fontSize: 12, textAlign: 'center', marginTop: 40 },
  errorBox:    { backgroundColor: '#1a0000', borderRadius: 7, padding: 10, borderWidth: 1, borderColor: '#3d0000' },
  errorText:   { color: '#ff4444', fontFamily: 'monospace', fontSize: 11 },
  runBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#001a0d', borderRadius: 8, padding: 10,
    borderWidth: 1, borderColor: '#00ff8833',
  },
  runDot:       { width: 8, height: 8, borderRadius: 4, backgroundColor: '#00ff88' },
  runBannerText:{ flex: 1, color: '#00ff88', fontFamily: 'monospace', fontSize: 11 },
  stopBtn:      { backgroundColor: '#3d0000', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  stopBtnText:  { color: '#ff4444', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 11 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#111', borderRadius: 9, padding: 14,
    borderWidth: 1, borderColor: '#1a1a1a', marginBottom: 8,
  },
  cardActive:  { borderColor: '#00ff8844', backgroundColor: '#001a0d' },
  cardTop:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  gameName:    { color: '#ddd', fontFamily: 'monospace', fontSize: 13 },
  gamePkg:     { color: '#444', fontFamily: 'monospace', fontSize: 10 },
  badge: {
    borderWidth: 1, borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  badgeText:   { fontFamily: 'monospace', fontSize: 9, fontWeight: 'bold' },
  runBtn: {
    backgroundColor: '#003d22', borderRadius: 7,
    paddingHorizontal: 14, paddingVertical: 9,
  },
  runBtnActive: { backgroundColor: '#3d0000' },
  runBtnDim:    { backgroundColor: '#1a1a1a', opacity: 0.4 },
  runBtnText:   { color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 11 },
  console: {
    height: 180, backgroundColor: '#080808',
    borderRadius: 8, padding: 10,
    borderWidth: 1, borderColor: '#1e1e1e',
  },
  consoleHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  consoleLabel:  { color: '#333', fontFamily: 'monospace', fontSize: 10 },
  consoleClear:  { color: '#333', fontFamily: 'monospace', fontSize: 10 },
  consoleList:   { flex: 1 },
  consoleLine:   { color: '#00cc44', fontFamily: 'monospace', fontSize: 10, marginBottom: 1 },
  consoleErr:    { color: '#ff4444' },
});

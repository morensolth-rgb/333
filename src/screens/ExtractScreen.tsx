import React, {useEffect, useState, useRef, useCallback} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
} from 'react-native';
import {rootBridge, LocateResult, DumpResult, ExtractResult} from '../native/RootBridge';

type Stage = 'idle' | 'locating' | 'dumping' | 'extracting' | 'done' | 'error';

interface LogLine {
  text: string;
  kind: 'info' | 'ok' | 'err';
}

export default function ExtractScreen({route, navigation}: any) {
  const pkg: string = route?.params?.packageName ?? '';
  const appName: string = route?.params?.appName ?? pkg;

  const [stage, setStage] = useState<Stage>('idle');
  const [log, setLog] = useState<LogLine[]>([]);
  const [locate, setLocate] = useState<LocateResult | null>(null);
  const [dump, setDump] = useState<DumpResult | null>(null);
  const [extract, setExtract] = useState<ExtractResult | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const addLog = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLog(prev => [...prev, {text, kind}]);
    setTimeout(() => scrollRef.current?.scrollToEnd({animated: true}), 50);
  }, []);

  const reset = () => {
    setLog([]);
    setLocate(null);
    setDump(null);
    setExtract(null);
    setStage('idle');
  };

  const runPipeline = useCallback(async () => {
    if (!pkg) return;
    reset();
    try {
      // 1) locate
      setStage('locating');
      addLog(`[1/3] Locating Unity/IL2CPP files in ${pkg} ...`);
      const loc = await rootBridge.locateUnityFiles(pkg);
      setLocate(loc);
      if (!loc.isUnity) {
        addLog('Not a Unity game — no global-metadata.dat / *.unity3d found.', 'err');
        setStage('error');
        return;
      }
      addLog(`  metadata: ${loc.hasMetadata ? 'FOUND' : 'missing'}`, loc.hasMetadata ? 'ok' : 'err');
      addLog(`  libil2cpp.so: ${loc.hasLib ? 'FOUND' : 'missing'}`, loc.hasLib ? 'ok' : 'err');
      addLog(`  unity assets entries: ${loc.unity3d.length}`);

      // 2) dump
      if (loc.hasMetadata && loc.hasLib) {
        setStage('dumping');
        addLog('[2/3] Dumping IL2CPP (this can take a minute) ...');
        const d = await rootBridge.dumpIl2cpp(pkg);
        setDump(d);
        if (d.success) {
          addLog(`  dump.cs ready (${d.dumpCsSize ?? '?'})`, 'ok');
        } else {
          addLog('  dump failed. Tail of dumper log:', 'err');
          (d.log || '').split('\n').slice(-8).forEach(l => addLog(`  ${l}`, 'err'));
        }
      } else {
        addLog('[2/3] Skipping dump — metadata/lib missing.', 'err');
      }

      // 3) extract
      setStage('extracting');
      addLog('[3/3] Extracting Unity assets via UnityPy ...');
      const ex = await rootBridge.extractUnityAssets(pkg);
      setExtract(ex);
      addLog(ex.summary || 'Done.', 'ok');

      setStage('done');
      addLog('All done. Open the Files tab to browse results.', 'ok');
    } catch (e: any) {
      addLog(`Error: ${e?.message ?? String(e)}`, 'err');
      setStage('error');
    }
  }, [pkg, addLog]);

  useEffect(() => {
    if (pkg) runPipeline();
  }, [pkg, runPipeline]);

  const busy = stage === 'locating' || stage === 'dumping' || stage === 'extracting';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{appName}</Text>
        <Text style={styles.pkg}>{pkg}</Text>
        <View style={styles.statusRow}>
          {busy && <ActivityIndicator color="#00ff88" size="small" style={{marginRight: 8}} />}
          <Text style={[styles.status, stage === 'error' && {color: '#ff5555'}, stage === 'done' && {color: '#00ff88'}]}>
            {stage.toUpperCase()}
          </Text>
        </View>
      </View>

      <ScrollView ref={scrollRef} style={styles.logBox} contentContainerStyle={{padding: 10}}>
        {log.map((l, i) => (
          <Text
            key={i}
            style={[
              styles.logLine,
              l.kind === 'ok' && {color: '#00ff88'},
              l.kind === 'err' && {color: '#ff6666'},
            ]}>
            {l.text}
          </Text>
        ))}
        {log.length === 0 && <Text style={styles.logLine}>Preparing...</Text>}
      </ScrollView>

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.btn, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={runPipeline}>
          <Text style={styles.btnText}>{busy ? 'Working…' : 'Run Again'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.btnAlt]}
          onPress={() => navigation.navigate('Files', {packageName: pkg, appName})}>
          <Text style={styles.btnText}>Browse Files</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d'},
  header: {padding: 14, borderBottomWidth: 1, borderBottomColor: '#1a1a1a'},
  title: {color: '#fff', fontSize: 18, fontFamily: 'monospace', fontWeight: 'bold'},
  pkg: {color: '#555', fontSize: 11, fontFamily: 'monospace', marginTop: 2},
  statusRow: {flexDirection: 'row', alignItems: 'center', marginTop: 8},
  status: {color: '#ffaa00', fontFamily: 'monospace', fontSize: 12, letterSpacing: 2},
  logBox: {flex: 1, margin: 10, backgroundColor: '#050505', borderWidth: 1, borderColor: '#1a1a1a'},
  logLine: {color: '#999', fontFamily: 'monospace', fontSize: 11, lineHeight: 17},
  buttons: {flexDirection: 'row', gap: 10, padding: 10},
  btn: {
    flex: 1, backgroundColor: '#00ff88', padding: 13, alignItems: 'center', borderRadius: 3,
  },
  btnAlt: {backgroundColor: '#1a3a2a', borderWidth: 1, borderColor: '#00ff88'},
  btnDisabled: {opacity: 0.4},
  btnText: {color: '#fff', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 13},
});

import React, {useEffect, useState, useCallback} from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Modal,
  ScrollView,
  ToastAndroid,
  BackHandler,
} from 'react-native';
import {rootBridge, FileEntry, TokenMatch, FileAnalysis} from '../native/RootBridge';

// ─── Token Hunt — pick a Unity file, type a token, scan raw objects ─────────
// Flow: browse filesystem → pick .unity3d/.assets/.bundle/... → enter token →
// HUNT → every matching object saved as {Type}_{path_id}_full.txt, tap to view.

const UNITY_EXTS = ['.unity3d', '.assets', '.bundle', '.unitypackage', '.dat', '.ress', '.resource'];
const START_DIRS = ['/sdcard', '/sdcard/Download', '/storage/emulated/0'];

type Step = 'browse' | 'token' | 'results';

export default function HuntFileScreen({navigation}: any) {
  const [step, setStep] = useState<Step>('browse');

  // ── browse state ──
  const [pathStack, setPathStack] = useState<string[]>([START_DIRS[0]]);
  const currentPath = pathStack[pathStack.length - 1];
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [dirError, setDirError] = useState('');

  // ── picked file + token ──
  const [picked, setPicked] = useState<{path: string; name: string} | null>(null);
  const [token, setToken] = useState('');

  // ── hunt state ──
  const [hunting, setHunting] = useState(false);
  const [matches, setMatches] = useState<TokenMatch[]>([]);
  const [huntError, setHuntError] = useState('');

  // ── viewer state ──
  const [viewer, setViewer] = useState<{name: string; content: string; label: string} | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewer) { setViewer(null); return true; }
      if (step === 'results') { setStep('token'); return true; }
      if (step === 'token') { setStep('browse'); return true; }
      if (pathStack.length > 1) { setPathStack(s => s.slice(0, -1)); return true; }
      return false;
    });
    return () => sub.remove();
  }, [viewer, step, pathStack]);

  const loadDir = useCallback(async (path: string) => {
    setLoadingDir(true);
    setDirError('');
    try {
      const list = await rootBridge.readDir(path);
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(list);
    } catch (e: any) {
      setDirError(e?.message ?? 'Cannot read directory');
      setEntries([]);
    }
    setLoadingDir(false);
  }, []);

  useEffect(() => {
    if (step === 'browse') loadDir(currentPath);
  }, [currentPath, step, loadDir]);

  const isUnityFile = (name: string) => {
    const low = name.toLowerCase();
    return UNITY_EXTS.some(ext => low.endsWith(ext));
  };

  const pickFile = (entry: FileEntry) => {
    setPicked({path: entry.path, name: entry.name});
    setStep('token');
  };

  // Direct path input — for files the browser can't reach (Android/data,
  // Termux home, etc.). Accepts a file path (→ pick) or a dir path (→ browse).
  const [directPath, setDirectPath] = useState('');

  const goDirectPath = () => {
    const p = directPath.trim();
    if (!p) return;
    const name = p.split('/').filter(Boolean).pop() ?? p;
    if (isUnityFile(name)) {
      setPicked({path: p, name});
      setStep('token');
    } else {
      setPathStack([p]);
    }
  };

  const runHunt = async () => {
    const t = token.trim();
    if (!t || !picked || hunting) return;
    setHunting(true);
    setHuntError('');
    setMatches([]);
    setStep('results');
    try {
      const res = await rootBridge.huntTokenInFile(picked.path, t);
      if (res.error) {
        setHuntError(res.error);
      }
      setMatches(res.matches ?? []);
    } catch (e: any) {
      setHuntError(e?.message ?? String(e));
    }
    setHunting(false);
  };

  const openMatch = async (m: TokenMatch) => {
    setViewerLoading(true);
    setViewer({name: m.file, content: '', label: `${m.type} · path_id ${m.path_id}`});
    try {
      const a: FileAnalysis = await rootBridge.analyzeFile(m.path);
      setViewer({name: m.file, content: a.preview, label: `${m.type} · path_id ${m.path_id} · ${a.label}`});
    } catch (e: any) {
      setViewer({name: m.file, content: `Cannot read: ${e?.message ?? e}`, label: m.type});
    }
    setViewerLoading(false);
  };

  const fmtSize = (n: number) =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;

  // ─────────────────────────── render ───────────────────────────

  const renderBrowse = () => (
    <>
      <Text style={s.stepTitle}>1 · اختار ملف اليونتي</Text>
      <Text style={s.stepHint}>.unity3d / .assets / .bundle / .dat ...</Text>

      {/* quick start dirs */}
      <View style={s.quickRow}>
        {START_DIRS.map(d => (
          <TouchableOpacity
            key={d}
            style={[s.quickChip, currentPath === d && s.quickChipActive]}
            onPress={() => setPathStack([d])}>
            <Text style={s.quickText}>{d.replace('/storage/emulated/0', 'sdcard0')}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* path bar */}
      <View style={s.pathRow}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => pathStack.length > 1 && setPathStack(s => s.slice(0, -1))}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pathText} numberOfLines={1} ellipsizeMode="middle">{currentPath}</Text>
      </View>

      {/* direct path — paste full path if the file doesn't show in the browser */}
      <View style={s.directRow}>
        <TextInput
          style={s.directInput}
          placeholder="أو الصق المسار الكامل هون: /sdcard/.../data.unity3d"
          placeholderTextColor="#444"
          value={directPath}
          onChangeText={setDirectPath}
          onSubmitEditing={goDirectPath}
          returnKeyType="go"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={s.directBtn} onPress={goDirectPath}>
          <Text style={s.directBtnText}>GO</Text>
        </TouchableOpacity>
      </View>

      {loadingDir ? (
        <View style={s.center}>
          <ActivityIndicator color="#00ff88" size="large" />
        </View>
      ) : dirError ? (
        <View style={s.center}>
          <Text style={s.errText}>⚠ {dirError}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => loadDir(currentPath)}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.path}
          initialNumToRender={40}
          renderItem={({item}) => {
            const unity = !item.isDir && isUnityFile(item.name);
            return (
              <TouchableOpacity
                style={[s.entry, unity && s.entryUnity]}
                onPress={() => (item.isDir ? setPathStack(s => [...s, item.path]) : pickFile(item))}>
                <Text style={s.entryIcon}>{item.isDir ? '📁' : unity ? '🎮' : '📄'}</Text>
                <View style={s.entryInfo}>
                  <Text style={[s.entryName, item.isDir && s.dirName, unity && s.unityName]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {!!item.size && <Text style={s.entryMeta}>{item.size}</Text>}
                </View>
                {item.isDir && <Text style={s.chevron}>›</Text>}
                {unity && <Text style={s.pickBadge}>PICK</Text>}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<Text style={s.empty}>Empty directory</Text>}
        />
      )}
    </>
  );

  const renderToken = () => (
    <View style={s.tokenBox}>
      <Text style={s.stepTitle}>2 · شو التوكن يلي بدك تدور عليه؟</Text>

      <View style={s.pickedCard}>
        <Text style={s.pickedLabel}>الملف المختار:</Text>
        <Text style={s.pickedName} numberOfLines={1}>{picked?.name}</Text>
        <Text style={s.pickedPath} numberOfLines={2}>{picked?.path}</Text>
        <TouchableOpacity onPress={() => setStep('browse')}>
          <Text style={s.changeLink}>← تغيير الملف</Text>
        </TouchableOpacity>
      </View>

      <TextInput
        style={s.tokenInput}
        placeholder="التوكن... مثال: q3h3hk"
        placeholderTextColor="#444"
        value={token}
        onChangeText={setToken}
        onSubmitEditing={runHunt}
        returnKeyType="go"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
      />

      <TouchableOpacity
        style={[s.huntGo, !token.trim() && s.huntGoDisabled]}
        disabled={!token.trim()}
        onPress={runHunt}>
        <Text style={s.huntGoText}>HUNT ▶</Text>
      </TouchableOpacity>

      <Text style={s.note}>
        بيفحص كل object بالملف (raw bytes, غير حسّاس لحالة الأحرف) وبيستخرج كل كائن فيه التوكن كملف مقروء.
      </Text>
    </View>
  );

  const renderResults = () => (
    <>
      <Text style={s.stepTitle}>3 · النتائج</Text>
      <View style={s.resultMeta}>
        <Text style={s.resultMetaText} numberOfLines={1}>
          {picked?.name} · token: "{token}"
        </Text>
        <TouchableOpacity onPress={() => setStep('token')}>
          <Text style={s.changeLink}>← بحث جديد</Text>
        </TouchableOpacity>
      </View>

      {hunting ? (
        <View style={s.center}>
          <ActivityIndicator color="#00ff88" size="large" />
          <Text style={s.hint}>جاري فحص كل الـ objects…</Text>
        </View>
      ) : huntError ? (
        <View style={s.center}>
          <Text style={s.errText}>⚠ {huntError}</Text>
        </View>
      ) : (
        <FlatList
          data={matches}
          keyExtractor={m => m.path}
          renderItem={({item: m}) => (
            <TouchableOpacity style={s.matchCard} onPress={() => openMatch(m)}>
              <View style={{flex: 1}}>
                <Text style={s.matchType}>
                  {m.type} · path_id {m.path_id}
                </Text>
                <Text style={s.matchFile} numberOfLines={1}>
                  {m.file} · {fmtSize(m.size)}
                </Text>
              </View>
              <Text style={s.chevron}>›</Text>
            </TouchableOpacity>
          )}
          ListHeaderComponent={
            matches.length > 0 ? (
              <Text style={s.huntHeader}>
                ✓ {matches.length} كائن فيه التوكن — انحفظوا كملفات مقروءة، اضغط لعرض أي واحد
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <Text style={s.empty}>
              ما انلاقى التوكن بأي object بهالملف
            </Text>
          }
        />
      )}
    </>
  );

  return (
    <View style={s.container}>
      {step === 'browse' && renderBrowse()}
      {step === 'token' && renderToken()}
      {step === 'results' && renderResults()}

      {/* viewer modal */}
      <Modal visible={!!viewer} animationType="slide" onRequestClose={() => setViewer(null)}>
        <View style={s.viewerContainer}>
          <View style={s.viewerHeader}>
            <Text style={s.viewerTitle} numberOfLines={1}>{viewer?.name}</Text>
            {!!viewer?.label && (
              <View style={s.typeBadge}>
                <Text style={s.typeBadgeText}>{viewer.label}</Text>
              </View>
            )}
            <TouchableOpacity onPress={() => setViewer(null)} style={s.closeBtn}>
              <Text style={s.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          {viewerLoading ? (
            <View style={s.center}>
              <ActivityIndicator color="#00ff88" size="large" />
            </View>
          ) : (
            <ScrollView style={s.viewerScroll}>
              <ScrollView horizontal>
                <Text style={s.viewerText} selectable>{viewer?.content}</Text>
              </ScrollView>
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d'},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20},
  stepTitle: {color: '#fff', fontSize: 16, fontFamily: 'monospace', fontWeight: 'bold', padding: 14, paddingBottom: 2},
  stepHint: {color: '#555', fontSize: 11, fontFamily: 'monospace', paddingHorizontal: 14, paddingBottom: 8},
  quickRow: {flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 8, flexWrap: 'wrap'},
  quickChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 3,
    borderWidth: 1, borderColor: '#222', backgroundColor: '#0a0a0a',
  },
  quickChipActive: {borderColor: '#00ff88', backgroundColor: '#0f2418'},
  quickText: {color: '#888', fontFamily: 'monospace', fontSize: 10},
  pathRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#1a1a1a',
  },
  backBtn: {paddingHorizontal: 8, paddingVertical: 2},
  backText: {color: '#00ff88', fontSize: 16, fontWeight: 'bold'},
  pathText: {flex: 1, color: '#666', fontFamily: 'monospace', fontSize: 10},
  directRow: {flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8},
  directInput: {
    flex: 1, backgroundColor: '#111', color: '#00ff88', borderWidth: 1, borderColor: '#1e3a2a',
    paddingHorizontal: 10, paddingVertical: 8, fontFamily: 'monospace', fontSize: 11, borderRadius: 3,
  },
  directBtn: {
    backgroundColor: '#0a2a18', borderWidth: 1, borderColor: '#00ff88',
    justifyContent: 'center', paddingHorizontal: 16, borderRadius: 3,
  },
  directBtnText: {color: '#00ff88', fontWeight: 'bold', fontFamily: 'monospace', fontSize: 12},
  entry: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#151515',
  },
  entryUnity: {backgroundColor: '#0a140d'},
  entryIcon: {fontSize: 16, marginRight: 10},
  entryInfo: {flex: 1},
  entryName: {color: '#ddd', fontFamily: 'monospace', fontSize: 12},
  dirName: {color: '#8fd'},
  unityName: {color: '#00ff88', fontWeight: 'bold'},
  entryMeta: {color: '#555', fontFamily: 'monospace', fontSize: 10, marginTop: 2},
  chevron: {color: '#00ff88', fontSize: 16, marginLeft: 8},
  pickBadge: {color: '#000', backgroundColor: '#00ff88', fontFamily: 'monospace', fontSize: 9, fontWeight: 'bold', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 2},
  empty: {color: '#444', textAlign: 'center', marginTop: 40, fontFamily: 'monospace', fontSize: 12},
  errText: {color: '#ff6666', fontFamily: 'monospace', fontSize: 12, textAlign: 'center'},
  retryBtn: {marginTop: 12, backgroundColor: '#1a3a2a', paddingHorizontal: 20, paddingVertical: 8, borderRadius: 3},
  retryText: {color: '#00ff88', fontFamily: 'monospace'},
  hint: {color: '#557755', fontFamily: 'monospace', fontSize: 11, marginTop: 12},

  tokenBox: {flex: 1, padding: 14},
  pickedCard: {
    backgroundColor: '#0a140d', borderWidth: 1, borderColor: '#1a3a2a',
    borderRadius: 4, padding: 12, marginVertical: 14,
  },
  pickedLabel: {color: '#557755', fontFamily: 'monospace', fontSize: 10},
  pickedName: {color: '#00ff88', fontFamily: 'monospace', fontSize: 14, fontWeight: 'bold', marginTop: 4},
  pickedPath: {color: '#555', fontFamily: 'monospace', fontSize: 10, marginTop: 2},
  changeLink: {color: '#7fd', fontFamily: 'monospace', fontSize: 11, marginTop: 8},
  tokenInput: {
    backgroundColor: '#111', color: '#00ff88', borderWidth: 1, borderColor: '#00ff88',
    paddingHorizontal: 12, paddingVertical: 12, fontFamily: 'monospace', fontSize: 16,
    borderRadius: 3, letterSpacing: 1,
  },
  huntGo: {backgroundColor: '#00ff88', marginTop: 14, padding: 14, alignItems: 'center', borderRadius: 3},
  huntGoDisabled: {opacity: 0.3},
  huntGoText: {color: '#000', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 15, letterSpacing: 2},
  note: {color: '#446', fontFamily: 'monospace', fontSize: 10, marginTop: 16, lineHeight: 16},

  resultMeta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingBottom: 10, gap: 10,
  },
  resultMetaText: {flex: 1, color: '#666', fontFamily: 'monospace', fontSize: 11},
  huntHeader: {color: '#557755', fontFamily: 'monospace', fontSize: 11, paddingHorizontal: 14, paddingVertical: 8},
  matchCard: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 4,
    backgroundColor: '#0a140d', borderWidth: 1, borderColor: '#1a3a2a', borderRadius: 4,
    paddingHorizontal: 12, paddingVertical: 12,
  },
  matchType: {color: '#00ff88', fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold'},
  matchFile: {color: '#557755', fontFamily: 'monospace', fontSize: 10, marginTop: 3},

  viewerContainer: {flex: 1, backgroundColor: '#0d0d0d'},
  viewerHeader: {
    flexDirection: 'row', alignItems: 'center', padding: 10,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a', gap: 6,
  },
  viewerTitle: {flex: 1, color: '#00ff88', fontFamily: 'monospace', fontSize: 12},
  typeBadge: {backgroundColor: '#123', borderColor: '#2a5a3a', borderWidth: 1, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2},
  typeBadgeText: {color: '#7fd', fontFamily: 'monospace', fontSize: 9},
  closeBtn: {padding: 6, paddingHorizontal: 12},
  closeBtnText: {color: '#fff', fontSize: 16},
  viewerScroll: {flex: 1, padding: 10},
  viewerText: {color: '#ccc', fontFamily: 'monospace', fontSize: 11, lineHeight: 16},
});

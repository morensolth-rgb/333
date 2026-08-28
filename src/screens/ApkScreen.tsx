import React, {useState, useCallback, useRef, useMemo} from 'react';
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
} from 'react-native';
import {rootBridge, FileAnalysis} from '../native/RootBridge';

// ─── Full-APK inspection screen (long-press flow) ────────────────────────────
// 1) Big extract button → inspectApk() unpacks EVERY entry of EVERY split and
//    converts binary formats to readable .txt (AXML/dex/Lua/protobuf/deobfusc).
// 2) File list + full-text search over everything extracted.
// 3) Tap a file → analyzeFile() detects type and shows a readable preview.

type Mode = 'files' | 'search';

interface FullFile {
  name: string;
  path: string;
  relative: string;
  size: string;
}

interface FullMatch {
  file: string;
  path: string;
  line: number;
  text: string;
}

interface FileGroup {
  path: string;
  relative: string;
  matches: FullMatch[];
}

function groupByFile(matches: FullMatch[]): FileGroup[] {
  const map = new Map<string, FileGroup>();
  for (const m of matches) {
    let g = map.get(m.path);
    if (!g) {
      g = {path: m.path, relative: m.file, matches: []};
      map.set(m.path, g);
    }
    g.matches.push(m);
  }
  return Array.from(map.values());
}

function HighlightedText({text, q, base, hi}: {text: string; q: string; base: any; hi: any}) {
  if (!q) return <Text style={base}>{text}</Text>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0, k = 0;
  while (true) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) { parts.push(<Text key={k++} style={base}>{text.slice(i)}</Text>); break; }
    if (idx > i) parts.push(<Text key={k++} style={base}>{text.slice(i, idx)}</Text>);
    parts.push(<Text key={k++} style={hi}>{text.slice(idx, idx + needle.length)}</Text>);
    i = idx + needle.length;
  }
  return <Text>{parts}</Text>;
}

const CONTEXT_LINES = 400;    // lines shown before AND after a search hit
const LINES_PER_PAGE = CONTEXT_LINES * 2 + 1;

export default function ApkScreen({route, navigation}: any) {
  const pkg: string = route?.params?.packageName ?? '';
  const appName: string = route?.params?.appName ?? pkg;

  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [log, setLog] = useState<{text: string; kind: string}[]>([]);
  const logScroll = useRef<ScrollView>(null);

  const [mode, setMode] = useState<Mode>('files');
  const [files, setFiles] = useState<FullFile[]>([]);
  const [fileFilter, setFileFilter] = useState('');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<FullMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [viewer, setViewer] = useState<{
    path: string; name: string; content: string;
    startLine: number; targetLine: number | null; q: string;
    typeLabel?: string;
  } | null>(null);
  const viewerScroll = useRef<ScrollView>(null);

  const addLog = useCallback((text: string, kind = 'info') => {
    setLog(prev => [...prev, {text, kind}]);
    setTimeout(() => logScroll.current?.scrollToEnd({animated: true}), 50);
  }, []);

  const loadFiles = useCallback(async () => {
    if (!pkg) return;
    try {
      const all = await rootBridge.listExtracted(pkg);
      const full = all.filter(f => f.relative.startsWith('apk_full/'));
      setFiles(full);
      return full.length;
    } catch (e) {
      console.error(e);
      return 0;
    }
  }, [pkg]);

  const runInspect = useCallback(async () => {
    if (!pkg) return;
    setPhase('running');
    setLog([]);
    try {
      addLog('استخراج كامل محتويات الـ APK (كل الـ splits) ...');
      addLog('وتحويل الملفات الثنائية لنصوص مقروءة — ممكن ياخد دقايق.');
      const r = await rootBridge.inspectApk(pkg);
      addLog(r.summary || 'Done.', 'ok');
      const n = await loadFiles();
      addLog(`جاهز — ${n} ملف بالقائمة. ابحث أو كبس ع أي ملف.`, 'ok');
      setPhase('done');
    } catch (e: any) {
      addLog(`خطأ: ${e?.message ?? String(e)}`, 'err');
      setPhase('error');
    }
  }, [pkg, addLog, loadFiles]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q || !pkg) return;
    setSearching(true);
    setMode('search');
    setExpanded(null);
    try {
      const res = await rootBridge.searchFiles(pkg, q, 'apkfull');
      setMatches(res);
    } catch (e: any) {
      setMatches([]);
      console.error(e);
    }
    setSearching(false);
  };

  const openFile = async (path: string, name: string, line?: number, q?: string) => {
    try {
      if (line && line > 0) {
        const start = Math.max(1, line - CONTEXT_LINES);
        const r = await rootBridge.readFileRange(path, start, LINES_PER_PAGE);
        setViewer({
          path, name, content: r.content, startLine: r.startLine,
          targetLine: line, q: q ?? '',
        });
        setTimeout(() => viewerScroll.current?.scrollTo({y: (line - start) * 16, animated: false}), 120);
      } else {
        const a: FileAnalysis = await rootBridge.analyzeFile(path);
        setViewer({
          path, name, content: a.preview, startLine: 1, targetLine: null,
          q: q ?? '', typeLabel: a.label,
        });
      }
    } catch (e: any) {
      setViewer({path, name, content: `Cannot read file: ${e?.message ?? e}`, startLine: 1, targetLine: null, q: ''});
    }
  };

  const jumpTo = async (delta: 1 | -1) => {
    if (!viewer) return;
    const inFile = matches.filter(m => m.path === viewer.path).sort((a, b) => a.line - b.line);
    if (!inFile.length) return;
    const cur = viewer.targetLine ?? 0;
    const next = delta === 1
      ? (inFile.find(m => m.line > cur) ?? inFile[0])
      : ([...inFile].reverse().find(m => m.line < cur) ?? inFile[inFile.length - 1]);
    await openFile(next.path, viewer.name, next.line, viewer.q);
  };

  const groups = useMemo(() => groupByFile(matches), [matches]);
  const shownFiles = fileFilter
    ? files.filter(f => f.relative.toLowerCase().includes(fileFilter.toLowerCase()))
    : files;

  const viewerLines = viewer ? viewer.content.split('\n') : [];

  // ── Extract phase: big button + live log ──────────────────────────────────
  if (phase !== 'done') {
    return (
      <View style={s.container}>
        <View style={s.header}>
          <Text style={s.title} numberOfLines={1}>{appName}</Text>
          <Text style={s.pkg}>{pkg}</Text>
          <Text style={s.subtitle}>استخراج APK كامل — كل الملفات بصيغة مقروءة</Text>
        </View>

        {phase === 'idle' || phase === 'error' ? (
          <View style={s.centerBox}>
            <TouchableOpacity style={s.bigBtn} onPress={runInspect}>
              <Text style={s.bigBtnText}>استخراج ملفات الـ APK</Text>
              <Text style={s.bigBtnSub}>يفك كل الـ splits ويحوّل الثنائي لمقروء</Text>
            </TouchableOpacity>
            {phase === 'error' && (
              <Text style={s.errText}>فشل الاستخراج — شوف اللوج تحت وجرب منيح</Text>
            )}
          </View>
        ) : (
          <View style={s.centerBox}>
            <ActivityIndicator color="#00ff88" size="large" />
            <Text style={s.working}>جاري الاستخراج والتحويل...</Text>
          </View>
        )}

        <ScrollView ref={logScroll} style={s.logBox} contentContainerStyle={{padding: 10}}>
          {log.map((l, i) => (
            <Text
              key={i}
              style={[
                s.logLine,
                l.kind === 'ok' && {color: '#00ff88'},
                l.kind === 'err' && {color: '#ff6666'},
              ]}>
              {l.text}
            </Text>
          ))}
        </ScrollView>
      </View>
    );
  }

  // ── Done phase: search + files + viewer ───────────────────────────────────
  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.title} numberOfLines={1}>{appName} — محتوى APK</Text>
        <Text style={s.pkg}>{pkg} · {files.length} ملف</Text>
      </View>

      <View style={s.searchRow}>
        <TextInput
          style={s.searchInput}
          placeholder="ابحث بكل محتويات الـ APK..."
          placeholderTextColor="#444"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={runSearch}
          returnKeyType="search"
          autoCapitalize="none"
        />
        <TouchableOpacity style={s.searchBtn} onPress={runSearch}>
          {searching ? <ActivityIndicator color="#000" size="small" /> : <Text style={s.searchBtnText}>FIND</Text>}
        </TouchableOpacity>
      </View>

      <View style={s.modeRow}>
        <TouchableOpacity onPress={() => setMode('files')} style={[s.modeTab, mode === 'files' && s.modeTabActive]}>
          <Text style={[s.modeText, mode === 'files' && s.modeTextActive]}>Files ({files.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMode('search')} style={[s.modeTab, mode === 'search' && s.modeTabActive]}>
          <Text style={[s.modeText, mode === 'search' && s.modeTextActive]}>Matches ({groups.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={loadFiles} style={s.reloadBtn}>
          <Text style={s.modeText}>⟳</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setPhase('idle')} style={s.reloadBtn}>
          <Text style={[s.modeText, {color: '#fa5'}]}>↻ استخراج</Text>
        </TouchableOpacity>
      </View>

      {mode === 'files' && (
        <>
          <TextInput
            style={s.filterInput}
            placeholder="Filter by name..."
            placeholderTextColor="#333"
            value={fileFilter}
            onChangeText={setFileFilter}
            autoCapitalize="none"
          />
          <FlatList
            data={shownFiles}
            keyExtractor={f => f.path}
            initialNumToRender={30}
            maxToRenderPerBatch={30}
            windowSize={10}
            renderItem={({item}) => (
              <TouchableOpacity style={s.fileRow} onPress={() => openFile(item.path, item.name)}>
                <View style={{flex: 1}}>
                  <Text style={s.fileName} numberOfLines={1}>{item.relative.replace(/^apk_full\//, '')}</Text>
                  <Text style={s.fileSize}>{item.size}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={s.empty}>ما في ملفات — ارجع واستخرج منيح.</Text>
            }
          />
        </>
      )}

      {mode === 'search' && (
        <FlatList
          data={groups}
          keyExtractor={g => g.path}
          initialNumToRender={25}
          renderItem={({item: g}) => {
            const isOpen = expanded === g.path;
            return (
              <View style={s.groupBox}>
                <TouchableOpacity
                  style={s.groupHeader}
                  onPress={() => setExpanded(isOpen ? null : g.path)}>
                  <View style={{flex: 1}}>
                    <Text style={s.groupPath} numberOfLines={1}>{g.relative.replace(/^apk_full\//, '')}</Text>
                    <Text style={s.groupCount}>{g.matches.length} match{g.matches.length === 1 ? '' : 'es'}</Text>
                  </View>
                  <Text style={s.chevron}>{isOpen ? '▾' : '▸'}</Text>
                </TouchableOpacity>
                {(isOpen ? g.matches : g.matches.slice(0, 2)).map(m => (
                  <TouchableOpacity
                    key={`${m.line}`}
                    style={s.matchRow}
                    onPress={() => openFile(g.path, g.relative.split('/').pop() ?? g.relative, m.line, query)}>
                    <Text style={s.matchLineNo}>{m.line}</Text>
                    <HighlightedText
                      text={m.text.trim().slice(0, 200)}
                      q={query}
                      base={s.matchText}
                      hi={s.matchHi}
                    />
                  </TouchableOpacity>
                ))}
                {!isOpen && g.matches.length > 2 && (
                  <Text style={s.moreText}>+{g.matches.length - 2} more — tap to expand</Text>
                )}
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={s.empty}>
              {searching ? 'Searching…' : query ? `No matches for "${query}"` : 'اكتب كلمة واضغط FIND'}
            </Text>
          }
        />
      )}

      {/* Viewer modal */}
      <Modal visible={!!viewer} animationType="slide" onRequestClose={() => setViewer(null)}>
        <View style={s.viewerContainer}>
          <View style={s.viewerHeader}>
            <Text style={s.viewerTitle} numberOfLines={1}>
              {viewer?.name}{viewer?.targetLine ? ` :${viewer.targetLine}` : ''}
            </Text>
            {!!viewer?.typeLabel && (
              <View style={s.typeBadge}>
                <Text style={s.typeBadgeText}>{viewer.typeLabel}</Text>
              </View>
            )}
            {!!viewer?.q && (
              <>
                <TouchableOpacity onPress={() => jumpTo(-1)} style={s.navBtn}>
                  <Text style={s.navBtnText}>‹</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => jumpTo(1)} style={s.navBtn}>
                  <Text style={s.navBtnText}>›</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity onPress={() => setViewer(null)} style={s.closeBtn}>
              <Text style={s.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView ref={viewerScroll} style={s.viewerScroll}>
            {viewer?.targetLine != null && (
              <Text style={s.windowNote}>
                showing lines {viewer.startLine}–{viewer.startLine + LINES_PER_PAGE}
              </Text>
            )}
            <ScrollView horizontal>
              <View>
                {viewerLines.map((ln, i) => {
                  const lineNo = (viewer?.startLine ?? 1) + i;
                  const isTarget = lineNo === viewer?.targetLine;
                  return (
                    <View key={i} style={isTarget ? s.lineTarget : undefined}>
                      <Text style={[s.viewerText, isTarget && {color: '#001b0d'}]} selectable>
                        <Text style={isTarget ? s.lineNoTarget : s.lineNo}>{lineNo}  </Text>
                        {viewer?.q ? (
                          <HighlightedText text={ln} q={viewer.q} base={{}} hi={isTarget ? s.hiInTarget : s.hiInline} />
                        ) : ln}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d'},
  header: {padding: 14, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#1a1a1a'},
  title: {color: '#fff', fontSize: 16, fontFamily: 'monospace', fontWeight: 'bold'},
  pkg: {color: '#555', fontSize: 11, fontFamily: 'monospace', marginTop: 2},
  subtitle: {color: '#00ff88', fontSize: 11, fontFamily: 'monospace', marginTop: 6},
  centerBox: {alignItems: 'center', paddingVertical: 30},
  bigBtn: {
    backgroundColor: '#00ff88', borderRadius: 6, paddingVertical: 18, paddingHorizontal: 34,
    alignItems: 'center',
  },
  bigBtnText: {color: '#000', fontWeight: 'bold', fontSize: 16, fontFamily: 'monospace'},
  bigBtnSub: {color: '#033', fontSize: 10, fontFamily: 'monospace', marginTop: 4},
  working: {color: '#00ff88', fontFamily: 'monospace', fontSize: 12, marginTop: 14},
  errText: {color: '#ff6666', fontFamily: 'monospace', fontSize: 11, marginTop: 14},
  logBox: {flex: 1, margin: 10, backgroundColor: '#050505', borderWidth: 1, borderColor: '#1a1a1a'},
  logLine: {color: '#999', fontFamily: 'monospace', fontSize: 11, lineHeight: 17},
  searchRow: {flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 8},
  searchInput: {
    flex: 1, backgroundColor: '#111', color: '#eee', borderWidth: 1, borderColor: '#222',
    paddingHorizontal: 10, paddingVertical: 8, fontFamily: 'monospace', fontSize: 12, borderRadius: 3,
  },
  searchBtn: {backgroundColor: '#00ff88', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 3, minWidth: 60, alignItems: 'center'},
  searchBtnText: {color: '#000', fontWeight: 'bold', fontFamily: 'monospace', fontSize: 12},
  modeRow: {flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1a1a1a'},
  modeTab: {flex: 1, paddingVertical: 10, alignItems: 'center'},
  modeTabActive: {borderBottomWidth: 2, borderBottomColor: '#00ff88'},
  modeText: {color: '#555', fontFamily: 'monospace', fontSize: 12},
  modeTextActive: {color: '#00ff88'},
  reloadBtn: {paddingHorizontal: 12, justifyContent: 'center'},
  filterInput: {
    backgroundColor: '#0a0a0a', color: '#aaa', paddingHorizontal: 12, paddingVertical: 6,
    fontFamily: 'monospace', fontSize: 11, borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  fileRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#151515',
  },
  fileName: {color: '#ddd', fontFamily: 'monospace', fontSize: 12},
  fileSize: {color: '#555', fontFamily: 'monospace', fontSize: 10, marginTop: 2},
  chevron: {color: '#00ff88', fontSize: 16, marginLeft: 8},
  groupBox: {borderBottomWidth: 1, borderBottomColor: '#1a1a1a'},
  groupHeader: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#0f1a12',
  },
  groupPath: {color: '#00ff88', fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold'},
  groupCount: {color: '#557755', fontFamily: 'monospace', fontSize: 10, marginTop: 2},
  matchRow: {flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 7, gap: 10, borderTopWidth: 1, borderTopColor: '#131313'},
  matchLineNo: {color: '#00aa55', fontFamily: 'monospace', fontSize: 11, minWidth: 44},
  matchText: {color: '#999', fontFamily: 'monospace', fontSize: 11, flex: 1},
  matchHi: {color: '#000', backgroundColor: '#00ff88', fontFamily: 'monospace', fontSize: 11},
  moreText: {color: '#446', fontFamily: 'monospace', fontSize: 10, paddingHorizontal: 12, paddingVertical: 6},
  empty: {color: '#444', textAlign: 'center', marginTop: 40, fontFamily: 'monospace', fontSize: 12},
  viewerContainer: {flex: 1, backgroundColor: '#0d0d0d'},
  viewerHeader: {
    flexDirection: 'row', alignItems: 'center', padding: 10,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a', gap: 4,
  },
  viewerTitle: {flex: 1, color: '#00ff88', fontFamily: 'monospace', fontSize: 12},
  typeBadge: {backgroundColor: '#123', borderColor: '#2a5a3a', borderWidth: 1, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2},
  typeBadgeText: {color: '#7fd', fontFamily: 'monospace', fontSize: 9},
  navBtn: {backgroundColor: '#1a3a2a', borderRadius: 3, paddingHorizontal: 14, paddingVertical: 4},
  navBtnText: {color: '#00ff88', fontSize: 18, fontWeight: 'bold'},
  closeBtn: {padding: 6, paddingHorizontal: 12},
  closeBtnText: {color: '#fff', fontSize: 16},
  viewerScroll: {flex: 1, padding: 10},
  windowNote: {color: '#446', fontFamily: 'monospace', fontSize: 10, marginBottom: 6},
  viewerText: {color: '#ccc', fontFamily: 'monospace', fontSize: 11, lineHeight: 16},
  lineNo: {color: '#2a4a35'},
  lineNoTarget: {color: '#004d22', fontWeight: 'bold'},
  lineTarget: {backgroundColor: '#8fffce'},
  hiInline: {color: '#000', backgroundColor: '#00ff88'},
  hiInTarget: {color: '#000', backgroundColor: '#00cc6a', fontWeight: 'bold'},
});

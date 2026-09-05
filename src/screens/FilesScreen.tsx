import React, {useEffect, useState, useCallback, useRef, useMemo} from 'react';
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
  Clipboard,
  ToastAndroid,
} from 'react-native';
import {
  rootBridge,
  ExtractedFile,
  SearchMatch,
  FileAnalysis,
  TokenMatch,
} from '../native/RootBridge';

type Mode = 'files' | 'search' | 'hunt';
type Scope = 'all' | 'dump' | 'assets';
const SCOPES: {key: Scope; label: string}[] = [
  {key: 'all', label: 'الكل'},
  {key: 'dump', label: 'Dump'},
  {key: 'assets', label: 'Assets'},
];

// Group matches by file so search results read as "files, with their hit lines"
interface FileGroup {
  path: string;      // absolute
  relative: string;  // display
  matches: SearchMatch[];
}

function groupByFile(matches: SearchMatch[]): FileGroup[] {
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

// Highlight occurrences of `q` in a line of text
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
const LINES_PER_PAGE = CONTEXT_LINES * 2 + 1; // 400 before + hit + 400 after

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export default function FilesScreen({route}: any) {
  const pkg: string = route?.params?.packageName ?? '';
  const appName: string = route?.params?.appName ?? pkg;

  const [mode, setMode] = useState<Mode>('files');
  const [files, setFiles] = useState<ExtractedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('all');

  // Token hunt state — raw-object scan of Unity bundles (UnityPy), saves
  // each hit as {Type}_{path_id}_full.txt under token_hunt/
  const [hunting, setHunting] = useState(false);
  const [huntMatches, setHuntMatches] = useState<TokenMatch[]>([]);

  // Viewer state — jump-aware: we load a window of lines around the target
  const [viewer, setViewer] = useState<{
    path: string; name: string; content: string;
    startLine: number; targetLine: number | null; q: string;
    typeLabel?: string; binary?: boolean;
    full?: boolean; truncated?: boolean; loadedLines?: number;
  } | null>(null);
  const viewerScroll = useRef<ScrollView>(null);
  const [fullLoading, setFullLoading] = useState(false);
  const loadToken = useRef(0);

  const loadFiles = useCallback(async () => {
    if (!pkg) return;
    setLoading(true);
    try {
      const list = await rootBridge.listExtracted(pkg);
      setFiles(list);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [pkg]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const runSearch = async (sc: Scope = scope) => {
    const q = query.trim();
    if (!q || !pkg) return;
    setSearching(true);
    setMode('search');
    setExpanded(null);
    try {
      const res = await rootBridge.searchFiles(pkg, q, sc);
      setMatches(res);
    } catch (e: any) {
      setMatches([]);
      console.error(e);
    }
    setSearching(false);
  };

  const changeScope = (sc: Scope) => {
    setScope(sc);
    if (query.trim()) runSearch(sc);
  };

  // Token hunt — scan EVERY raw object of the Unity bundles (not just the
  // extracted text files). Hits land on disk as {Type}_{path_id}_full.txt.
  const runHunt = async () => {
    const q = query.trim();
    if (!q || !pkg || hunting) return;
    setHunting(true);
    setMode('hunt');
    setHuntMatches([]);
    try {
      const res = await rootBridge.huntToken(pkg, q);
      setHuntMatches(res.matches ?? []);
    } catch (e: any) {
      ToastAndroid.show(`Hunt error: ${e?.message ?? e}`, ToastAndroid.LONG);
      setHuntMatches([]);
    }
    setHunting(false);
  };

  // Open a file; if line given, load a window around it and scroll there.
  // No line → analyzeFile: detects type and, for binary content (Lua bytecode,
  // Unity assets, ELF, zip...), returns a readable strings/content dump.
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
          q: q ?? '', typeLabel: a.label, binary: a.binary,
        });
      }
    } catch (e: any) {
      setViewer({path, name, content: `Cannot read file: ${e?.message ?? e}`, startLine: 1, targetLine: null, q: ''});
    }
  };

  // Jump to prev/next match line inside the open viewer (same file)
  const jumpTo = async (delta: 1 | -1) => {
    if (!viewer) return;
    const inFile = matches.filter(m => m.path === viewer.path).sort((a, b) => a.line - b.line);
    if (!inFile.length) return;
    const cur = viewer.targetLine ?? 0;
    const next = delta === 1
      ? (inFile.find(m => m.line > cur) ?? inFile[0])
      : ([...inFile].reverse().find(m => m.line < cur) ?? inFile[inFile.length - 1]);
    // Re-open the file at that line (window may need to move)
    await openFile(next.path, viewer.name, next.line, viewer.q);
  };

  // ── Full-file mode ────────────────────────────────────────────────────────
  // Streams the ENTIRE file in 800-line chunks (readFileRange), showing a
  // running line count. Rendered as ONE big <Text> (with line-number prefixes)
  // — rendering thousands of per-line Views would freeze the UI.
  const FULL_CHUNK = 800;
  const FULL_MAX = 20000; // safety cap — dump.cs can be 100s of MB

  const loadFull = async () => {
    if (!viewer || fullLoading) return;
    const v0 = viewer;
    const token = ++loadToken.current;
    setFullLoading(true);
    try {
      let raw = '';
      let start = 1;
      let truncated = false;
      while (token === loadToken.current) {
        const r = await rootBridge.readFileRange(v0.path, start, FULL_CHUNK);
        const lines = r.content ? r.content.split('\n').length - 1 : 0;
        if (lines <= 0) break;
        raw += r.content;
        const loadedLines = start - 1 + lines;
        setViewer(v => (v && v.path === v0.path ? {...v, full: true, loadedLines} : v));
        if (lines < FULL_CHUNK) break;          // short page = EOF
        if (loadedLines >= FULL_MAX) { truncated = true; break; }
        start += FULL_CHUNK;
        await new Promise(res => setTimeout(res, 0)); // let the UI breathe
      }
      const numbered = raw
        .replace(/\n$/, '')
        .split('\n')
        .map((ln, i) => `${i + 1}  ${ln}`)
        .join('\n');
      setViewer(v => (v && v.path === v0.path ? {...v, content: numbered, full: true, truncated} : v));
      if (truncated) ToastAndroid.show(`الملف ضخم — انعرض أول ${FULL_MAX} سطر بس`, ToastAndroid.LONG);
      if (v0.targetLine) {
        setTimeout(() => viewerScroll.current?.scrollTo({y: (v0.targetLine! - 1) * 16, animated: false}), 150);
      }
    } catch (e: any) {
      ToastAndroid.show(`خطأ بالتحميل: ${e?.message ?? e}`, ToastAndroid.SHORT);
    }
    setFullLoading(false);
  };

  const closeViewer = () => {
    loadToken.current++; // cancel any in-flight full load
    setFullLoading(false);
    setViewer(null);
  };

  const groups = useMemo(() => groupByFile(matches), [matches]);
  const shownFiles = fileFilter
    ? files.filter(f => f.relative.toLowerCase().includes(fileFilter.toLowerCase()))
    : files;

  const viewerLines = viewer ? viewer.content.split('\n') : [];

  return (
    <View style={styles.container}>
      <Text style={styles.header}>{appName}</Text>

      {/* Search bar */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="ابحث عن كلمة بالملفات المستخرجة..."
          placeholderTextColor="#444"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => runSearch()}
          returnKeyType="search"
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.searchBtn} onPress={() => runSearch()}>
          {searching ? <ActivityIndicator color="#000" size="small" /> : <Text style={styles.searchBtnText}>FIND</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.searchBtn, styles.huntBtn]}
          onPress={runHunt}
          disabled={hunting}>
          {hunting ? <ActivityIndicator color="#00ff88" size="small" /> : <Text style={styles.huntBtnText}>HUNT</Text>}
        </TouchableOpacity>
      </View>

      {/* Mode tabs */}
      <View style={styles.modeRow}>
        <TouchableOpacity onPress={() => setMode('files')} style={[styles.modeTab, mode === 'files' && styles.modeTabActive]}>
          <Text style={[styles.modeText, mode === 'files' && styles.modeTextActive]}>Files ({files.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMode('search')} style={[styles.modeTab, mode === 'search' && styles.modeTabActive]}>
          <Text style={[styles.modeText, mode === 'search' && styles.modeTextActive]}>
            Matches ({groups.length} files)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMode('hunt')} style={[styles.modeTab, mode === 'hunt' && styles.modeTabActive]}>
          <Text style={[styles.modeText, mode === 'hunt' && styles.modeTextActive]}>
            Hunt ({huntMatches.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={loadFiles} style={styles.reloadBtn}>
          <Text style={styles.modeText}>⟳</Text>
        </TouchableOpacity>
      </View>

      {mode === 'files' && (
        <>
          <TextInput
            style={styles.filterInput}
            placeholder="Filter by name..."
            placeholderTextColor="#333"
            value={fileFilter}
            onChangeText={setFileFilter}
            autoCapitalize="none"
          />
          {loading ? (
            <ActivityIndicator color="#00ff88" size="large" style={{marginTop: 40}} />
          ) : (
            <FlatList
              data={shownFiles}
              keyExtractor={f => f.path}
              initialNumToRender={30}
              maxToRenderPerBatch={30}
              windowSize={10}
              renderItem={({item}) => (
                <TouchableOpacity style={styles.fileRow} onPress={() => openFile(item.path, item.name)}>
                  <View style={{flex: 1}}>
                    <Text style={styles.fileName} numberOfLines={1}>{item.relative}</Text>
                    <Text style={styles.fileSize}>{item.size}</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.empty}>No extracted files yet — run extraction first.</Text>
              }
            />
          )}
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
              <View style={styles.groupBox}>
                <TouchableOpacity
                  style={styles.groupHeader}
                  onPress={() => setExpanded(isOpen ? null : g.path)}>
                  <View style={{flex: 1}}>
                    <Text style={styles.groupPath} numberOfLines={1}>{g.relative}</Text>
                    <Text style={styles.groupCount}>{g.matches.length} match{g.matches.length === 1 ? '' : 'es'}</Text>
                  </View>
                  <Text style={styles.chevron}>{isOpen ? '▾' : '▸'}</Text>
                </TouchableOpacity>
                {(isOpen ? g.matches : g.matches.slice(0, 2)).map(m => (
                  <TouchableOpacity
                    key={`${m.line}`}
                    style={styles.matchRow}
                    onPress={() => openFile(g.path, g.relative.split('/').pop() ?? g.relative, m.line, query)}>
                    <Text style={styles.matchLineNo}>{m.line}</Text>
                    <HighlightedText
                      text={m.text.trim().slice(0, 200)}
                      q={query}
                      base={styles.matchText}
                      hi={styles.matchHi}
                    />
                  </TouchableOpacity>
                ))}
                {!isOpen && g.matches.length > 2 && (
                  <Text style={styles.moreText}>+{g.matches.length - 2} more — tap to expand</Text>
                )}
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {searching ? 'Searching…' : query ? `No matches for "${query}"` : 'Type a word and hit FIND'}
            </Text>
          }
        />
      )}

      {mode === 'hunt' && (
        <FlatList
          data={huntMatches}
          keyExtractor={m => m.path}
          initialNumToRender={25}
          renderItem={({item: m}) => (
            <TouchableOpacity style={styles.fileRow} onPress={() => openFile(m.path, m.file)}>
              <View style={{flex: 1}}>
                <Text style={styles.huntTitle} numberOfLines={1}>
                  {m.type} · path_id {m.path_id}
                </Text>
                <Text style={styles.fileSize}>
                  {m.file} · {formatBytes(m.size)} · {m.apk}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {hunting
                ? 'جاري مسح كل الـ objects بالـ Unity bundles…'
                : query
                  ? `ما في object فيه "${query}" — جرّب FIND للبحث بالملفات المستخرجة`
                  : 'اكتب التوكن فوق واضغط HUNT — بيفحص كل object بالـ bundle وبيحفظ يلي بيطابق'}
            </Text>
          }
          ListHeaderComponent={
            huntMatches.length > 0 ? (
              <Text style={styles.huntHeader}>
                {huntMatches.length} object(s) matched — saved to token_hunt/
              </Text>
            ) : null
          }
        />
      )}

      {/* Viewer modal */}
      <Modal visible={!!viewer} animationType="slide" onRequestClose={closeViewer}>
        <View style={styles.viewerContainer}>
          <View style={styles.viewerHeader}>
            <Text style={styles.viewerTitle} numberOfLines={1}>
              {viewer?.name}{viewer?.targetLine ? ` :${viewer.targetLine}` : ''}
            </Text>
            {!!viewer?.typeLabel && (
              <View style={styles.typeBadge}>
                <Text style={styles.typeBadgeText}>{viewer.typeLabel}</Text>
              </View>
            )}
            {!!viewer?.q && (
              <>
                <TouchableOpacity onPress={() => jumpTo(-1)} style={styles.navBtn}>
                  <Text style={styles.navBtnText}>‹</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => jumpTo(1)} style={styles.navBtn}>
                  <Text style={styles.navBtnText}>›</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity onPress={loadFull} style={styles.copyBtn} disabled={fullLoading}>
              {fullLoading ? (
                <Text style={styles.copyBtnText}>جاري…</Text>
              ) : (
                <Text style={styles.copyBtnText}>{viewer?.full ? 'كامل ✓' : 'كامل'}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (!viewer) return;
                Clipboard.setString(viewer.content);
                ToastAndroid.show('انحفظ المحتوى بالحافظة', ToastAndroid.SHORT);
              }}
              style={styles.copyBtn}>
              <Text style={styles.copyBtnText}>نسخ</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={closeViewer} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView ref={viewerScroll} style={styles.viewerScroll}>
            {viewer?.full && viewer.truncated && (
              <Text style={styles.windowNote}>
                الملف ضخم — معروض أول {viewer.loadedLines} سطر بس
              </Text>
            )}
            {!viewer?.full && viewer?.targetLine != null && (
              <Text style={styles.windowNote}>
                showing lines {viewer.startLine}–{viewer.startLine + LINES_PER_PAGE}
              </Text>
            )}
            {fullLoading && !!viewer?.loadedLines && (
              <Text style={styles.windowNote}>
                جاري تحميل الملف كامل… {viewer.loadedLines} سطر
              </Text>
            )}
            {viewer?.full ? (
              <ScrollView horizontal>
                <Text style={styles.fullText} selectable>{viewer.content}</Text>
              </ScrollView>
            ) : (
            <ScrollView horizontal>
              <View>
                {viewerLines.map((ln, i) => {
                  const lineNo = (viewer?.startLine ?? 1) + i;
                  const isTarget = lineNo === viewer?.targetLine;
                  return (
                    <View key={i} style={isTarget ? styles.lineTarget : undefined}>
                      <Text style={[styles.viewerText, isTarget && {color: '#001b0d'}]} selectable>
                        <Text style={isTarget ? styles.lineNoTarget : styles.lineNo}>{lineNo}  </Text>
                        {viewer?.q ? (
                          <HighlightedText text={ln} q={viewer.q} base={{}} hi={isTarget ? styles.hiInTarget : styles.hiInline} />
                        ) : ln}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d'},
  header: {color: '#fff', fontSize: 16, fontFamily: 'monospace', fontWeight: 'bold', padding: 12, paddingBottom: 4},
  searchRow: {flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 8},
  searchInput: {
    flex: 1, backgroundColor: '#111', color: '#eee', borderWidth: 1, borderColor: '#222',
    paddingHorizontal: 10, paddingVertical: 8, fontFamily: 'monospace', fontSize: 12, borderRadius: 3,
  },
  searchBtn: {backgroundColor: '#00ff88', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 3, minWidth: 60, alignItems: 'center'},
  searchBtnText: {color: '#000', fontWeight: 'bold', fontFamily: 'monospace', fontSize: 12},
  huntBtn: {backgroundColor: '#0a2a18', borderWidth: 1, borderColor: '#00ff88'},
  huntBtnText: {color: '#00ff88', fontWeight: 'bold', fontFamily: 'monospace', fontSize: 12},
  huntTitle: {color: '#00ff88', fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold'},
  huntHeader: {color: '#557755', fontFamily: 'monospace', fontSize: 11, paddingHorizontal: 12, paddingVertical: 8},
  modeRow: {flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1a1a1a'},
  modeTab: {flex: 1, paddingVertical: 10, alignItems: 'center'},
  modeTabActive: {borderBottomWidth: 2, borderBottomColor: '#00ff88'},
  modeText: {color: '#555', fontFamily: 'monospace', fontSize: 12},
  modeTextActive: {color: '#00ff88'},
  reloadBtn: {paddingHorizontal: 16, justifyContent: 'center'},
  scopeRow: {flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 6},
  scopeChip: {
    flex: 1, alignItems: 'center', paddingVertical: 5, borderRadius: 3,
    borderWidth: 1, borderColor: '#222', backgroundColor: '#0a0a0a',
  },
  scopeChipActive: {borderColor: '#00ff88', backgroundColor: '#0f2418'},
  scopeText: {color: '#555', fontFamily: 'monospace', fontSize: 11},
  scopeTextActive: {color: '#00ff88', fontWeight: 'bold'},
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
  navBtn: {backgroundColor: '#1a3a2a', borderRadius: 3, paddingHorizontal: 14, paddingVertical: 4},
  navBtnText: {color: '#00ff88', fontSize: 18, fontWeight: 'bold'},
  copyBtn: {
    backgroundColor: '#0a2a18', borderColor: '#00ff88', borderWidth: 1,
    borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4,
  },
  copyBtnText: {color: '#00ff88', fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold'},
  closeBtn: {padding: 6, paddingHorizontal: 12},
  closeBtnText: {color: '#fff', fontSize: 16},
  viewerScroll: {flex: 1, padding: 10},
  windowNote: {color: '#446', fontFamily: 'monospace', fontSize: 10, marginBottom: 6},
  typeBadge: {backgroundColor: '#123', borderColor: '#2a5a3a', borderWidth: 1, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2},
  typeBadgeText: {color: '#7fd', fontFamily: 'monospace', fontSize: 9},
  viewerText: {color: '#ccc', fontFamily: 'monospace', fontSize: 11, lineHeight: 16},
  fullText: {color: '#ccc', fontFamily: 'monospace', fontSize: 11, lineHeight: 16},
  lineNo: {color: '#2a4a35'},
  lineNoTarget: {color: '#004d22', fontWeight: 'bold'},
  lineTarget: {backgroundColor: '#8fffce'},
  hiInline: {color: '#000', backgroundColor: '#00ff88'},
  hiInTarget: {color: '#000', backgroundColor: '#00cc6a', fontWeight: 'bold'},
});

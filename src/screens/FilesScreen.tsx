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
} from 'react-native';
import {
  rootBridge,
  ExtractedFile,
  SearchMatch,
} from '../native/RootBridge';

type Mode = 'files' | 'search';

export default function FilesScreen({route}: any) {
  const pkg: string = route?.params?.packageName ?? '';
  const appName: string = route?.params?.appName ?? pkg;

  const [mode, setMode] = useState<Mode>('files');
  const [files, setFiles] = useState<ExtractedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [viewer, setViewer] = useState<{path: string; name: string; content: string} | null>(null);
  const [fileFilter, setFileFilter] = useState('');

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

  const runSearch = async () => {
    const q = query.trim();
    if (!q || !pkg) return;
    setSearching(true);
    setMode('search');
    try {
      const res = await rootBridge.searchFiles(pkg, q);
      setMatches(res);
    } catch (e: any) {
      setMatches([]);
      console.error(e);
    }
    setSearching(false);
  };

  const openFile = async (path: string, name: string) => {
    try {
      const content = await rootBridge.readFile(path);
      setViewer({path, name, content});
    } catch (e: any) {
      setViewer({path, name, content: `Cannot read file: ${e?.message ?? e}`});
    }
  };

  const shownFiles = fileFilter
    ? files.filter(f => f.relative.toLowerCase().includes(fileFilter.toLowerCase()))
    : files;

  return (
    <View style={styles.container}>
      <Text style={styles.header}>{appName}</Text>

      {/* Search bar */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search word inside extracted files..."
          placeholderTextColor="#444"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={runSearch}
          returnKeyType="search"
        />
        <TouchableOpacity style={styles.searchBtn} onPress={runSearch}>
          {searching ? <ActivityIndicator color="#000" size="small" /> : <Text style={styles.searchBtnText}>FIND</Text>}
        </TouchableOpacity>
      </View>

      {/* Mode tabs */}
      <View style={styles.modeRow}>
        <TouchableOpacity onPress={() => setMode('files')} style={[styles.modeTab, mode === 'files' && styles.modeTabActive]}>
          <Text style={[styles.modeText, mode === 'files' && styles.modeTextActive]}>Files ({files.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMode('search')} style={[styles.modeTab, mode === 'search' && styles.modeTabActive]}>
          <Text style={[styles.modeText, mode === 'search' && styles.modeTextActive]}>
            Matches ({matches.length})
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
          />
          {loading ? (
            <ActivityIndicator color="#00ff88" size="large" style={{marginTop: 40}} />
          ) : (
            <FlatList
              data={shownFiles}
              keyExtractor={f => f.path}
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
          data={matches}
          keyExtractor={(m, i) => `${m.file}:${m.line}:${i}`}
          renderItem={({item}) => (
            <TouchableOpacity style={styles.matchRow} onPress={() => openFile(item.file, item.relative)}>
              <Text style={styles.matchFile}>
                {item.relative}:{item.line}
              </Text>
              <Text style={styles.matchText} numberOfLines={2}>{item.text.trim()}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {searching ? 'Searching…' : query ? `No matches for "${query}"` : 'Type a word and hit FIND'}
            </Text>
          }
        />
      )}

      {/* Viewer modal */}
      <Modal visible={!!viewer} animationType="slide" onRequestClose={() => setViewer(null)}>
        <View style={styles.viewerContainer}>
          <View style={styles.viewerHeader}>
            <Text style={styles.viewerTitle} numberOfLines={1}>{viewer?.name}</Text>
            <TouchableOpacity onPress={() => setViewer(null)} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.viewerScroll}>
            <ScrollView horizontal>
              <Text style={styles.viewerText} selectable>{viewer?.content}</Text>
            </ScrollView>
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
  modeRow: {flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1a1a1a'},
  modeTab: {flex: 1, paddingVertical: 10, alignItems: 'center'},
  modeTabActive: {borderBottomWidth: 2, borderBottomColor: '#00ff88'},
  modeText: {color: '#555', fontFamily: 'monospace', fontSize: 12},
  modeTextActive: {color: '#00ff88'},
  reloadBtn: {paddingHorizontal: 16, justifyContent: 'center'},
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
  chevron: {color: '#00ff88', fontSize: 18, marginLeft: 8},
  matchRow: {paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#151515'},
  matchFile: {color: '#00ff88', fontFamily: 'monospace', fontSize: 11},
  matchText: {color: '#999', fontFamily: 'monospace', fontSize: 11, marginTop: 3},
  empty: {color: '#444', textAlign: 'center', marginTop: 40, fontFamily: 'monospace', fontSize: 12},
  viewerContainer: {flex: 1, backgroundColor: '#0d0d0d'},
  viewerHeader: {
    flexDirection: 'row', alignItems: 'center', padding: 10,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  viewerTitle: {flex: 1, color: '#00ff88', fontFamily: 'monospace', fontSize: 12},
  closeBtn: {padding: 6, paddingHorizontal: 12},
  closeBtnText: {color: '#fff', fontSize: 16},
  viewerScroll: {flex: 1, padding: 10},
  viewerText: {color: '#ccc', fontFamily: 'monospace', fontSize: 11, lineHeight: 16},
});

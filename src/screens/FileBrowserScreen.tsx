import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  BackHandler,
} from 'react-native';
import {rootBridge, FileEntry} from '../native/RootBridge';

// ─── Props ────────────────────────────────────────────────────────────────────
// route.params: { path: string, title?: string }

// ─── Component ───────────────────────────────────────────────────────────────
export default function FileBrowserScreen({navigation, route}: any) {
  const startPath  = route.params.path;
  const startTitle = route.params.title ?? startPath.split('/').pop() ?? '/';

  // Navigation stack — each entry is a path
  const [pathStack, setPathStack] = useState<string[]>([startPath]);
  const currentPath = pathStack[pathStack.length - 1];

  const [entries,  setEntries]  = useState<FileEntry[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  // File viewer / editor modal
  const [fileModal, setFileModal] = useState(false);
  const [filePath,  setFilePath]  = useState('');
  const [fileName,  setFileName]  = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving,  setFileSaving]  = useState(false);
  const [fileError,   setFileError]   = useState('');
  const [isDirty,     setIsDirty]     = useState(false);
  const [isBinary,    setIsBinary]    = useState(false);

  // ── Hardware back button ────────────────────────────────────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (fileModal) { closeFileModal(); return true; }
      if (pathStack.length > 1) { goUp(); return true; }
      return false;
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileModal, pathStack]);

  // ── Load directory on path change ──────────────────────────────────────────
  useEffect(() => {
    loadDir(currentPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const list = await rootBridge.readDir(path);
      // Dirs first, then files — alphabetical within each group
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(list);
    } catch (e: any) {
      setError(e?.message ?? 'Cannot read directory');
      setEntries([]);
    }
    setLoading(false);
  }, []);

  // ── Navigation helpers ─────────────────────────────────────────────────────
  const pushPath = (path: string) => setPathStack(s => [...s, path]);

  const goUp = () => {
    if (pathStack.length <= 1) { navigation.goBack(); return; }
    setPathStack(s => s.slice(0, -1));
  };

  // ── Breadcrumb segments ────────────────────────────────────────────────────
  const breadcrumbs = (() => {
    const parts = currentPath.split('/').filter(Boolean);
    return parts.map((p, i) => ({
      label: p,
      path:  '/' + parts.slice(0, i + 1).join('/'),
    }));
  })();

  // ── File open ─────────────────────────────────────────────────────────────
  const openFile = async (entry: FileEntry) => {
    setFilePath(entry.path);
    setFileName(entry.name);
    setFileContent('');
    setFileError('');
    setIsDirty(false);
    setFileModal(true);
    setFileLoading(true);
    try {
      const content = await rootBridge.readFile(entry.path);
      const bin = content.startsWith('[Binary') || content.startsWith('[Binary file');
      setIsBinary(bin);
      setFileContent(content);
    } catch (e: any) {
      setFileError(e?.message ?? 'Read failed');
    }
    setFileLoading(false);
  };

  const closeFileModal = () => {
    setFileModal(false);
    setIsDirty(false);
    setFileError('');
  };

  const saveFile = async () => {
    if (isBinary) return;
    setFileSaving(true);
    setFileError('');
    try {
      await rootBridge.writeFile(filePath, fileContent);
      setIsDirty(false);
    } catch (e: any) {
      setFileError(e?.message ?? 'Write failed');
    }
    setFileSaving(false);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <View style={s.container}>
      {/* Breadcrumb bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.breadBar}
        contentContainerStyle={s.breadContent}>
        <TouchableOpacity onPress={() => setPathStack([startPath])}>
          <Text style={s.breadHome}>{startTitle}</Text>
        </TouchableOpacity>
        {breadcrumbs.slice(startPath.split('/').filter(Boolean).length).map((bc, i) => (
          <React.Fragment key={bc.path}>
            <Text style={s.breadSep}>/</Text>
            <TouchableOpacity
              onPress={() => setPathStack(s => [...s.slice(0, s.indexOf(bc.path) + 1)])}>
              <Text style={[
                s.breadItem,
                bc.path === currentPath && s.breadActive,
              ]}>
                {bc.label}
              </Text>
            </TouchableOpacity>
          </React.Fragment>
        ))}
      </ScrollView>

      {/* Back + path row */}
      <View style={s.pathRow}>
        <TouchableOpacity style={s.backBtn} onPress={goUp}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.pathText} numberOfLines={1} ellipsizeMode="middle">
          {currentPath}
        </Text>
        <TouchableOpacity style={s.reloadBtn} onPress={() => loadDir(currentPath)}>
          <Text style={s.reloadText}>↺</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color="#00ff88" size="large" />
          <Text style={s.hint}>Reading via root...</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errText}>⚠ {error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => loadDir(currentPath)}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={item => item.path}
          renderItem={({item}) => (
            <TouchableOpacity
              style={s.entry}
              onPress={() => item.isDir ? pushPath(item.path) : openFile(item)}>
              <Text style={s.entryIcon}>{item.isDir ? '📁' : '📄'}</Text>
              <View style={s.entryInfo}>
                <Text style={[s.entryName, item.isDir && s.dirName]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={s.entryMeta}>
                  {item.perms}
                  {item.size ? `  ${item.size}` : ''}
                </Text>
              </View>
              {item.isDir && <Text style={s.chevron}>›</Text>}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={s.empty}>Empty directory</Text>
          }
          getItemLayout={(_, index) => ({length: 54, offset: 54 * index, index})}
          initialNumToRender={40}
          maxToRenderPerBatch={40}
          windowSize={10}
        />
      )}

      {/* ── File Viewer/Editor Modal ───────────────────────────────────────── */}
      <Modal
        visible={fileModal}
        animationType="slide"
        onRequestClose={closeFileModal}>
        <KeyboardAvoidingView
          style={s.modal}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* Modal header */}
          <View style={s.modalHeader}>
            <TouchableOpacity onPress={closeFileModal} style={s.modalBack}>
              <Text style={s.modalBackText}>✕</Text>
            </TouchableOpacity>
            <Text style={s.modalTitle} numberOfLines={1}>{fileName}</Text>
            {!isBinary && (
              <TouchableOpacity
                style={[s.saveBtn, fileSaving && s.saveBtnDisabled]}
                onPress={saveFile}
                disabled={fileSaving || !isDirty}>
                <Text style={[s.saveBtnText, !isDirty && s.saveBtnTextDim]}>
                  {fileSaving ? 'Saving...' : 'Save'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {fileError ? (
            <Text style={s.modalErr}>{fileError}</Text>
          ) : null}

          {isDirty && (
            <View style={s.dirtyBar}>
              <Text style={s.dirtyText}>● Unsaved changes</Text>
            </View>
          )}

          {fileLoading ? (
            <View style={s.center}>
              <ActivityIndicator color="#00ff88" size="large" />
              <Text style={s.hint}>Reading file...</Text>
            </View>
          ) : isBinary ? (
            <ScrollView style={s.hexScroll}>
              <Text style={s.hexText} selectable>{fileContent}</Text>
            </ScrollView>
          ) : (
            <TextInput
              style={s.editor}
              multiline
              value={fileContent}
              onChangeText={t => { setFileContent(t); setIsDirty(true); }}
              scrollEnabled
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
              textAlignVertical="top"
              selectionColor="#00ff88"
            />
          )}
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d'},

  // Breadcrumb
  breadBar: {
    backgroundColor: '#0a0a0a',
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    maxHeight: 36,
  },
  breadContent: {
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 2,
  },
  breadHome: {color: '#00ff88', fontFamily: 'monospace', fontSize: 12},
  breadSep:  {color: '#2a2a2a', fontFamily: 'monospace', fontSize: 12, marginHorizontal: 2},
  breadItem: {color: '#555',    fontFamily: 'monospace', fontSize: 12},
  breadActive:{color: '#aaa',   fontFamily: 'monospace', fontSize: 12},

  // Path row
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    gap: 8,
  },
  backBtn:   {paddingHorizontal: 8, paddingVertical: 4},
  backText:  {color: '#00ff88', fontFamily: 'monospace', fontSize: 13},
  pathText:  {flex: 1, color: '#333', fontFamily: 'monospace', fontSize: 10},
  reloadBtn: {paddingHorizontal: 8, paddingVertical: 4},
  reloadText:{color: '#555', fontFamily: 'monospace', fontSize: 18},

  // File entry
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    height: 54,
    borderBottomWidth: 1,
    borderBottomColor: '#131313',
    gap: 10,
  },
  entryIcon: {fontSize: 18, width: 26, textAlign: 'center'},
  entryInfo: {flex: 1},
  entryName: {color: '#ccc', fontFamily: 'monospace', fontSize: 13},
  dirName:   {color: '#5bc8ff'},
  entryMeta: {color: '#2a2a2a', fontFamily: 'monospace', fontSize: 9, marginTop: 2},
  chevron:   {color: '#333', fontSize: 20, marginLeft: 4},

  // States
  center:    {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14},
  hint:      {color: '#333', fontFamily: 'monospace', fontSize: 12},
  errText:   {color: '#ff4444', fontFamily: 'monospace', fontSize: 13, textAlign: 'center', marginHorizontal: 20},
  retryBtn:  {paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#1a1a1a', borderRadius: 6},
  retryText: {color: '#00ff88', fontFamily: 'monospace', fontSize: 13},
  empty:     {color: '#222', textAlign: 'center', marginTop: 60, fontFamily: 'monospace', fontSize: 13},

  // Modal
  modal:       {flex: 1, backgroundColor: '#0a0a0a'},
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
    gap: 10,
  },
  modalBack:     {padding: 4},
  modalBackText: {color: '#555', fontSize: 18},
  modalTitle:    {flex: 1, color: '#ccc', fontFamily: 'monospace', fontSize: 13},
  saveBtn:       {paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#0a2a15', borderRadius: 6, borderWidth: 1, borderColor: '#00ff88'},
  saveBtnDisabled: {opacity: 0.4},
  saveBtnText:   {color: '#00ff88', fontFamily: 'monospace', fontSize: 12},
  saveBtnTextDim:{color: '#2a6a40'},
  modalErr:      {color: '#ff4444', fontFamily: 'monospace', fontSize: 11, paddingHorizontal: 12, paddingTop: 6},
  dirtyBar:      {backgroundColor: '#1a1200', paddingHorizontal: 12, paddingVertical: 4},
  dirtyText:     {color: '#ff9900', fontFamily: 'monospace', fontSize: 11},

  // Editor
  editor: {
    flex: 1,
    color: '#00ff88',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    padding: 12,
    textAlignVertical: 'top',
  },

  // Hex viewer
  hexScroll: {flex: 1},
  hexText: {
    color: '#5bc8ff',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
    padding: 12,
  },
});

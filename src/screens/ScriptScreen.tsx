import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Modal,
  FlatList,
  NativeEventEmitter,
  NativeModules,
  Clipboard,
  AppState,
  AppStateStatus,
} from 'react-native';
import {useFocusEffect, useRoute} from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {rootBridge} from '../native/RootBridge';
import {LICENSE_KEY_STORAGE, LICENSE_EMAIL_STORAGE} from './LicenseScreen';

const COMMUNITY_SERVER = 'https://fridact-6mzysus-preview-4200.runable.site/api';

const DEFAULT_SCRIPT = `Java.perform(function() {
  // Use send() for real-time logs in the overlay while the game runs.
  // console.log() goes to logcat — also visible, but send() is instant.
  var Activity = Java.use("android.app.Activity");
  Activity.onResume.implementation = function() {
    send("[*] onResume called");
    this.onResume();
  };
});`;

const SCRIPTS_KEY = 'scriptsList';

const eventEmitter = new NativeEventEmitter(NativeModules.RootBridge);

type InjectMode = 'pid' | 'name' | 'spawn';

const MODE_INFO: Record<InjectMode, string> = {
  pid:   'Attach to running process by PID',
  name:  'Attach by package name (-n)',
  spawn: 'Spawn fresh + inject before any code runs (-f)',
};

type SavedScript = {id: string; name: string; code: string};
type CloudScript = {id: string; title: string; code: string; author?: string; description?: string};

// ── Auth helpers ──────────────────────────────────────────────────────────────
const getAuth = async (): Promise<{token: string; email: string} | null> => {
  const token = await AsyncStorage.getItem(LICENSE_KEY_STORAGE);
  const email = await AsyncStorage.getItem(LICENSE_EMAIL_STORAGE);
  if (!token || !email) return null;
  return {token, email};
};

const cloudHeaders = (
  token: string,
  email: string,
  json?: boolean,
): Record<string, string> => ({
  ...(json ? {'Content-Type': 'application/json'} : {}),
  Authorization: 'Bearer ' + token,
  'X-User-Email': email,
});

export default function ScriptScreen() {
  const route = useRoute<any>();
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [target, setTarget] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [injectMode, setInjectMode] = useState<InjectMode>('pid');
  const [searchQuery, setSearchQuery] = useState('');
  const [scriptsModal, setScriptsModal] = useState(false);
  const [savedScripts, setSavedScripts] = useState<SavedScript[]>([]);
  const [saveNameModal, setSaveNameModal] = useState(false);
  const [newScriptName, setNewScriptName] = useState('');
  const [cloudModal, setCloudModal] = useState(false);
  const [cloudScripts, setCloudScripts] = useState<CloudScript[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [overlayActive, setOverlayActive] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const flatListRef = useRef<FlatList>(null);
  const listenerRef = useRef<any>(null);
  const runningRef = useRef(false);  // mirror of `running` accessible in AppState callback

  // ── Flush buffered logs when app comes back to foreground ─────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state: AppStateStatus) => {
      if (state === 'active' && runningRef.current) {
        try {
          const lines: string[] = await rootBridge.flushPendingLogs();
          if (lines.length > 0) {
            setOutput(prev => {
              const next = [...prev, ...lines];
              return next.slice(-2000); // cap at 2000 lines
            });
          }
        } catch (_) {}
      }
    });
    return () => sub.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem('selectedApp').then(pkg => {
        if (pkg) setTarget(pkg);
      });
      loadScriptsList();
      // Prefill from GameScreen script library
      if (route.params?.prefillCode) {
        setScript(route.params.prefillCode);
        if (route.params?.prefillTitle) {
          setNewScriptName(route.params.prefillTitle);
        }
      }
    }, [route.params?.prefillCode]),
  );

  useEffect(() => {
    return () => {
      listenerRef.current?.remove();
    };
  }, []);

  const loadScriptsList = async () => {
    try {
      const raw = await AsyncStorage.getItem(SCRIPTS_KEY);
      if (raw) setSavedScripts(JSON.parse(raw));
    } catch (_) {}
  };

  const saveScriptsList = async (list: SavedScript[]) => {
    setSavedScripts(list);
    await AsyncStorage.setItem(SCRIPTS_KEY, JSON.stringify(list));
  };

  const openSaveModal = () => {
    setNewScriptName('Script ' + (savedScripts.length + 1));
    setSaveNameModal(true);
  };

  const confirmSave = async () => {
    const name = newScriptName.trim();
    if (!name) return;
    const newEntry: SavedScript = {
      id: Date.now().toString(),
      name,
      code: script,
    };
    await saveScriptsList([newEntry, ...savedScripts]);
    setSaveNameModal(false);
    Alert.alert('Saved', `"${name}" saved`);
  };

  const loadScript = (item: SavedScript) => {
    setScript(item.code);
    setScriptsModal(false);
  };

  const deleteScript = async (id: string) => {
    Alert.alert('Delete', 'Delete this script?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const updated = savedScripts.filter(s => s.id !== id);
          await saveScriptsList(updated);
        },
      },
    ]);
  };

  // ── Cloud Scripts ─────────────────────────────────────────────────────────
  const openCloud = async () => {
    setCloudModal(true);
    setCloudError('');
    setCloudLoading(true);
    try {
      const auth = await getAuth();
      if (!auth) {
        setCloudError('Not logged in — open License tab first');
        setCloudLoading(false);
        return;
      }
      const r = await fetch(COMMUNITY_SERVER + '/community/scripts?mine=1', {
        headers: cloudHeaders(auth.token, auth.email),
      });
      const j = await r.json();
      if (j.error) setCloudError(j.error);
      else setCloudScripts(j.scripts ?? []);
    } catch (e: any) {
      setCloudError(e?.message || 'Network error');
    }
    setCloudLoading(false);
  };

  const saveToCloud = async () => {
    const title = newScriptName.trim();
    if (!title) return;
    try {
      const auth = await getAuth();
      if (!auth) {
        Alert.alert('Error', 'Not logged in — open License tab first');
        return;
      }
      const r = await fetch(COMMUNITY_SERVER + '/community/scripts', {
        method: 'POST',
        headers: cloudHeaders(auth.token, auth.email, true),
        body: JSON.stringify({title, code: script, description: ''}),
      });
      const j = await r.json();
      if (j.ok) {
        setSaveNameModal(false);
        Alert.alert('Saved to Cloud', `"${title}" saved to your cloud`);
      } else {
        Alert.alert('Error', j.error || 'Save failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Network error');
    }
  };

  const deleteCloudScript = async (id: string) => {
    Alert.alert('Delete', 'Delete from cloud?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const auth = await getAuth();
            if (!auth) return;
            await fetch(COMMUNITY_SERVER + '/community/scripts/' + id, {
              method: 'DELETE',
              headers: cloudHeaders(auth.token, auth.email),
            });
            setCloudScripts(prev => prev.filter(s => s.id !== id));
          } catch (_) {}
        },
      },
    ]);
  };

  const loadCloudScript = (item: CloudScript) => {
    setScript(item.code);
    setCloudModal(false);
  };

  const addOut = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setOutput(prev => {
      const next = [...prev, `[${ts}] ${msg}`];
      // Keep last 500 lines max — prevents memory buildup on heavy scripts
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  };

  const stopScript = async () => {
    try {
      await rootBridge.stopScript();
    } catch (_) {}
    listenerRef.current?.remove();
    listenerRef.current = null;
    runningRef.current = false;
    setRunning(false);
    addOut('⏹ Stopped');
    // Auto-hide overlay when script stops
    try { await rootBridge.hideFloatingLog(); } catch (_) {}
    setOverlayActive(false);
  };

  const toggleOverlay = async () => {
    try {
      if (overlayActive) {
        await rootBridge.hideFloatingLog();
        setOverlayActive(false);
      } else {
        await rootBridge.showFloatingLog();
        setOverlayActive(true);
      }
    } catch (e: any) {
      Alert.alert('Overlay Error', e?.message ?? String(e));
    }
  };

  const runScript = async () => {
    if (!target) {
      Alert.alert('No target', 'Go to Apps tab and select a target app first');
      return;
    }
    if (running) return;

    listenerRef.current?.remove();

    listenerRef.current = eventEmitter.addListener('FridaScriptLog', (data: {line: string}) => {
      addOut(data.line);
    });

    setRunning(true);
    runningRef.current = true;
    setOutput([]);
    setSearchQuery('');
    addOut(`▶ Targeting ${target}...`);

    // Auto-show overlay so logs appear above the game without needing the app open
    try {
      await rootBridge.showFloatingLog();
      setOverlayActive(true);
    } catch (_) {}

    try {
      const result = await rootBridge.runScript(target, script, injectMode);
      if (result.startsWith('running:')) {
        // frida-inject attached successfully — listener stays alive so logcat
        // output keeps flowing even after frida-inject itself has exited.
        // running stays true; user must press STOP to end the session.
        addOut(`✓ Injected — logcat streaming (press STOP to end)`);
      } else {
        addOut(result);
        // Non-streaming result — clean up + hide overlay
        runningRef.current = false;
        setRunning(false);
        listenerRef.current?.remove();
        listenerRef.current = null;
        try { await rootBridge.hideFloatingLog(); } catch (_) {}
        setOverlayActive(false);
      }
    } catch (e: any) {
      addOut('✗ ' + (e.message ?? String(e)));
      runningRef.current = false;
      setRunning(false);
      listenerRef.current?.remove();
      listenerRef.current = null;
      try { await rootBridge.hideFloatingLog(); } catch (_) {}
      setOverlayActive(false);
    }
  };

  useEffect(() => {
    const last = output[output.length - 1] ?? '';
    if (running && last.includes('⏹ Script stopped')) {
      runningRef.current = false;
      setRunning(false);
      listenerRef.current?.remove();
      listenerRef.current = null;
      rootBridge.hideFloatingLog().catch(() => {});
      setOverlayActive(false);
    }
  }, [output, running]);

  const filteredOutput = searchQuery.trim()
    ? output.filter(l => l.toLowerCase().includes(searchQuery.toLowerCase()))
    : output;

  return (
    <View style={s.container}>
      {/* Target bar */}
      <View style={s.targetBar}>
        <Text style={s.targetLabel}>TARGET: </Text>
        <Text style={s.targetPkg} numberOfLines={1}>
          {target || 'None — select from Apps tab'}
        </Text>
        {running && (
          <>
            <View style={s.runDot} />
            <Text style={s.logcatBadge}>📡 LIVE</Text>
          </>
        )}
      </View>

      {/* Inject mode selector */}
      <View style={s.modeRow}>
        {(['pid', 'name', 'spawn'] as InjectMode[]).map(m => (
          <TouchableOpacity
            key={m}
            style={[s.modeBtn, injectMode === m && s.modeBtnActive]}
            onPress={() => setInjectMode(m)}>
            <Text style={[s.modeBtnText, injectMode === m && s.modeBtnTextActive]}>
              {m.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={s.modeHint}>{MODE_INFO[injectMode]}</Text>

      {/* Script editor */}
      <TextInput
        style={s.editor}
        multiline
        value={script}
        onChangeText={setScript}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        scrollEnabled
      />

      {/* Buttons */}
      <View style={s.btnRow}>
        <TouchableOpacity style={s.btnSave} onPress={openSaveModal}>
          <Text style={s.btnText}>SAVE</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnScripts} onPress={() => { loadScriptsList(); setScriptsModal(true); }}>
          <Text style={s.btnText}>LOCAL ({savedScripts.length})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btnCloud} onPress={openCloud}>
          <Text style={s.btnText}>☁ CLOUD</Text>
        </TouchableOpacity>
        {running ? (
          <TouchableOpacity style={s.btnStop} onPress={stopScript}>
            <Text style={s.btnText}>■ STOP</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.btnRun} onPress={runScript}>
            <Text style={s.btnText}>▶ RUN</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[s.btnOverlay, overlayActive && s.btnOverlayActive]}
          onPress={toggleOverlay}
        >
          <Text style={s.btnText}>{overlayActive ? '⊠ OVR' : '⊞ OVR'}</Text>
        </TouchableOpacity>
      </View>

      {/* Output */}
      <View style={s.outputBox}>
        <View style={s.outHeader}>
          <Text style={s.outLabel}>
            OUTPUT{' '}
            {filteredOutput.length < output.length
              ? `(${filteredOutput.length}/${output.length})`
              : `(${output.length})`}
          </Text>
          <View style={s.outHeaderRight}>
            {output.length > 0 && (
              <TouchableOpacity onPress={() => setOutput([])}>
                <Text style={s.clearBtn}>CLEAR</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
        <View style={s.searchRow}>
          <TextInput
            style={s.searchInput}
            placeholder="Search output..."
            placeholderTextColor="#333"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity style={s.searchClear} onPress={() => setSearchQuery('')}>
              <Text style={s.searchClearText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
        {filteredOutput.length === 0 ? (
          <Text style={s.outEmpty}>{searchQuery ? 'No matches' : 'No output yet'}</Text>
        ) : (
          <FlatList
            ref={flatListRef}
            data={filteredOutput}
            keyExtractor={(_, i) => String(i)}
            style={s.outScroll}
            // Auto-scroll to bottom when new logs arrive
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({animated: false})}
            // Virtualized — only renders visible rows, never freezes
            initialNumToRender={30}
            maxToRenderPerBatch={30}
            windowSize={10}
            removeClippedSubviews
            getItemLayout={(_, index) => ({length: 18, offset: 18 * index, index})}
            renderItem={({item}) => (
              <TouchableOpacity
                onLongPress={() => { Clipboard.setString(item); Alert.alert('Copied', 'Line copied'); }}
                activeOpacity={0.7}
              >
                <Text style={[s.outLine, item.includes('✗') && s.outErr]}>{item}</Text>
              </TouchableOpacity>
            )}
          />
        )}
      </View>

      {/* Scripts Manager Modal */}
      <Modal visible={scriptsModal} animationType="slide" transparent>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <View style={m.sheetHeader}>
              <Text style={m.sheetTitle}>SAVED SCRIPTS</Text>
              <TouchableOpacity onPress={() => setScriptsModal(false)}>
                <Text style={m.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            {savedScripts.length === 0 ? (
              <Text style={m.empty}>No saved scripts yet</Text>
            ) : (
              <FlatList
                data={savedScripts}
                keyExtractor={item => item.id}
                renderItem={({item}) => (
                  <View style={m.scriptItem}>
                    <TouchableOpacity style={m.scriptNameBox} onPress={() => loadScript(item)}>
                      <Text style={m.scriptNameText} numberOfLines={1}>{item.name}</Text>
                      <Text style={m.scriptPreview} numberOfLines={1}>
                        {item.code.replace(/\n/g, ' ').trim()}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={m.deleteBtn} onPress={() => deleteScript(item.id)}>
                      <Text style={m.deleteBtnText}>🗑</Text>
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </Modal>

      {/* Save Name Modal */}
      <Modal visible={saveNameModal} animationType="fade" transparent>
        <View style={m.overlay}>
          <View style={m.dialog}>
            <Text style={m.dialogTitle}>SAVE SCRIPT</Text>
            <TextInput
              style={m.nameInput}
              value={newScriptName}
              onChangeText={setNewScriptName}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor="#333"
              placeholder="Script name..."
            />
            <View style={m.dialogBtns}>
              <TouchableOpacity style={m.dialogCancel} onPress={() => setSaveNameModal(false)}>
                <Text style={m.dialogCancelText}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity style={m.dialogSave} onPress={confirmSave}>
                <Text style={m.dialogSaveText}>LOCAL</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[m.dialogSave, {backgroundColor: '#003d1a'}]} onPress={saveToCloud}>
                <Text style={m.dialogSaveText}>☁ CLOUD</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Cloud Scripts Modal */}
      <Modal visible={cloudModal} animationType="slide" transparent>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <View style={m.sheetHeader}>
              <Text style={m.sheetTitle}>☁ CLOUD SCRIPTS</Text>
              <TouchableOpacity onPress={() => setCloudModal(false)}>
                <Text style={m.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            {cloudLoading ? (
              <Text style={m.emptyText}>Loading...</Text>
            ) : cloudError ? (
              <Text style={[m.emptyText, {color: '#ff4444'}]}>{cloudError}</Text>
            ) : cloudScripts.length === 0 ? (
              <Text style={m.emptyText}>No cloud scripts yet</Text>
            ) : (
              <FlatList
                data={cloudScripts}
                keyExtractor={item => item.id}
                renderItem={({item}) => (
                  <TouchableOpacity style={m.scriptItem} onPress={() => loadCloudScript(item)}>
                    <View style={{flex: 1}}>
                      <Text style={m.scriptNameText} numberOfLines={1}>{item.title}</Text>
                      {item.author ? (
                        <Text style={m.scriptAuthor}>by {item.author}</Text>
                      ) : null}
                      <Text style={m.scriptPreview} numberOfLines={1}>{item.code}</Text>
                    </View>
                    <TouchableOpacity style={m.deleteBtn} onPress={() => deleteCloudScript(item.id)}>
                      <Text style={m.deleteBtnText}>✕</Text>
                    </TouchableOpacity>
                  </TouchableOpacity>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d', padding: 10, gap: 8},
  targetBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111',
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  targetLabel: {color: '#555', fontFamily: 'monospace', fontSize: 12},
  targetPkg:   {color: '#00ff88', fontFamily: 'monospace', fontSize: 12, flex: 1},
  runDot:      {width: 8, height: 8, borderRadius: 4, backgroundColor: '#00ff88'},
  logcatBadge: {color: '#00ff88', fontSize: 9, fontFamily: 'monospace', marginLeft: 6, opacity: 0.8},
  editor: {
    backgroundColor: '#080808',
    borderRadius: 8,
    padding: 10,
    color: '#00cc66',
    fontFamily: 'monospace',
    fontSize: 12,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    minHeight: 160,
    maxHeight: 220,
    textAlignVertical: 'top',
  },
  btnRow:    {flexDirection: 'row', gap: 6},
  btnSave: {
    flex: 1,
    backgroundColor: '#111',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  btnScripts: {
    flex: 1.2,
    backgroundColor: '#0a1a2a',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#005588',
  },
  btnCloud: {
    flex: 1.2,
    backgroundColor: '#001a0d',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#005533',
  },
  btnRun: {
    flex: 1.6,
    backgroundColor: '#003d22',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  btnStop: {
    flex: 1.6,
    backgroundColor: '#3d0000',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  btnOverlay: {
    flex: 1,
    backgroundColor: '#001a33',
    padding: 10,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#004488',
    marginLeft: 4,
  },
  btnOverlayActive: {
    backgroundColor: '#003366',
    borderColor: '#00aaff',
  },
  btnText: {color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 11},
  outputBox: {
    flex: 1,
    backgroundColor: '#080808',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  outHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  outHeaderRight: {flexDirection: 'row', gap: 10},
  outLabel:  {color: '#333', fontSize: 10, fontFamily: 'monospace'},
  clearBtn:  {color: '#333', fontSize: 10, fontFamily: 'monospace'},
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0d0d0d',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    marginBottom: 6,
    paddingHorizontal: 8,
  },
  searchInput: {
    flex: 1,
    color: '#00ff88',
    fontFamily: 'monospace',
    fontSize: 11,
    paddingVertical: 5,
  },
  searchClear: {padding: 4},
  searchClearText: {color: '#555', fontSize: 12},
  outScroll: {flex: 1},
  outEmpty:  {color: '#333', fontFamily: 'monospace', fontSize: 11},
  outLine:   {color: '#00cc44', fontFamily: 'monospace', fontSize: 11, marginBottom: 1},
  outErr:    {color: '#ff4444'},
  modeRow: {flexDirection: 'row', gap: 6},
  modeBtn: {
    flex: 1, paddingVertical: 7, borderRadius: 6,
    borderWidth: 1, borderColor: '#1e1e1e',
    backgroundColor: '#111', alignItems: 'center',
  },
  modeBtnActive: {borderColor: '#00ff88', backgroundColor: '#001a0d'},
  modeBtnText:     {color: '#444', fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold'},
  modeBtnTextActive: {color: '#00ff88'},
  modeHint: {color: '#334', fontFamily: 'monospace', fontSize: 10, marginTop: -4},
});

const m = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0d0d0d',
    borderTopWidth: 1,
    borderTopColor: '#1e1e1e',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: '75%',
    padding: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sheetTitle: {color: '#00ff88', fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold'},
  closeBtn: {color: '#555', fontSize: 18, padding: 4},
  empty: {color: '#333', fontFamily: 'monospace', fontSize: 12, textAlign: 'center', marginVertical: 30},
  emptyText: {color: '#333', fontFamily: 'monospace', fontSize: 12, textAlign: 'center', marginVertical: 30},
  scriptItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#151515',
    paddingVertical: 10,
  },
  scriptNameBox: {flex: 1},
  scriptNameText: {color: '#ddd', fontFamily: 'monospace', fontSize: 13},
  scriptAuthor: {color: '#005533', fontFamily: 'monospace', fontSize: 10, marginTop: 1},
  scriptPreview: {color: '#333', fontFamily: 'monospace', fontSize: 10, marginTop: 2},
  deleteBtn: {paddingHorizontal: 12, paddingVertical: 8},
  deleteBtnText: {fontSize: 16},
  dialog: {
    backgroundColor: '#0d0d0d',
    margin: 30,
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  dialogTitle: {color: '#00ff88', fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold', marginBottom: 14},
  nameInput: {
    backgroundColor: '#080808',
    borderRadius: 7,
    padding: 10,
    color: '#00ff88',
    fontFamily: 'monospace',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    marginBottom: 14,
  },
  dialogBtns: {flexDirection: 'row', gap: 10},
  dialogCancel: {
    flex: 1, padding: 11, borderRadius: 7,
    backgroundColor: '#111', borderWidth: 1, borderColor: '#1e1e1e',
    alignItems: 'center',
  },
  dialogCancelText: {color: '#555', fontFamily: 'monospace'},
  dialogSave: {
    flex: 1, padding: 11, borderRadius: 7,
    backgroundColor: '#003d22',
    alignItems: 'center',
  },
  dialogSaveText: {color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold'},
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
});

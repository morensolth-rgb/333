import React, {useState, useEffect, useRef, useCallback} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  FlatList,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Clipboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useFocusEffect} from '@react-navigation/native';
import {LICENSE_KEY_STORAGE, LICENSE_EMAIL_STORAGE} from './LicenseScreen';

const API = 'https://fridact-6mzysus-preview-4200.runable.site/api';

// ── Types ─────────────────────────────────────────────────────────────────────
type ChatMsg = {
  id: string;
  sender: string;  // server returns "sender" not "author"
  body: string;    // server returns "body" not "content"
  ts: number;
};

type Script = {
  id: string;
  author: string;
  title: string;
  description: string;
  code: string;
  tags: string;
  likes: number;
  ts: number;
};

type DM = {
  id: string;
  from: string;  // server returns fromU mapped to from
  to: string;    // server returns toU mapped to to
  body: string;  // server field
  ts: number;
  read: boolean;
};

type DMThread = {
  user: string;
  lastMsg: string;
  lastTs: number;
  unread: number;
};

type Tab = 'chat' | 'scripts' | 'dms';

// ── Auth helpers ──────────────────────────────────────────────────────────────
const getAuth = async (): Promise<{token: string; email: string} | null> => {
  const token = await AsyncStorage.getItem(LICENSE_KEY_STORAGE);
  const email = await AsyncStorage.getItem(LICENSE_EMAIL_STORAGE);
  if (!token || !email) return null;
  return {token, email};
};

const makeHeaders = (token: string, email: string, json?: boolean) => ({
  ...(json ? {'Content-Type': 'application/json'} : {}),
  Authorization: 'Bearer ' + token,
  'X-User-Email': email,
});

const apiGet = async (path: string): Promise<any> => {
  const auth = await getAuth();
  if (!auth) throw new Error('Not logged in');
  const r = await fetch(API + path, {headers: makeHeaders(auth.token, auth.email)});
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(text.slice(0, 120)); }
};

const apiPost = async (path: string, body: object): Promise<any> => {
  const auth = await getAuth();
  if (!auth) throw new Error('Not logged in');
  const r = await fetch(API + path, {
    method: 'POST',
    headers: makeHeaders(auth.token, auth.email, true),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(text.slice(0, 120)); }
};

const apiDelete = async (path: string): Promise<any> => {
  const auth = await getAuth();
  if (!auth) throw new Error('Not logged in');
  const r = await fetch(API + path, {
    method: 'DELETE',
    headers: makeHeaders(auth.token, auth.email),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(text.slice(0, 120)); }
};

// ── Chat Tab ──────────────────────────────────────────────────────────────────
function ChatTab() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [myEmail, setMyEmail] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(LICENSE_EMAIL_STORAGE).then(e => {
      if (e) setMyEmail(e);
    });
    load();
    pollRef.current = setInterval(load, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const load = async () => {
    try {
      const j = await apiGet('/community/chat');
      if (Array.isArray(j.messages)) {
        setMsgs(j.messages);
        setTimeout(() => scrollRef.current?.scrollToEnd({animated: false}), 80);
      }
    } catch (_) {}
  };

  const send = async () => {
    const body = input.trim();
    if (!body) return;
    setInput('');
    try {
      const j = await apiPost('/community/chat', {body});
      if (j.ok) load();
      else Alert.alert('Error', j.error || 'Send failed');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Network error');
    }
  };

  const deleteMsg = (id: string) => {
    Alert.alert('Delete', 'Delete this message?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await apiDelete('/community/chat/' + id);
            setMsgs(prev => prev.filter(m => m.id !== id));
          } catch (_) {}
        },
      },
    ]);
  };

  const fmt = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  };

  return (
    <KeyboardAvoidingView
      style={{flex: 1}}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}>
      <ScrollView
        ref={scrollRef}
        style={c.msgScroll}
        contentContainerStyle={{padding: 10, gap: 6}}>
        {loading && msgs.length === 0 && (
          <ActivityIndicator color="#00ff88" style={{marginTop: 40}} />
        )}
        {msgs.length === 0 && !loading && (
          <Text style={c.empty}>No messages yet — be the first</Text>
        )}
        {msgs.map(msg => {
          const mine = msg.sender === myEmail.split('@')[0];
          const hasCode = msg.body.includes('```');
          const onLongPress = () => {
            const codeMatch = msg.body.match(/```\n?([\s\S]*?)```/);
            const options = mine
              ? ['Copy', ...(hasCode ? ['Save Script'] : []), 'Delete', 'Cancel']
              : ['Copy', ...(hasCode ? ['Save Script'] : []), 'Cancel'];
            Alert.alert('Message', undefined, [
              {text: 'Copy', onPress: () => { Clipboard.setString(msg.body); }},
              ...(hasCode ? [{text: 'Save Script', onPress: async () => {
                const code = codeMatch?.[1]?.trim() ?? msg.body;
                const titleMatch = msg.body.match(/📜 Script: (.+)/);
                const name = titleMatch?.[1]?.trim() ?? `Script from ${msg.sender}`;
                const raw = await AsyncStorage.getItem('scriptsList');
                const list = raw ? JSON.parse(raw) : [];
                list.unshift({id: Date.now().toString(), name, code});
                await AsyncStorage.setItem('scriptsList', JSON.stringify(list));
                Alert.alert('Saved', `"${name}" saved to local scripts`);
              }}] : []),
              ...(mine ? [{text: 'Delete', style: 'destructive' as const, onPress: () => deleteMsg(msg.id)}] : []),
              {text: 'Cancel', style: 'cancel' as const},
            ]);
          };
          return (
            <TouchableOpacity
              key={msg.id}
              activeOpacity={0.75}
              onLongPress={onLongPress}
              style={[c.bubble, mine && c.bubbleMine]}>
              {!mine && (
                <Text style={c.bubbleAuthor}>{msg.sender}</Text>
              )}
              <Text style={[c.bubbleText, mine && c.bubbleTextMine]}>{msg.body}</Text>
              <Text style={c.bubbleTime}>{fmt(msg.ts)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <View style={c.inputRow}>
        <TextInput
          style={c.chatInput}
          value={input}
          onChangeText={setInput}
          placeholder="Message..."
          placeholderTextColor="#333"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <TouchableOpacity style={c.sendBtn} onPress={send}>
          <Text style={c.sendBtnText}>▶</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Scripts Tab ───────────────────────────────────────────────────────────────
function ScriptsTab() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Script | null>(null);
  const [dmTarget, setDmTarget] = useState('');
  const [sendDmModal, setSendDmModal] = useState(false);
  const [shareModal, setShareModal] = useState(false);
  const [shareTitle, setShareTitle] = useState('');
  const [shareDesc, setShareDesc] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [myEmail, setMyEmail] = useState('');

  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem(LICENSE_EMAIL_STORAGE).then(e => {
        if (e) setMyEmail(e);
      });
      load();
    }, []),
  );

  const load = async () => {
    setLoading(true);
    try {
      const j = await apiGet('/community/scripts');
      if (Array.isArray(j.scripts)) setScripts(j.scripts);
    } catch (_) {}
    setLoading(false);
  };

  const like = async (id: string) => {
    try {
      const j = await apiPost('/community/scripts/' + id + '/like', {});
      if (j.ok) {
        setScripts(prev =>
          prev.map(s => (s.id === id ? {...s, likes: j.likes} : s)),
        );
      }
    } catch (_) {}
  };

  const share = async () => {
    const title = shareTitle.trim();
    const code = shareCode.trim();
    if (!title || !code) {
      Alert.alert('Error', 'Title and code are required');
      return;
    }
    try {
      const j = await apiPost('/community/scripts', {
        title,
        description: shareDesc.trim(),
        code,
        tags: [],
      });
      if (j.ok) {
        setShareModal(false);
        setShareTitle('');
        setShareDesc('');
        setShareCode('');
        load();
        Alert.alert('Shared!', `"${title}" published to community`);
      } else {
        Alert.alert('Error', j.error || 'Share failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Network error');
    }
  };

  const deleteScript = (id: string) => {
    Alert.alert('Delete', 'Remove from community?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await apiDelete('/community/scripts/' + id);
            setScripts(prev => prev.filter(s => s.id !== id));
          } catch (_) {}
        },
      },
    ]);
  };

  const fmt = (ts: number) => new Date(ts).toLocaleDateString();

  const sendScriptViaDm = async () => {
    const to = dmTarget.trim();
    if (!to || !selected) return;
    const body = `📜 Script: ${selected.title}\n\n\`\`\`\n${selected.code}\n\`\`\``;
    try {
      const j = await apiPost('/community/dm/' + encodeURIComponent(to), {body});
      if (j.ok) {
        setSendDmModal(false);
        setDmTarget('');
        setSelected(null);
        Alert.alert('Sent!', `Script sent to ${to}`);
      } else {
        Alert.alert('Error', j.error || 'Send failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Network error');
    }
  };

  return (
    <View style={{flex: 1}}>
      {/* Header */}
      <View style={sc.header}>
        <Text style={sc.title}>COMMUNITY SCRIPTS</Text>
        <TouchableOpacity style={sc.shareBtn} onPress={() => setShareModal(true)}>
          <Text style={sc.shareBtnText}>+ SHARE</Text>
        </TouchableOpacity>
      </View>

      {loading && scripts.length === 0 ? (
        <ActivityIndicator color="#00ff88" style={{marginTop: 40}} />
      ) : scripts.length === 0 ? (
        <Text style={c.empty}>No scripts yet</Text>
      ) : (
        <FlatList
          data={scripts}
          keyExtractor={s => s.id}
          contentContainerStyle={{padding: 10, gap: 8}}
          renderItem={({item}) => {
            const mine = item.author === myEmail;
            return (
              <TouchableOpacity style={sc.card} onPress={() => setSelected(item)}>
                <View style={sc.cardTop}>
                  <Text style={sc.cardTitle} numberOfLines={1}>{item.title}</Text>
                  <View style={sc.cardActions}>
                    <TouchableOpacity style={sc.likeBtn} onPress={() => like(item.id)}>
                      <Text style={sc.likeBtnText}>♥ {item.likes}</Text>
                    </TouchableOpacity>
                    {mine && (
                      <TouchableOpacity style={sc.delBtn} onPress={() => deleteScript(item.id)}>
                        <Text style={sc.delBtnText}>✕</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
                <Text style={sc.cardAuthor}>
                  {item.author.split('@')[0]} · {fmt(item.ts)}
                </Text>
                {item.description ? (
                  <Text style={sc.cardDesc} numberOfLines={2}>{item.description}</Text>
                ) : null}
                <Text style={sc.cardCode} numberOfLines={2}>{item.code}</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Script Detail Modal */}
      <Modal visible={!!selected} animationType="slide" transparent>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <View style={m.sheetHeader}>
              <Text style={m.sheetTitle} numberOfLines={1}>{selected?.title}</Text>
              <TouchableOpacity onPress={() => setSelected(null)}>
                <Text style={m.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={m.meta}>
              by {selected?.author?.split('@')[0]} · {selected ? fmt(selected.ts) : ''} · ♥ {selected?.likes}
            </Text>
            {selected?.description ? (
              <Text style={m.desc}>{selected.description}</Text>
            ) : null}
            <ScrollView style={m.codeScroll}>
              <Text style={m.code}>{selected?.code}</Text>
            </ScrollView>
            <TouchableOpacity
              style={[m.actionBtn, {marginTop: 12}]}
              onPress={() => setSendDmModal(true)}>
              <Text style={m.actionBtnText}>✉ SEND VIA DM</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Send via DM Modal */}
      <Modal visible={sendDmModal} animationType="fade" transparent>
        <KeyboardAvoidingView
          style={{flex: 1}}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={m.overlay}>
            <View style={m.sheet}>
              <View style={m.sheetHeader}>
                <Text style={m.sheetTitle}>✉ SEND SCRIPT VIA DM</Text>
                <TouchableOpacity onPress={() => { setSendDmModal(false); setDmTarget(''); }}>
                  <Text style={m.closeBtn}>✕</Text>
                </TouchableOpacity>
              </View>
              <Text style={m.meta}>Script: {selected?.title}</Text>
              <TextInput
                style={[m.input, {marginTop: 12}]}
                value={dmTarget}
                onChangeText={setDmTarget}
                placeholder="Recipient username *"
                placeholderTextColor="#333"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              <TouchableOpacity style={m.actionBtn} onPress={sendScriptViaDm}>
                <Text style={m.actionBtnText}>SEND</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Share Modal */}
      <Modal visible={shareModal} animationType="slide" transparent>
        <KeyboardAvoidingView
          style={{flex: 1}}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={m.overlay}>
            <View style={m.sheet}>
              <View style={m.sheetHeader}>
                <Text style={m.sheetTitle}>SHARE SCRIPT</Text>
                <TouchableOpacity onPress={() => setShareModal(false)}>
                  <Text style={m.closeBtn}>✕</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={m.input}
                value={shareTitle}
                onChangeText={setShareTitle}
                placeholder="Title *"
                placeholderTextColor="#333"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={m.input}
                value={shareDesc}
                onChangeText={setShareDesc}
                placeholder="Description (optional)"
                placeholderTextColor="#333"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={[m.input, {minHeight: 120, textAlignVertical: 'top'}]}
                value={shareCode}
                onChangeText={setShareCode}
                placeholder="Frida script code *"
                placeholderTextColor="#333"
                autoCapitalize="none"
                autoCorrect={false}
                multiline
              />
              <TouchableOpacity style={m.actionBtn} onPress={share}>
                <Text style={m.actionBtnText}>PUBLISH</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ── DMs Tab ───────────────────────────────────────────────────────────────────
// Server routes: GET /community/dm/threads, GET /community/dm/:user, POST /community/dm/:user
function DMsTab() {
  const [threads, setThreads] = useState<DMThread[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages]   = useState<DM[]>([]);
  const [loading, setLoading]     = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);
  const [composeModal, setComposeModal] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [dmInput, setDmInput]     = useState('');
  const [myEmail, setMyEmail]     = useState('');
  // Script picker state
  const [scriptPickerModal, setScriptPickerModal] = useState(false);
  const [cloudScripts, setCloudScripts]   = useState<Script[]>([]);
  const [localScripts, setLocalScripts]   = useState<{id:string;name:string;code:string}[]>([]);
  const [scriptTab, setScriptTab]         = useState<'cloud'|'local'>('cloud');
  const [scriptLoading, setScriptLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(LICENSE_EMAIL_STORAGE).then(e => {
      if (e) setMyEmail(e);
    });
    loadThreads();
    pollRef.current = setInterval(loadThreads, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (activeThread) loadConvo(activeThread);
  }, [activeThread]);

  const loadThreads = async () => {
    setLoading(true);
    try {
      const j = await apiGet('/community/dm/threads');
      if (Array.isArray(j.threads)) setThreads(j.threads);
    } catch (_) {}
    setLoading(false);
  };

  const loadConvo = async (user: string) => {
    setMsgLoading(true);
    try {
      const j = await apiGet('/community/dm/' + encodeURIComponent(user));
      if (Array.isArray(j.messages)) {
        setMessages(j.messages);
        setTimeout(() => scrollRef.current?.scrollToEnd({animated: false}), 80);
      }
    } catch (_) {}
    setMsgLoading(false);
  };

  const openScriptPicker = async () => {
    setScriptPickerModal(true);
    setScriptLoading(true);
    try {
      // Load cloud scripts
      const j = await apiGet('/community/scripts?mine=1');
      if (Array.isArray(j.scripts)) setCloudScripts(j.scripts);
      // Load local scripts from AsyncStorage
      const raw = await AsyncStorage.getItem('scriptsList');
      if (raw) setLocalScripts(JSON.parse(raw));
    } catch (_) {}
    setScriptLoading(false);
  };

  const sendScriptInConvo = async (code: string, title: string) => {
    if (!activeThread) return;
    const body = `📜 Script: ${title}\n\n\`\`\`\n${code}\n\`\`\``;
    try {
      const j = await apiPost('/community/dm/' + encodeURIComponent(activeThread), {body});
      if (j.ok) {
        setScriptPickerModal(false);
        loadConvo(activeThread);
      } else {
        Alert.alert('Error', j.error || 'Send failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Network error');
    }
  };

  const sendDm = async () => {
    const to   = activeThread ?? recipient.trim();
    const body = dmInput.trim();
    if (!to || !body) {
      Alert.alert('Error', 'Recipient and message are required');
      return;
    }
    try {
      const j = await apiPost('/community/dm/' + encodeURIComponent(to), {body});
      if (j.ok) {
        setDmInput('');
        setComposeModal(false);
        setRecipient('');
        if (activeThread) loadConvo(activeThread);
        loadThreads();
      } else {
        Alert.alert('Error', j.error || 'Send failed');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Network error');
    }
  };

  const fmtShort = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  };

  // ── Thread list view ──────────────────────────────────────────────────────
  if (!activeThread) {
    return (
      <View style={{flex: 1}}>
        <View style={sc.header}>
          <Text style={sc.title}>DIRECT MESSAGES</Text>
          <TouchableOpacity style={sc.shareBtn} onPress={() => setComposeModal(true)}>
            <Text style={sc.shareBtnText}>+ NEW DM</Text>
          </TouchableOpacity>
        </View>

        {loading && threads.length === 0 ? (
          <ActivityIndicator color="#00ff88" style={{marginTop: 40}} />
        ) : threads.length === 0 ? (
          <Text style={c.empty}>No conversations yet</Text>
        ) : (
          <FlatList
            data={threads}
            keyExtractor={t => t.user}
            contentContainerStyle={{padding: 10, gap: 6}}
            renderItem={({item}) => (
              <TouchableOpacity style={dm.card} onPress={() => setActiveThread(item.user)}>
                <View style={dm.cardHeader}>
                  <Text style={dm.label}>{item.user}</Text>
                  <Text style={dm.time}>{fmtShort(item.lastTs)}</Text>
                </View>
                <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
                  <Text style={dm.content} numberOfLines={1}>{item.lastMsg}</Text>
                  {item.unread > 0 && (
                    <View style={dm.badge}>
                      <Text style={dm.badgeText}>{item.unread}</Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            )}
          />
        )}

        {/* Compose new DM Modal */}
        <Modal visible={composeModal} animationType="slide" transparent>
          <KeyboardAvoidingView
            style={{flex: 1}}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={m.overlay}>
              <View style={m.sheet}>
                <View style={m.sheetHeader}>
                  <Text style={m.sheetTitle}>NEW DM</Text>
                  <TouchableOpacity onPress={() => setComposeModal(false)}>
                    <Text style={m.closeBtn}>✕</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={m.input}
                  value={recipient}
                  onChangeText={setRecipient}
                  placeholder="Recipient username *"
                  placeholderTextColor="#333"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TextInput
                  style={[m.input, {minHeight: 80, textAlignVertical: 'top'}]}
                  value={dmInput}
                  onChangeText={setDmInput}
                  placeholder="Message *"
                  placeholderTextColor="#333"
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />
                <TouchableOpacity style={m.actionBtn} onPress={sendDm}>
                  <Text style={m.actionBtnText}>SEND</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    );
  }

  // ── Conversation view ─────────────────────────────────────────────────────
  const myUsername = myEmail.includes('@') ? myEmail.split('@')[0].toLowerCase() : myEmail.toLowerCase();

  return (
    <KeyboardAvoidingView
      style={{flex: 1}}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}>
      {/* Back header */}
      <View style={sc.header}>
        <TouchableOpacity onPress={() => { setActiveThread(null); setMessages([]); }}>
          <Text style={{color: '#00ff88', fontFamily: 'monospace', fontSize: 13}}>← BACK</Text>
        </TouchableOpacity>
        <Text style={[sc.title, {flex: 1, textAlign: 'center'}]}>{activeThread}</Text>
        <View style={{width: 50}} />
      </View>

      {msgLoading && messages.length === 0 ? (
        <ActivityIndicator color="#00ff88" style={{marginTop: 40}} />
      ) : (
        <ScrollView
          ref={scrollRef}
          style={c.msgScroll}
          contentContainerStyle={{padding: 10, gap: 6}}>
          {messages.length === 0 && (
            <Text style={c.empty}>No messages yet</Text>
          )}
          {messages.map(msg => {
            const mine = msg.from === myUsername;
            const hasCode = msg.body.includes('```');
            const onLongPress = () => {
              const codeMatch = msg.body.match(/```\n?([\s\S]*?)```/);
              Alert.alert('Message', undefined, [
                {text: 'Copy', onPress: () => { Clipboard.setString(msg.body); }},
                ...(hasCode ? [{text: 'Save Script', onPress: async () => {
                  const code = codeMatch?.[1]?.trim() ?? msg.body;
                  const titleMatch = msg.body.match(/📜 Script: (.+)/);
                  const name = titleMatch?.[1]?.trim() ?? `Script from ${msg.from}`;
                  const raw = await AsyncStorage.getItem('scriptsList');
                  const list = raw ? JSON.parse(raw) : [];
                  list.unshift({id: Date.now().toString(), name, code});
                  await AsyncStorage.setItem('scriptsList', JSON.stringify(list));
                  Alert.alert('Saved', `"${name}" saved to local scripts`);
                }}] : []),
                {text: 'Cancel', style: 'cancel' as const},
              ]);
            };
            return (
              <TouchableOpacity
                key={msg.id}
                activeOpacity={0.75}
                onLongPress={onLongPress}
                style={[c.bubble, mine && c.bubbleMine]}>
                {!mine && <Text style={c.bubbleAuthor}>{msg.from}</Text>}
                <Text style={[c.bubbleText, mine && c.bubbleTextMine]}>{msg.body}</Text>
                <Text style={c.bubbleTime}>{fmtShort(msg.ts)}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      <View style={c.inputRow}>
        <TouchableOpacity style={c.attachBtn} onPress={openScriptPicker}>
          <Text style={c.attachBtnText}>📎</Text>
        </TouchableOpacity>
        <TextInput
          style={c.chatInput}
          value={dmInput}
          onChangeText={setDmInput}
          placeholder="Message..."
          placeholderTextColor="#333"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={sendDm}
          returnKeyType="send"
        />
        <TouchableOpacity style={c.sendBtn} onPress={sendDm}>
          <Text style={c.sendBtnText}>▶</Text>
        </TouchableOpacity>
      </View>

      {/* Script Picker Modal */}
      <Modal visible={scriptPickerModal} animationType="slide" transparent>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <View style={m.sheetHeader}>
              <Text style={m.sheetTitle}>📎 SEND A SCRIPT</Text>
              <TouchableOpacity onPress={() => setScriptPickerModal(false)}>
                <Text style={m.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            {/* Cloud / Local tab */}
            <View style={{flexDirection: 'row', gap: 8, marginBottom: 12}}>
              {(['cloud', 'local'] as const).map(t => (
                <TouchableOpacity
                  key={t}
                  style={[sc.shareBtn, scriptTab === t && {backgroundColor: '#005533'}]}
                  onPress={() => setScriptTab(t)}>
                  <Text style={sc.shareBtnText}>{t === 'cloud' ? '☁ CLOUD' : '💾 LOCAL'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {scriptLoading ? (
              <ActivityIndicator color="#00ff88" style={{marginTop: 20}} />
            ) : (
              <FlatList
                data={scriptTab === 'cloud' ? cloudScripts : localScripts}
                keyExtractor={item => item.id}
                style={{maxHeight: 300}}
                ListEmptyComponent={<Text style={m.meta}>No scripts found</Text>}
                renderItem={({item}) => (
                  <TouchableOpacity
                    style={sc.card}
                    onPress={() => sendScriptInConvo(
                      item.code,
                      (item as any).title ?? (item as any).name,
                    )}>
                    <Text style={sc.cardTitle} numberOfLines={1}>
                      {(item as any).title ?? (item as any).name}
                    </Text>
                    <Text style={sc.cardCode} numberOfLines={1}>{item.code}</Text>
                  </TouchableOpacity>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ── Root Screen ───────────────────────────────────────────────────────────────
export default function CommunityScreen() {
  const [tab, setTab] = useState<Tab>('chat');

  return (
    <View style={root.container}>
      {/* Tab bar */}
      <View style={root.tabs}>
        {(['chat', 'scripts', 'dms'] as Tab[]).map(t => (
          <TouchableOpacity
            key={t}
            style={[root.tab, tab === t && root.tabActive]}
            onPress={() => setTab(t)}>
            <Text style={[root.tabText, tab === t && root.tabTextActive]}>
              {t === 'chat' ? '💬 CHAT' : t === 'scripts' ? '📜 SCRIPTS' : '✉ DMS'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {tab === 'chat'    && <ChatTab />}
      {tab === 'scripts' && <ScriptsTab />}
      {tab === 'dms'     && <DMsTab />}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const root = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d'},
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
    backgroundColor: '#080808',
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#00ff88',
  },
  tabText: {color: '#444', fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold'},
  tabTextActive: {color: '#00ff88'},
});

const c = StyleSheet.create({
  msgScroll: {flex: 1, backgroundColor: '#0d0d0d'},
  bubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#111',
    borderRadius: 10,
    borderTopLeftRadius: 2,
    padding: 10,
    maxWidth: '80%',
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  bubbleMine: {
    alignSelf: 'flex-end',
    backgroundColor: '#001a0d',
    borderTopLeftRadius: 10,
    borderTopRightRadius: 2,
    borderColor: '#003322',
  },
  bubbleAuthor: {color: '#005533', fontFamily: 'monospace', fontSize: 10, marginBottom: 3},
  bubbleText: {color: '#ccc', fontFamily: 'monospace', fontSize: 13},
  bubbleTextMine: {color: '#00ff88'},
  bubbleTime: {color: '#333', fontFamily: 'monospace', fontSize: 9, marginTop: 4, textAlign: 'right'},
  inputRow: {
    flexDirection: 'row',
    padding: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e1e1e',
    backgroundColor: '#080808',
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#00ff88',
    fontFamily: 'monospace',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  sendBtn: {
    backgroundColor: '#003d22',
    paddingHorizontal: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnText: {color: '#00ff88', fontFamily: 'monospace', fontSize: 16, fontWeight: 'bold'},
  attachBtn: {
    backgroundColor: '#111',
    paddingHorizontal: 10,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  attachBtnText: {fontSize: 18},
  empty: {
    color: '#333',
    fontFamily: 'monospace',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 40,
  },
});

const sc = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  title: {color: '#00ff88', fontFamily: 'monospace', fontSize: 12, fontWeight: 'bold'},
  shareBtn: {
    backgroundColor: '#003d22',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  shareBtnText: {color: '#00ff88', fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold'},
  card: {
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  cardTitle: {
    flex: 1,
    color: '#00ff88',
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: 'bold',
  },
  cardActions: {flexDirection: 'row', gap: 8, alignItems: 'center'},
  likeBtn: {
    backgroundColor: '#1a0011',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#330022',
  },
  likeBtnText: {color: '#ff4488', fontFamily: 'monospace', fontSize: 11},
  delBtn: {padding: 4},
  delBtnText: {color: '#444', fontFamily: 'monospace', fontSize: 13},
  cardAuthor: {color: '#333', fontFamily: 'monospace', fontSize: 10, marginTop: 3},
  cardDesc: {color: '#555', fontFamily: 'monospace', fontSize: 11, marginTop: 5},
  cardCode: {
    color: '#1e3d1e',
    fontFamily: 'monospace',
    fontSize: 10,
    marginTop: 6,
    backgroundColor: '#080808',
    padding: 6,
    borderRadius: 4,
  },
});

const dm = StyleSheet.create({
  card: {
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  cardMine: {
    backgroundColor: '#001a0d',
    borderColor: '#003322',
  },
  cardHeader: {flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6},
  label: {color: '#005533', fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold'},
  time:  {color: '#333', fontFamily: 'monospace', fontSize: 10},
  content: {color: '#ccc', fontFamily: 'monospace', fontSize: 13},
  badge: {
    backgroundColor: '#00ff88',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {color: '#000', fontFamily: 'monospace', fontSize: 10, fontWeight: 'bold'},
});

const m = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0d0d0d',
    borderTopWidth: 1,
    borderTopColor: '#1e1e1e',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: '85%',
    padding: 16,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sheetTitle: {color: '#00ff88', fontFamily: 'monospace', fontSize: 13, fontWeight: 'bold', flex: 1},
  closeBtn: {color: '#555', fontSize: 18, padding: 4},
  meta: {color: '#333', fontFamily: 'monospace', fontSize: 11, marginBottom: 8},
  desc: {color: '#555', fontFamily: 'monospace', fontSize: 12, marginBottom: 8},
  codeScroll: {
    backgroundColor: '#080808',
    borderRadius: 8,
    padding: 10,
    maxHeight: 300,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  code: {color: '#00cc44', fontFamily: 'monospace', fontSize: 12},
  input: {
    backgroundColor: '#080808',
    borderRadius: 7,
    padding: 10,
    color: '#00ff88',
    fontFamily: 'monospace',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    marginBottom: 10,
  },
  actionBtn: {
    backgroundColor: '#003d22',
    padding: 13,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  actionBtnText: {color: '#00ff88', fontFamily: 'monospace', fontWeight: 'bold', fontSize: 13},
});

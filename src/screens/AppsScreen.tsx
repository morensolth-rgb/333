import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import {rootBridge, AppInfo} from '../native/RootBridge';
import AsyncStorage from '@react-native-async-storage/async-storage';

type FilterMode = 'user' | 'all' | 'system';

export default function AppsScreen({navigation}: {navigation: any}) {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [filtered, setFiltered] = useState<AppInfo[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>('');
  const [filter, setFilter] = useState<FilterMode>('user');
  // SDK labels loaded separately after list renders
  const [sdkMap, setSdkMap] = useState<Record<string, string>>({});

  useEffect(() => {
    loadSelected();
    loadApps();
  }, []);

  useEffect(() => {
    applyFilter();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, apps, filter, selected]);

  const applyFilter = useCallback(() => {
    const q = search.toLowerCase().trim();
    let list = [...apps];

    if (filter === 'user') {
      list = list.filter(a => !a.isSystemApp);
    } else if (filter === 'system') {
      list = list.filter(a => a.isSystemApp);
    }

    if (q) {
      list = list.filter(
        a =>
          a.appName.toLowerCase().includes(q) ||
          a.packageName.toLowerCase().includes(q),
      );
    }

    // Sort: selected first → alphabetical
    list.sort((a, b) => {
      if (a.packageName === selected) return -1;
      if (b.packageName === selected) return 1;
      return a.appName.localeCompare(b.appName);
    });

    setFiltered(list);
  }, [search, apps, filter, selected]);

  const loadSelected = async () => {
    const pkg = await AsyncStorage.getItem('selectedApp');
    if (pkg) setSelected(pkg);
  };

  const loadApps = async () => {
    setLoading(true);
    setSdkMap({});
    try {
      const list = await rootBridge.getInstalledApps();
      setApps(list);
      // Load SDK labels after list is rendered — non-blocking
      loadSdkLabels(list);
    } catch (e: any) {
      console.error('getInstalledApps error:', e);
    }
    setLoading(false);
  };

  const loadSdkLabels = async (list: AppInfo[]) => {
    try {
      const map = await rootBridge.detectSdks();
      setSdkMap(map);
    } catch (_) {}
  };

  const selectApp = async (pkg: string) => {
    setSelected(pkg);
    await AsyncStorage.setItem('selectedApp', pkg);
  };

  const userCount   = apps.filter(a => !a.isSystemApp).length;
  const systemCount = apps.filter(a => a.isSystemApp).length;

  const tabs: {label: string; value: FilterMode; count: number}[] = [
    {label: 'User',   value: 'user',   count: userCount},
    {label: 'All',    value: 'all',    count: apps.length},
    {label: 'System', value: 'system', count: systemCount},
  ];

  return (
    <View style={s.container}>
      {/* Filter tabs */}
      <View style={s.tabs}>
        {tabs.map(t => (
          <TouchableOpacity
            key={t.value}
            style={[s.tab, filter === t.value && s.tabActive]}
            onPress={() => setFilter(t.value)}>
            <Text style={[s.tabText, filter === t.value && s.tabTextActive]}>
              {t.label}
              <Text style={s.tabCount}> {t.count}</Text>
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TextInput
        style={s.search}
        placeholder="Search by name or package..."
        placeholderTextColor="#333"
        value={search}
        onChangeText={setSearch}
      />

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color="#00ff88" size="large" />
          <Text style={s.loadingText}>Loading via root shell...</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.packageName}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={loadApps} tintColor="#00ff88" />
          }
          renderItem={({item}) => {
            const sdk = sdkMap[item.packageName];
            return (
              <View style={[s.item, selected === item.packageName && s.itemSelected]}>
                <TouchableOpacity
                  style={s.itemMain}
                  onPress={() => selectApp(item.packageName)}>
                  <View style={s.itemRow}>
                    <Text style={s.appName} numberOfLines={1}>{item.appName}</Text>
                    {item.isSystemApp && <Text style={s.sysTag}>SYS</Text>}
                    {selected === item.packageName && <Text style={s.targetTag}>TARGET</Text>}
                  </View>
                  <Text style={s.pkg} numberOfLines={1}>{item.packageName}</Text>
                  {!!sdk && <Text style={s.sdkLabel}>{sdk}</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.browseBtn}
                  onPress={() =>
                    navigation.navigate('FileBrowser', {
                      path:  `/data/data/${item.packageName}/shared_prefs`,
                      title: item.packageName.split('.').pop() ?? item.packageName,
                    })
                  }>
                  <Text style={s.browseBtnText}>📁</Text>
                </TouchableOpacity>
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={s.empty}>
              {search ? 'No results for "' + search + '"' : 'No apps found'}
            </Text>
          }
          getItemLayout={(_, index) => ({length: 58, offset: 58 * index, index})}
          initialNumToRender={30}
          maxToRenderPerBatch={30}
          windowSize={10}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d0d0d'},
  tabs: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 7,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: '#1e1e1e',
    alignItems: 'center',
  },
  tabActive: {backgroundColor: '#0a2a15', borderColor: '#00ff88'},
  tabText: {color: '#444', fontFamily: 'monospace', fontSize: 12},
  tabTextActive: {color: '#00ff88'},
  tabCount: {color: '#333', fontSize: 10},
  search: {
    margin: 10,
    marginTop: 6,
    backgroundColor: '#111',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#00ff88',
    fontFamily: 'monospace',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#151515',
    height: 58,
  },
  itemMain: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: 'center',
    height: 58,
    overflow: 'hidden',
  },
  itemSelected: {backgroundColor: '#091a0e'},
  itemRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2},
  browseBtn: {
    paddingHorizontal: 14,
    alignSelf: 'stretch',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: '#1a1a1a',
  },
  browseBtnText: {fontSize: 18},
  appName: {color: '#ddd', fontFamily: 'monospace', fontSize: 13, flex: 1},
  sysTag: {
    color: '#333', fontFamily: 'monospace', fontSize: 9,
    borderWidth: 1, borderColor: '#2a2a2a',
    paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3,
  },
  targetTag: {
    color: '#00ff88', fontFamily: 'monospace', fontSize: 9,
    borderWidth: 1, borderColor: '#00ff88',
    paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3,
  },
  pkg: {color: '#3a3a3a', fontFamily: 'monospace', fontSize: 10},
  sdkLabel: {color: '#00aaff', fontFamily: 'monospace', fontSize: 9, marginTop: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12},
  loadingText: {color: '#333', fontFamily: 'monospace', fontSize: 12},
  empty: {color: '#2a2a2a', textAlign: 'center', marginTop: 60, fontFamily: 'monospace', fontSize: 13},
});

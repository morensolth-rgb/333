import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Image,
  RefreshControl,
  Dimensions,
} from 'react-native';
import {rootBridge, AppInfo} from '../native/RootBridge';
import AsyncStorage from '@react-native-async-storage/async-storage';

type FilterMode = 'user' | 'all' | 'system';

const COLS = 3;
const SCREEN_W = Dimensions.get('window').width;
const CELL_W = Math.floor((SCREEN_W - 24) / COLS); // 8px padding each side + gaps
const ICON_SIZE = CELL_W - 28;

function AppIcon({packageName}: {packageName: string}) {
  const [uri, setUri] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    rootBridge.getAppIcon(packageName).then(b64 => {
      if (mounted.current) setUri(b64);
    }).catch(() => {});
    return () => { mounted.current = false; };
  }, [packageName]);

  if (!uri) {
    return (
      <View style={[styles.iconPlaceholder, {width: ICON_SIZE, height: ICON_SIZE}]}>
        <Text style={styles.iconPlaceholderText}>
          {packageName.split('.').pop()?.slice(0, 2).toUpperCase() ?? '??'}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{uri}}
      style={{width: ICON_SIZE, height: ICON_SIZE, borderRadius: 14}}
      resizeMode="contain"
    />
  );
}

export default function AppsScreen({navigation}: {navigation: any}) {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [filtered, setFiltered] = useState<AppInfo[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>('');
  const [filter, setFilter] = useState<FilterMode>('user');
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

    if (filter === 'user')   list = list.filter(a => !a.isSystemApp);
    else if (filter === 'system') list = list.filter(a => a.isSystemApp);

    if (q) {
      list = list.filter(
        a => a.appName.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q),
      );
    }

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
      loadSdkLabels();
    } catch (e: any) {
      console.error('getInstalledApps error:', e);
    }
    setLoading(false);
  };

  const loadSdkLabels = async () => {
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

  const renderItem = ({item}: {item: AppInfo}) => {
    const sdk = sdkMap[item.packageName];
    const isSelected = selected === item.packageName;
    return (
      <TouchableOpacity
        style={[styles.cell, isSelected && styles.cellSelected]}
        onPress={() => selectApp(item.packageName)}
        onLongPress={() =>
          navigation.navigate('FileBrowser', {
            path:  `/data/data/${item.packageName}/shared_prefs`,
            title: item.packageName.split('.').pop() ?? item.packageName,
          })
        }>
        <AppIcon packageName={item.packageName} />
        <Text style={styles.cellName} numberOfLines={2}>{item.appName}</Text>
        {!!sdk && <Text style={styles.sdkLabel}>{sdk}</Text>}
        {isSelected && <View style={styles.targetDot} />}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Filter tabs */}
      <View style={styles.tabs}>
        {tabs.map(t => (
          <TouchableOpacity
            key={t.value}
            style={[styles.tab, filter === t.value && styles.tabActive]}
            onPress={() => setFilter(t.value)}>
            <Text style={[styles.tabText, filter === t.value && styles.tabTextActive]}>
              {t.label}
              <Text style={styles.tabCount}> {t.count}</Text>
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TextInput
        style={styles.search}
        placeholder="Search games..."
        placeholderTextColor="#444"
        value={search}
        onChangeText={setSearch}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#00ff88" size="large" />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.packageName}
          numColumns={COLS}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={loadApps} tintColor="#00ff88" />
          }
          renderItem={renderItem}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {search ? `No results for "${search}"` : 'No apps found'}
            </Text>
          }
          contentContainerStyle={styles.grid}
          initialNumToRender={24}
          maxToRenderPerBatch={12}
          windowSize={10}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
  tabActive: {
    backgroundColor: '#001a0d',
    borderColor: '#00ff88',
  },
  tabText:       {color: '#555', fontSize: 12, fontFamily: 'monospace'},
  tabTextActive: {color: '#00ff88'},
  tabCount:      {color: '#333', fontSize: 11},

  search: {
    marginHorizontal: 10,
    marginVertical: 6,
    backgroundColor: '#111',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#00ff88',
    fontSize: 13,
    fontFamily: 'monospace',
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },

  grid: {
    paddingHorizontal: 8,
    paddingBottom: 20,
  },

  cell: {
    width: CELL_W,
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    margin: 4,
    borderRadius: 10,
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#1a1a1a',
    position: 'relative',
  },
  cellSelected: {
    borderColor: '#00ff88',
    backgroundColor: '#001a0d',
  },
  cellName: {
    color: '#e0e0e0',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 15,
  },
  sdkLabel: {
    color: '#0af',
    fontSize: 9,
    fontFamily: 'monospace',
    marginTop: 2,
    textAlign: 'center',
  },
  targetDot: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#00ff88',
  },

  iconPlaceholder: {
    borderRadius: 14,
    backgroundColor: '#1a1a1a',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#252525',
  },
  iconPlaceholderText: {
    color: '#00ff88',
    fontSize: 18,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },

  center:      {flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60},
  loadingText: {color: '#00ff88', marginTop: 12, fontFamily: 'monospace', fontSize: 12},
  empty:       {color: '#444', textAlign: 'center', marginTop: 60, fontFamily: 'monospace'},
});

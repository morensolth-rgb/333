import React, {useEffect, useState} from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {Text, View, StyleSheet, Animated, Image} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import HomeScreen        from './src/screens/HomeScreen';
import AppsScreen        from './src/screens/AppsScreen';
import FileBrowserScreen from './src/screens/FileBrowserScreen';
import ScriptScreen      from './src/screens/ScriptScreen';
import ConsoleScreen     from './src/screens/ConsoleScreen';
import AnalyzerScreen    from './src/screens/AnalyzerScreen';
import LicenseScreen, {LICENSE_KEY_STORAGE, LICENSE_SERVER} from './src/screens/LicenseScreen';
import CommunityScreen  from './src/screens/CommunityScreen';
import GameScreen       from './src/screens/GameScreen';
import HackGamesScreen  from './src/screens/HackGamesScreen';

const Tab   = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TabIcon = ({name, color}: {name: string; color: string}) => (
  <Text style={{color, fontSize: 20}}>{name}</Text>
);

// ── Apps stack ─────────────────────────────────────────────────────────────────
function AppsStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: {backgroundColor: '#0d0d0d'},
        headerTintColor: '#00ff88',
        headerTitleStyle: {fontFamily: 'monospace', fontWeight: 'bold'},
        contentStyle: {backgroundColor: '#0d0d0d'},
      }}>
      <Stack.Screen name="AppsList"    component={AppsScreen}        options={{title: 'Apps', headerShown: false}} />
      <Stack.Screen name="FileBrowser" component={FileBrowserScreen} options={({route}: any) => ({title: route.params?.title ?? 'Files', headerBackTitle: 'Apps'})} />
    </Stack.Navigator>
  );
}

// ── Splash ─────────────────────────────────────────────────────────────────────
function SplashScreen() {
  const opacity = React.useRef(new Animated.Value(0)).current;
  const scale   = React.useRef(new Animated.Value(0.85)).current;
  const tagOp   = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, {toValue: 1, duration: 600, useNativeDriver: true}),
        Animated.spring(scale,   {toValue: 1, friction: 5,   useNativeDriver: true}),
      ]),
      Animated.delay(400),
      Animated.timing(tagOp, {toValue: 1, duration: 500, useNativeDriver: true}),
    ]).start();
  }, []);

  return (
    <View style={sp.container}>
      <Image
        source={require('./android/app/src/main/res/drawable/apextracker.jpg')}
        style={sp.bgImage}
        resizeMode="cover"
      />
      <View style={sp.overlay} />
      <View style={sp.gridH1} /><View style={sp.gridH2} />
      <View style={sp.gridV1} /><View style={sp.gridV2} />

      <Animated.View style={[sp.box, {opacity, transform: [{scale}]}]}>
        <Text style={sp.bracket}>[</Text>
        <View style={sp.mid}>
          <Text style={sp.title}>FRIDA</Text>
          <Text style={sp.ctl}>CTL</Text>
        </View>
        <Text style={sp.bracket}>]</Text>
      </Animated.View>

      <Animated.Text style={[sp.dev, {opacity: tagOp}]}>
        Developer Haider (Apex tracker) 💀
      </Animated.Text>

      <View style={sp.scanLine} />
    </View>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
type AppState = 'splash' | 'license' | 'main';

export default function App() {
  const [appState, setAppState] = useState<AppState>('splash');

  useEffect(() => {
    // After splash: verify saved token with server
    const t = setTimeout(async () => {
      try {
        const token = await AsyncStorage.getItem(LICENSE_KEY_STORAGE);
        if (token) {
          let deviceId = await AsyncStorage.getItem('device_id').catch(() => null);
          if (!deviceId) {
            deviceId = 'dv-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
            await AsyncStorage.setItem('device_id', deviceId);
          }
          const res  = await fetch(`${LICENSE_SERVER}/verify-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, deviceId }),
          });
          const data = await res.json();
          if (data.valid) {
            setAppState('main');
            return;
          }
        }
        setAppState('license');
      } catch {
        // No internet or server error — allow if token exists (offline grace)
        const token = await AsyncStorage.getItem(LICENSE_KEY_STORAGE).catch(() => null);
        setAppState(token ? 'main' : 'license');
      }
    }, 2200);
    return () => clearTimeout(t);
  }, []);

  if (appState === 'splash')  return <SplashScreen />;
  if (appState === 'license') return <LicenseScreen onUnlocked={() => setAppState('main')} />;

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            tabBarStyle: {backgroundColor: '#0d0d0d', borderTopColor: '#1a1a1a'},
            tabBarActiveTintColor: '#00ff88',
            tabBarInactiveTintColor: '#555',
            headerStyle: {backgroundColor: '#0d0d0d'},
            headerTintColor: '#00ff88',
            headerTitleStyle: {fontFamily: 'monospace', fontWeight: 'bold'},
          }}>
          <Tab.Screen
            name="Home" component={HomeScreen}
            options={{title: 'FridaCtl', tabBarIcon: ({color}) => <TabIcon name="⚡" color={color} />}}
          />
          <Tab.Screen
            name="Apps" component={AppsStack}
            options={{title: 'Apps', headerShown: false, tabBarIcon: ({color}) => <TabIcon name="📱" color={color} />}}
          />
          <Tab.Screen
            name="Script" component={ScriptScreen}
            options={{title: 'Script', tabBarIcon: ({color}) => <TabIcon name="📝" color={color} />}}
          />
          <Tab.Screen
            name="Console" component={ConsoleScreen}
            options={{title: 'Console', tabBarIcon: ({color}) => <TabIcon name="🖥" color={color} />}}
          />
          <Tab.Screen
            name="Analyzer" component={AnalyzerScreen}
            options={{title: 'Analyzer', tabBarIcon: ({color}) => <TabIcon name="🔬" color={color} />}}
          />
          <Tab.Screen
            name="Game" component={GameScreen}
            options={{title: 'Game', tabBarIcon: ({color}) => <TabIcon name="🎮" color={color} />}}
          />
          <Tab.Screen
            name="HackGames" component={HackGamesScreen}
            options={{title: 'Hack Games', tabBarIcon: ({color}) => <TabIcon name="🕹" color={color} />}}
          />
          <Tab.Screen
            name="Community" component={CommunityScreen}
            options={{title: 'Community', tabBarIcon: ({color}) => <TabIcon name="👥" color={color} />}}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const sp = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center'},
  bgImage: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', opacity: 0.35},
  overlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)'},
  gridH1: {position:'absolute', width:'100%', height:1, backgroundColor:'#0a1a0a', top:'35%'},
  gridH2: {position:'absolute', width:'100%', height:1, backgroundColor:'#0a1a0a', top:'65%'},
  gridV1: {position:'absolute', height:'100%', width:1,  backgroundColor:'#0a1a0a', left:'30%'},
  gridV2: {position:'absolute', height:'100%', width:1,  backgroundColor:'#0a1a0a', left:'70%'},
  box: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: '#00ff88',
    paddingHorizontal: 28, paddingVertical: 18, backgroundColor: '#020d05',
  },
  bracket: {color: '#00ff88', fontSize: 52, fontFamily: 'monospace', fontWeight: '100', lineHeight: 60},
  mid:     {alignItems: 'center'},
  title:   {color: '#00ff88', fontSize: 44, fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: 8},
  ctl:     {color: '#004d22', fontSize: 13, fontFamily: 'monospace', letterSpacing: 12, marginTop: -6},
  dev:     {color: '#00ff4466', fontFamily: 'monospace', fontSize: 12, letterSpacing: 4, marginTop: 28, textTransform: 'uppercase'},
  scanLine:{position: 'absolute', bottom: 60, left: 0, right: 0, height: 1, backgroundColor: '#00ff8820'},
});

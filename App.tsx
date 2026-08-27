import React, {useEffect, useRef, useState} from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {Text, View, StyleSheet, Animated, Image} from 'react-native';

import AppsScreen        from './src/screens/AppsScreen';
import ExtractScreen     from './src/screens/ExtractScreen';
import FilesScreen       from './src/screens/FilesScreen';
import FileBrowserScreen from './src/screens/FileBrowserScreen';

const Stack = createNativeStackNavigator();

function SplashScreen({onDone}: {onDone: () => void}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale   = useRef(new Animated.Value(0.85)).current;
  const tagOp   = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, {toValue: 1, duration: 600, useNativeDriver: true}),
        Animated.spring(scale,   {toValue: 1, friction: 5,   useNativeDriver: true}),
      ]),
      Animated.delay(300),
      Animated.timing(tagOp, {toValue: 1, duration: 400, useNativeDriver: true}),
      Animated.delay(700),
    ]).start(onDone);
  }, [opacity, scale, tagOp, onDone]);

  return (
    <View style={sp.container}>
      <Image
        source={require('./android/app/src/main/res/drawable/apextracker.jpg')}
        style={sp.bgImage}
        resizeMode="cover"
      />
      <View style={sp.overlay} />
      <Animated.View style={[sp.box, {opacity, transform: [{scale}]}]}>
        <Text style={sp.bracket}>[</Text>
        <View style={sp.mid}>
          <Text style={sp.title}>IL2CPP</Text>
          <Text style={sp.ctl}>EXTRACTOR</Text>
        </View>
        <Text style={sp.bracket}>]</Text>
      </Animated.View>
      <Animated.Text style={[sp.dev, {opacity: tagOp}]}>
        Offline Unity Analysis
      </Animated.Text>
      <View style={sp.scanLine} />
    </View>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);

  if (!ready) return <SplashScreen onDone={() => setReady(true)} />;

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator
          screenOptions={{
            headerStyle: {backgroundColor: '#0d0d0d'},
            headerTintColor: '#00ff88',
            headerTitleStyle: {fontFamily: 'monospace', fontWeight: 'bold'},
            contentStyle: {backgroundColor: '#0d0d0d'},
          }}>
          <Stack.Screen
            name="Apps" component={AppsScreen}
            options={{title: 'IL2CPP Extractor', headerShown: true}}
          />
          <Stack.Screen
            name="Extract" component={ExtractScreen}
            options={({route}: any) => ({title: route.params?.appName ?? 'Extract'})}
          />
          <Stack.Screen
            name="Files" component={FilesScreen}
            options={({route}: any) => ({title: `${route.params?.appName ?? ''} — Files`})}
          />
          <Stack.Screen
            name="FileBrowser" component={FileBrowserScreen}
            options={({route}: any) => ({title: route.params?.title ?? 'Files', headerBackTitle: 'Back'})}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const sp = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center'},
  bgImage: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', opacity: 0.35},
  overlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)'},
  box: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: '#00ff88',
    paddingHorizontal: 28, paddingVertical: 18, backgroundColor: '#020d05',
  },
  bracket: {color: '#00ff88', fontSize: 52, fontFamily: 'monospace', fontWeight: '100', lineHeight: 60},
  mid:     {alignItems: 'center'},
  title:   {color: '#00ff88', fontSize: 36, fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: 8},
  ctl:     {color: '#004d22', fontSize: 12, fontFamily: 'monospace', letterSpacing: 10, marginTop: -4},
  dev:     {color: '#00ff4466', fontFamily: 'monospace', fontSize: 11, letterSpacing: 4, marginTop: 24, textTransform: 'uppercase'},
  scanLine:{position: 'absolute', bottom: 60, left: 0, right: 0, height: 1, backgroundColor: '#00ff8820'},
});

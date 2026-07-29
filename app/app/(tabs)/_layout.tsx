// Bottom tab bar for the four control surfaces. Icons are simple vector glyphs
// drawn with Views so there's no icon-font dependency to load on web.

import React from 'react';
import { View, Text } from 'react-native';
import { Tabs, Redirect } from 'expo-router';
import { useConnection } from '../../src/connection';
import { colors } from '../../src/theme';

function Glyph({ name, color }: { name: string; color: any }) {
  // Minimal geometric icons keyed by tab name.
  const base = { alignItems: 'center' as const, justifyContent: 'center' as const, width: 24, height: 24 };
  if (name === 'screen') {
    return (
      <View style={base}>
        <View style={{ width: 22, height: 15, borderRadius: 3, borderWidth: 2, borderColor: color }} />
        <View style={{ width: 8, height: 2, backgroundColor: color, marginTop: 2 }} />
      </View>
    );
  }
  if (name === 'terminal') {
    return (
      <View style={[base, { borderRadius: 4, borderWidth: 2, borderColor: color }]}>
        <Text style={{ color, fontSize: 11, fontWeight: '900', marginTop: -1 }}>{'>_'}</Text>
      </View>
    );
  }
  if (name === 'files') {
    return (
      <View style={base}>
        <View style={{ width: 20, height: 15, borderRadius: 3, borderWidth: 2, borderColor: color }} />
        <View style={{ position: 'absolute', top: 4, left: 2, width: 8, height: 3, backgroundColor: color, borderRadius: 1 }} />
      </View>
    );
  }
  // system
  return (
    <View style={[base, { flexDirection: 'row', alignItems: 'flex-end', gap: 2 }]}>
      <View style={{ width: 4, height: 8, backgroundColor: color, borderRadius: 1 }} />
      <View style={{ width: 4, height: 15, backgroundColor: color, borderRadius: 1 }} />
      <View style={{ width: 4, height: 11, backgroundColor: color, borderRadius: 1 }} />
    </View>
  );
}

export default function TabsLayout() {
  const { ready, connection } = useConnection();
  // Guard: never show the tabs without a connection.
  if (ready && !connection) return <Redirect href="/" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 62,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="screen"
        options={{ title: 'Screen', tabBarIcon: ({ color }) => <Glyph name="screen" color={color} /> }}
      />
      <Tabs.Screen
        name="terminal"
        options={{ title: 'Terminal', tabBarIcon: ({ color }) => <Glyph name="terminal" color={color} /> }}
      />
      <Tabs.Screen
        name="files"
        options={{ title: 'Files', tabBarIcon: ({ color }) => <Glyph name="files" color={color} /> }}
      />
      <Tabs.Screen
        name="system"
        options={{ title: 'System', tabBarIcon: ({ color }) => <Glyph name="system" color={color} /> }}
      />
    </Tabs>
  );
}

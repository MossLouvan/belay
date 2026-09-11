import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Txt } from '../ui';
import { ToolGlyph } from './tool-glyphs';
import { IconDeviceDesktop, IconRobot, IconTerminal2, IconFolder, IconSettings } from '@tabler/icons-react-native';

export function ComputerGlyph({ color }: { color: string }) {
  return <View accessible={false} style={{ width: 26, height: 26, alignItems: 'center' }}>
    <View style={{ width: 24, height: 17, borderWidth: 1.7, borderColor: color, borderRadius: 3 }} />
    <View style={{ width: 2, height: 4, backgroundColor: color }} />
    <View style={{ width: 12, height: 1.7, backgroundColor: color }} />
  </View>;
}

export function AppearanceNav({ selected = 'screen' }: { selected?: 'screen' | 'agent' | 'terminal' | 'files' | 'system' }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return <View testID="appearance-nav" style={{ flexDirection: 'row', paddingTop: 10, paddingBottom: Math.max(insets.bottom, 12), borderTopWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.bg }}>
    {(['screen', 'agent', 'terminal', 'files', 'system'] as const).map(id => {
      const color = selected === id ? theme.colors.accent : theme.colors.textDim;
      return <Pressable key={id} testID={`nav-${id}`} accessibilityRole="tab" accessibilityState={{ selected: selected === id }}
        accessibilityLabel={id[0].toUpperCase() + id.slice(1)} onPress={() => router.navigate(`/${id}`)}
        style={({ pressed }) => ({ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 5, opacity: pressed ? 0.6 : 1 })}>
        {React.createElement({ screen: IconDeviceDesktop, agent: IconRobot, terminal: IconTerminal2, files: IconFolder, system: IconSettings }[id], { color, size: 24, strokeWidth: 1.7 })}
        <Txt style={{ color, fontSize: 11, lineHeight: 15 }}>{id[0].toUpperCase() + id.slice(1)}</Txt>
      </Pressable>;
    })}
  </View>;
}

// The five-tab bar both concept mockups stand the app on.
//
// Screen / Agent / Terminal / Files / System, hairline-ruled off the page,
// the selected one in the accent. Real tabs for assistive tech: role="tab" with
// a selected state, a label on every one, and a 48pt row before the home
// indicator inset is added — never a bare icon strip.

import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  IconDeviceDesktop, IconFolder, IconRobot, IconSettings, IconTerminal2,
} from '@tabler/icons-react-native';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { Txt, tabSelected } from '../ui';
import { planTabPress } from './nav-plan';
import type { NavTab } from './nav-plan';

export type { NavTab } from './nav-plan';

const TABS: readonly NavTab[] = ['screen', 'agent', 'terminal', 'files', 'system'];

const GLYPHS = {
  screen: IconDeviceDesktop,
  agent: IconRobot,
  terminal: IconTerminal2,
  files: IconFolder,
  system: IconSettings,
} as const;

/** "screen" → "Screen". The tab id is the label, so the two cannot drift. */
export function tabLabel(tab: NavTab): string {
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

/**
 * A monitor drawn from Views, kept for callers that want the glyph without the
 * icon set's stroke weight.
 * @deprecated New code uses `IconDeviceDesktop` / `DeviceThumb`.
 */
export function ComputerGlyph({ color }: { color: string }) {
  return (
    <View accessible={false} style={{ width: 26, height: 26, alignItems: 'center' }}>
      <View style={{ width: 24, height: 17, borderWidth: 1.7, borderColor: color, borderRadius: 3 }} />
      <View style={{ width: 2, height: 4, backgroundColor: color }} />
      <View style={{ width: 12, height: 1.7, backgroundColor: color }} />
    </View>
  );
}

export interface AppearanceNavProps {
  /**
   * The tab this screen IS. Omit on a screen that is none of them (the
   * Computers list): nothing is lit and every tab navigates (#73).
   */
  readonly selected?: NavTab;
}

export function AppearanceNav({ selected }: AppearanceNavProps) {
  const theme = useTheme();
  const look = useLook();
  const insets = useSafeAreaInsets();

  return (
    <View
      testID="appearance-nav"
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 10),
        borderTopWidth: theme.layout.hairline,
        borderTopColor: theme.colors.border,
        // Current lifts the bar off the page with the card fill, the way the
        // mockup's white bar sits on its blue-grey ground; Fieldwork's bar is
        // the same near-black as the page and is separated by the rule alone.
        backgroundColor: look.cardBorder ? theme.colors.surface : theme.colors.bg,
      }}
    >
      {TABS.map((tab) => {
        const active = selected === tab;
        const color = active ? theme.colors.accent : theme.colors.textDim;
        const Glyph = GLYPHS[tab];
        return (
          <Pressable
            key={tab}
            testID={`nav-${tab}`}
            accessibilityRole="tab"
            {...tabSelected(active)}
            accessibilityLabel={tabLabel(tab)}
            onPress={() => {
              const plan = planTabPress(selected, tab);
              if (plan.kind === 'navigate') router.navigate(plan.href);
              else if (plan.kind === 'replace') router.replace(plan.href);
              else if (plan.kind === 'back') router.back();
            }}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              opacity: pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Glyph size={23} strokeWidth={active ? 2 : 1.7} color={color} />
            <Txt variant="tab" style={{ color }}>{tabLabel(tab)}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

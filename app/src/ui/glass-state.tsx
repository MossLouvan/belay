// GlassState — the one interior a machine panel shows when it has no picture
// and no transcript (REVAMP-SPEC §5.5, "faults live on the glass").
//
// Screen and Terminal both render this component, so every empty, waiting and
// fault state in the app shares the fixed §11.4 anatomy, centred on the glass:
//
//   STATE NAME     `label`, dim for waiting/empty, `bad` for faults
//   observed fact  one `body` line, sentence case, guesses labelled as guesses
//   one action     a compact solid-accent button — small, dense, singular
//   proof of life  a mono line (outage clock, "`>`" prompt hint) so a waiting
//                  panel never reads as a crashed one
//
// Behind it, the topo contours in `machineLine` (§6.6) — emptiness rendered
// as unclimbed terrain. Pure presentation: what to say is decided by callers
// (panel-state's `panelCopyFor`, terminal's own mapping); this file only
// guarantees they all say it the same way.
//
// Everything draws ON the true-dark machine surface in both themes, so inks
// come from the dark palette via `getTheme('dark')`, never `useTheme()` — the
// light palette is tuned for paper and fails WCAG AA on near-black.

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { getTheme, layout, motion, radius, space } from '../theme';
import { Contours } from './contours';
import { haptic } from './haptics';
import { Micro, Txt } from './text';

/**
 * The tone of the STATE NAME. `dim` = waiting/empty (Connecting, READY);
 * `bad` = fault (No signal, Screen recording off). There is no `good` — a
 * healthy panel shows content, not a state card.
 */
export type GlassStatus = 'dim' | 'bad';

/** The single verb a glass state may offer (§11.3: one verb per action). */
export interface GlassStateAction {
  readonly label: string;
  readonly onPress: () => void;
}

export interface GlassStateProps {
  status: GlassStatus;
  /** STATE NAME — rendered as an 11pt tracked label; keep it to a few words. */
  name: string;
  /** The observed fact. One or two sentences; never a sure-sounding guess. */
  body?: string;
  /** At most one action, or none — never a second button, never a link row. */
  action?: GlassStateAction;
  /** Static proof-of-life line ("Checked again every 15s", "> "). */
  proof?: string;
  /**
   * Live proof-of-life element (the ticking outage clock). Wins over `proof`;
   * the element itself stays with the caller so this component holds no
   * timers. Style it in `onMachineDim` mono, like `proof` would be.
   */
  proofSlot?: React.ReactNode;
  /** Set false to omit the topo garnish (e.g. inside a small diagnosis row). */
  contours?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The shared machine-panel interior. Fills its parent and centres the anatomy
 * — the one sanctioned centring (DESIGN.md §11.5). The panel it fills is dark
 * glass; this component draws no background of its own.
 */
export function GlassState({
  status,
  name,
  body,
  action,
  proof,
  proofSlot,
  contours = true,
  style,
  testID,
}: GlassStateProps) {
  const ink = getTheme('dark').colors;

  return (
    <View testID={testID} style={[styles.fill, style]}>
      {contours ? <Contours onGlass /> : null}
      <View style={styles.anatomy}>
        <Txt
          variant="label"
          color={status === 'bad' ? ink.bad : ink.onMachineDim}
          align="center"
        >
          {name}
        </Txt>
        {body ? (
          <Txt variant="body" color={ink.onMachine} align="center">
            {body}
          </Txt>
        ) : null}
        {action ? (
          <Pressable
            testID="glass-state-action"
            accessibilityRole="button"
            accessibilityLabel={action.label}
            // 36pt visual button inside the 44pt minimum target (§5.5).
            // Expand all sides equally to reach 44pt: (44-36)/2 = 4pt each.
            hitSlop={{
              top: (layout.minTouch - ACTION_HEIGHT) / 2,
              bottom: (layout.minTouch - ACTION_HEIGHT) / 2,
              left: (layout.minTouch - ACTION_HEIGHT) / 2,
              right: (layout.minTouch - ACTION_HEIGHT) / 2,
            }}
            onPress={() => {
              haptic('medium');
              action.onPress();
            }}
            style={({ pressed }) => ({
              height: ACTION_HEIGHT,
              alignSelf: 'center',
              paddingHorizontal: space.lg,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.xs,
              // Solid fills darken under load (§3.1 `accentPress`); the label
              // still dips via pressOpacity so text feedback stays uniform.
              backgroundColor: pressed ? ink.accentPress : ink.accent,
              marginTop: space.xxs,
            })}
          >
            {({ pressed }) => (
              <Txt
                variant="label"
                color={ink.onAccent}
                style={{ opacity: pressed ? motion.pressOpacity : 1 }}
              >
                {action.label}
              </Txt>
            )}
          </Pressable>
        ) : null}
        {proofSlot ??
          (proof ? (
            <Micro testID="glass-state-proof" style={{ color: ink.onMachineDim }}>
              {proof}
            </Micro>
          ) : null)}
      </View>
    </View>
  );
}

/** Compact action: 36pt visual in a 44pt target — not a giant slab (§5.5). */
const ACTION_HEIGHT = 36;

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  anatomy: {
    maxWidth: 360,
    alignItems: 'center',
    gap: space.sm,
  },
});

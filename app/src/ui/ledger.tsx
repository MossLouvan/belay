// The Ledger primitives — what replaced the card (docs/DESIGN.md §7).
//
// A "card" grouped content with a border box; these group it with a mono
// micro-label, alignment and a full-bleed hairline instead. Screens compose
// them directly on the page background: Section for any labelled group,
// LedgerRow for key-value data, MeterSection for live stats, MachinePanel for
// the terminal/video surfaces, Rule wherever a bare hairline is needed.

import React, { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { haptic } from './haptics';
import { Label, Micro, Txt } from './text';

/**
 * A structural rule. Exactly two weights exist (docs/DESIGN.md §6): the 1px
 * physical hairline in `border`, and the 2pt emphasis rule in ink. `bleed`
 * pulls the rule past the page padding so it runs edge-to-edge — rules are
 * full-bleed, content is not.
 */
export function Rule({
  emphasis,
  color,
  bleed = 0,
  style,
}: {
  emphasis?: boolean;
  /** Overrides the rule colour — e.g. `accentGraphic` for a selection rule. */
  color?: string;
  bleed?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          height: emphasis ? theme.layout.ruleEmphasis : theme.layout.hairline,
          backgroundColor: color ?? (emphasis ? theme.colors.text : theme.colors.border),
          marginHorizontal: -bleed,
        },
        style,
      ]}
    />
  );
}

export interface SectionProps {
  /** The mono micro-label marking the section: "CPU", "SESSIONS". */
  label?: string;
  /** Right-aligned element on the label line — e.g. a "+ NEW" label button. */
  trailing?: React.ReactNode;
  children: React.ReactNode;
  /** Draws the closing full-bleed hairline. Defaults to true. */
  rule?: boolean;
  /** How far the closing rule bleeds past the page padding. */
  bleed?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The section: label marker, content, full-bleed hairline. Label binds to its
 * content by proximity (xs gap); the rule separates this section from the
 * next, never the label from its own content.
 */
export function Section({ label, trailing, children, rule = true, bleed = 0, style, testID }: SectionProps) {
  const theme = useTheme();
  return (
    <View testID={testID} style={style}>
      {label || trailing ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: theme.space.xs,
          }}
        >
          {label ? <Label style={{ marginBottom: 0 }}>{label}</Label> : <View />}
          {trailing ?? null}
        </View>
      ) : null}
      {children}
      {rule ? <Rule bleed={bleed} style={{ marginTop: theme.space.sm }} /> : null}
    </View>
  );
}

export interface LedgerRowProps {
  /** The key, set as a mono micro-label: "UPTIME:", "OS:". */
  label: string;
  /** The value, flush right in the machine's mono voice. */
  value?: string;
  /** Custom trailing content when a plain mono string is not enough. */
  children?: React.ReactNode;
  /** Colour role for the value text. Defaults to full ink. */
  valueTone?: 'default' | 'dim' | 'accent' | 'good' | 'warn' | 'bad';
  onPress?: () => void;
  /** Draws the hairline under the row. Defaults to true. */
  rule?: boolean;
  bleed?: number;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A ledger row: label-left, value-right, the reference's
 * `LOCATION: ENGLAND … 14:54` footer generalised into the app's core
 * key-value pattern. 44pt minimum whether or not it is tappable, so mixed
 * lists never produce undersized targets.
 */
export function LedgerRow({
  label,
  value,
  children,
  valueTone = 'default',
  onPress,
  rule = true,
  bleed = 0,
  accessibilityHint,
  testID,
  style,
}: LedgerRowProps) {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    if (!onPress) return;
    haptic('light');
    onPress();
  }, [onPress]);

  const inner = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.sm,
        minHeight: theme.layout.minTouch,
      }}
    >
      <Label style={{ marginBottom: 0 }}>{label}</Label>
      {children ??
        (value !== undefined ? (
          <Txt variant="mono" tone={valueTone} numberOfLines={1} style={{ textAlign: 'right', flexShrink: 1 }}>
            {value}
          </Txt>
        ) : null)}
    </View>
  );

  const body = onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value !== undefined ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
      onPress={handlePress}
      style={({ pressed }) => ({ opacity: pressed ? theme.motion.pressOpacity : 1 })}
    >
      {inner}
    </Pressable>
  ) : (
    inner
  );

  return (
    <View testID={testID} style={style}>
      {body}
      {rule ? <Rule bleed={bleed} /> : null}
    </View>
  );
}

export interface MeterSectionProps {
  /** The stat's micro-label: "CPU", "MEMORY". */
  label: string;
  /** The hero reading as shown: "39%", "12.4 GB". */
  value: string;
  /** 0–100, drives the track fill and the auto status colour. */
  percent: number;
  /** Overrides the >85 bad / >65 warn / good auto-threshold. */
  status?: 'good' | 'warn' | 'bad';
  /** Mono detail line under the track: "APPLE M3 · 8 CORES". */
  detail?: string;
  /** Inline element on the numeral row's right — typically a sparkline. */
  spark?: React.ReactNode;
  rule?: boolean;
  bleed?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A live-stat section: label + big tabular numeral on one row, a 2pt
 * full-width track underneath, then a micro detail line, closed by the
 * hairline. The status colour lives in the numeral and the track fill only —
 * nowhere else — so a page of meters stays one voice.
 */
export function MeterSection({
  label,
  value,
  percent,
  status,
  detail,
  spark,
  rule = true,
  bleed = 0,
  testID,
  style,
}: MeterSectionProps) {
  const theme = useTheme();
  const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const level = status ?? (safe > 85 ? 'bad' : safe > 65 ? 'warn' : 'good');
  const fill = theme.colors[level];

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel={`${label}, ${value}`}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(safe) }}
      style={[{ gap: theme.space.xs }, style]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: theme.space.sm }}>
        <Label style={{ marginBottom: 0 }}>{label}</Label>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.space.sm }}>
          {spark ? <View accessibilityElementsHidden>{spark}</View> : null}
          <Txt variant="numeral" color={fill}>
            {value}
          </Txt>
        </View>
      </View>
      <View style={{ height: theme.layout.ruleEmphasis, backgroundColor: theme.colors.surfaceAlt }}>
        <View style={{ width: `${safe}%`, height: '100%', backgroundColor: fill }} />
      </View>
      {detail ? <Micro>{detail}</Micro> : null}
      {rule ? <Rule bleed={bleed} style={{ marginTop: theme.space.xxs }} /> : null}
    </View>
  );
}

export interface MachinePanelProps {
  children: React.ReactNode;
  /**
   * Horizontal distance to the screen edge; the panel bleeds past the page
   * padding by this much so it runs edge-to-edge. Pass the screen's padding.
   */
  bleed?: number;
  minHeight?: number;
  /** Centres content — the one sanctioned centring outside the connect brand. */
  centered?: boolean;
  /** Draws the separating hairlines above and below. Defaults to true. */
  rules?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The machine panel: the true-dark surface the video and terminal live on, in
 * BOTH themes — those are windows into the computer, not UI surfaces
 * (docs/DESIGN.md §3.4). Full-bleed, square corners, separated from the page
 * by single hairlines, never a border box. Content on it uses the
 * `onMachine`/`onMachineDim` tones.
 */
export function MachinePanel({ children, bleed = 0, minHeight, centered, rules = true, style, testID }: MachinePanelProps) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ marginHorizontal: -bleed }}>
      {rules ? <Rule /> : null}
      <View
        style={[
          {
            backgroundColor: theme.colors.machine,
            minHeight,
            ...(centered ? { alignItems: 'center' as const, justifyContent: 'center' as const } : null),
          },
          style,
        ]}
      >
        {children}
      </View>
      {rules ? <Rule /> : null}
    </View>
  );
}

// One saved computer, as drawn in both concept mockups.
//
// Anatomy shared by the two appearances: a picture of the machine, its name,
// a dot and one status word, a trailing chevron, and — only when the machine
// can actually be reached — a Connect button. What differs is where Connect
// goes: Current runs it full-width beneath the row, Fieldwork puts it in the
// card's right column beside the thumbnail. `look.connectInline` is that
// switch; everything else is one drawing.
//
// The row and the trailing controls are siblings, never nested Pressables:
// nesting is invalid HTML on web and double-fires on native.

import React from 'react';
import { Pressable, View } from 'react-native';
import { IconChevronRight } from '@tabler/icons-react-native';
import { Button, Micro, Row, Txt } from '../ui';
import { haptic } from '../ui/haptics';
import { useTheme } from '../theme';
import { useLook } from '../design/use-look';
import { connectLabel, deviceStatus } from './device-status';
import { DeviceThumb } from './device-thumb';
import type { FleetLine } from '../agent/fleet-line';
import type { SavedDevice } from './model';
import type { Reachability } from './reachability';

/** The status disc, matching StatusLine's. Radius is half of it — geometry. */
const DOT = 8;

export interface DeviceCardProps {
  readonly device: SavedDevice;
  readonly isActive: boolean;
  readonly connected: boolean;
  readonly state: Reachability | undefined;
  readonly disabled: boolean;
  /** Live agent readout for this computer; null renders nothing at all. */
  readonly agents: FleetLine | null;
  readonly onPick: () => void;
  /** Opens this computer's settings sheet — the chevron's job. */
  readonly onOpenDetails: () => void;
  readonly onOpenAgent: () => void;
}

export function DeviceCard({
  device, isActive, connected, state, disabled, agents, onPick, onOpenDetails, onOpenAgent,
}: DeviceCardProps) {
  const theme = useTheme();
  const look = useLook();
  const status = deviceStatus(state, connected);
  const dotColor = status.tone === 'good' ? theme.colors.good
    : status.tone === 'faint' ? theme.colors.textFaint : theme.colors.borderStrong;

  const connect = status.actionable ? (
    <Button
      testID={`connect-${device.id}`}
      label={connectLabel(connected)}
      fullWidth
      disabled={disabled}
      onPress={onPick}
    />
  ) : null;

  const identity = (
    <View style={{ flex: 1, gap: theme.space.xxs }}>
      <Txt variant="subheading" numberOfLines={1}>{device.label}</Txt>
      <Row gap="xs" align="center">
        <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: dotColor }} />
        <Txt variant="body" tone="dim" numberOfLines={1}>{status.word}</Txt>
      </Row>
    </View>
  );

  return (
    <View
      testID={`computer-card-${device.id}`}
      style={{
        backgroundColor: theme.colors.surface,
        borderRadius: look.cardRadius,
        borderWidth: look.cardBorder ? theme.layout.hairline : 0,
        borderColor: theme.colors.border,
        overflow: 'hidden',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, padding: theme.space.sm }}>
        <DeviceThumb device={device} dim={!status.actionable} />
        {/* The pick target and Connect are SIBLINGS, never nested: a button
            inside a button is invalid HTML on web and double-fires on native.
            Fieldwork stacks them in the card's right column, Current runs
            Connect full-width beneath the whole row. */}
        <View style={{ flex: 1, gap: theme.space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Pressable
              testID={`device-${device.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${device.label}, ${status.word}`}
              accessibilityHint={`Control ${device.label}`}
              accessibilityState={{ disabled, selected: isActive }}
              disabled={disabled}
              onPress={onPick}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: theme.layout.minTouch,
                justifyContent: 'center',
                opacity: disabled ? 0.45 : pressed ? theme.motion.pressOpacity : 1,
              })}
            >
              {identity}
            </Pressable>
            {/* The chevron both mockups draw is a real control, not decoration:
                it opens this computer's settings, which is where Forget lives.
                Keeping an un-pair one thumb-width from "open this computer"
                was how a paired machine got dropped by accident. */}
            <Pressable
              testID={`device-menu-${device.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${device.label} settings`}
              onPress={onOpenDetails}
              hitSlop={theme.layout.hitSlop}
              style={({ pressed }) => ({
                width: 32,
                minHeight: theme.layout.minTouch,
                alignItems: 'flex-end',
                justifyContent: 'center',
                opacity: pressed ? theme.motion.pressOpacity : 1,
              })}
            >
              <IconChevronRight size={20} strokeWidth={2} color={theme.colors.textFaint} />
            </Pressable>
          </View>
          {look.connectInline ? connect : null}
        </View>
      </View>
      {look.connectInline || !connect ? null : (
        <View style={{ paddingHorizontal: theme.space.sm, paddingBottom: theme.space.sm }}>{connect}</View>
      )}
      {/* What Claude is doing on this computer right now — its own row under
          the card, never inside the pick Pressable. Absent when there is
          nothing to say, so no row ever shows a placeholder count. */}
      {agents ? (
        <Pressable
          testID={`device-agents-${device.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Agent on ${device.label}: ${agents.text.toLowerCase()}`}
          accessibilityHint="Opens the Agent tab for this computer"
          onPress={() => { haptic('light'); onOpenAgent(); }}
          style={({ pressed }) => ({
            minHeight: theme.layout.minTouch,
            justifyContent: 'center',
            paddingHorizontal: theme.space.sm,
            borderTopWidth: theme.layout.hairline,
            borderTopColor: theme.colors.border,
            opacity: pressed ? theme.motion.pressOpacity : 1,
          })}
        >
          <Micro testID={`device-agents-line-${device.id}`} tone={agents.warn ? 'accent' : 'dim'} numberOfLines={1}>
            {agents.text}
          </Micro>
        </Pressable>
      ) : null}
    </View>
  );
}

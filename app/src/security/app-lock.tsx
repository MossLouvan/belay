// The app lock: a Harbour cover over every route until Face ID / Touch ID /
// the passcode says it is the owner, on open and on return after the lock
// timeout. Drawn over the navigator rather than instead of it, so unlocking
// lands exactly where the owner left off. Plus the settings rows.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, StyleSheet, Switch, View } from 'react-native';
import { useTheme } from '../theme';
import { Button, Caption, Heading, Label, ListItem, SegmentedControl } from '../ui';
import type { SegmentOption } from '../ui';
import { BelugaAvatar } from '../ui/beluga-avatar';
import { shouldLock } from './owner-gate';
import {
  LOCK_TIMEOUTS_MS, isLockEnabled, markLockNoticeShown, refreshAvailability, requireOwner,
  setLockEnabled, setLockTimeout, unlockOwner, useOwnerLock,
} from './owner';

const UNLOCK_REASON = 'Unlock Belay';

/** Covers the app while locked. Mounted once, from the root layout. */
export function AppLock() {
  const theme = useTheme();
  const { ready, available, enabled, timeoutMs, noticeShown } = useOwnerLock();
  const [locked, setLocked] = useState(Platform.OS !== 'web');
  // Null until the app first leaves: a cold start always locks.
  const backgroundedAt = useRef<number | null>(null);
  const timeout = useRef(timeoutMs);
  timeout.current = timeoutMs;

  const tryUnlock = useCallback(async () => {
    if (!isLockEnabled() || await unlockOwner(UNLOCK_REASON)) setLocked(false);
  }, []);

  // Cold start: prompt once the prefs are read (or drop the cover if off).
  useEffect(() => {
    if (ready && locked) void tryUnlock();
    // Once, on ready.
  }, [ready]);

  // One gentle notice, ever, when there is nothing to lock with.
  useEffect(() => {
    if (!ready || available || noticeShown || Platform.OS === 'web') return;
    markLockNoticeShown();
    Alert.alert(
      'Belay is not locked',
      'Set up Face ID or a passcode on this phone, and Belay will ask for it before anyone can control your computer.',
    );
  }, [ready, available, noticeShown]);

  // Only `background` counts as away: the Face ID sheet itself flips the app
  // to `inactive`, and treating that as leaving would prompt forever.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') { backgroundedAt.current = Date.now(); return; }
      if (next !== 'active' || backgroundedAt.current === null) return;
      const away = backgroundedAt.current;
      backgroundedAt.current = null;
      void refreshAvailability().then(() => {
        if (!isLockEnabled()) { setLocked(false); return; }
        if (shouldLock(away, Date.now(), timeout.current)) {
          setLocked(true);
          void tryUnlock();
        }
      });
    });
    return () => sub.remove();
  }, [tryUnlock]);

  if (!locked || (ready && !(available && enabled))) return null;
  return (
    <View
      testID="app-lock"
      accessibilityViewIsModal
      style={[StyleSheet.absoluteFill, {
        backgroundColor: theme.colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.md,
        padding: theme.layout.margin,
      }]}
    >
      <BelugaAvatar size={40} />
      <Heading>Unlock Belay</Heading>
      <Caption style={{ textAlign: 'center' }}>So only you can control your computer from this phone.</Caption>
      {ready ? <Button testID="app-unlock" label="Unlock" onPress={() => void tryUnlock()} /> : null}
    </View>
  );
}

const TIMEOUT_OPTIONS: readonly SegmentOption<string>[] = LOCK_TIMEOUTS_MS.map((ms) => ({
  value: String(ms),
  label: ms === 0 ? 'Now' : `${ms / 60_000} min`,
}));

/** "Require Face ID" and the lock timeout, for the settings surfaces. */
export function LockSettings() {
  const theme = useTheme();
  const { available, enabled, timeoutMs } = useOwnerLock();
  if (Platform.OS === 'web') return null;
  if (!available) {
    return <Caption>Set up Face ID or a passcode on this phone to lock Belay.</Caption>;
  }
  // Turning the gate off is itself a sensitive action.
  const onToggle = async (on: boolean) => {
    if (on || await requireOwner('Turn off Face ID for Belay')) setLockEnabled(on);
  };
  return (
    <View style={{ gap: theme.space.xs }}>
      <ListItem
        title="Require Face ID"
        subtitle="To open Belay and to allow actions on your computer"
        testID="owner-lock-row"
        trailing={
          <Switch
            value={enabled}
            onValueChange={(on) => { void onToggle(on); }}
            trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
            accessibilityLabel="Require Face ID"
          />
        }
      />
      {enabled ? (
        <>
          <Label>Lock after</Label>
          <SegmentedControl
            options={TIMEOUT_OPTIONS}
            value={String(timeoutMs)}
            onChange={(v) => setLockTimeout(Number(v))}
            accessibilityLabel="Lock after"
            testID="owner-lock-timeout"
          />
        </>
      ) : null}
    </View>
  );
}

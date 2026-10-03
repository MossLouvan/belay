// "Is this the owner?" — Face ID / Touch ID / the device passcode, wired to
// the pure gate in ./owner-gate. One `requireOwner(reason)` for every
// sensitive action, so a stolen unlocked phone still cannot drive the
// computer. Web has no prompt and passes straight through; Android uses
// BiometricPrompt through the same Expo API.

import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { createOwnerGate } from './owner-gate';

const PREFS_KEY = 'belay.ownerLock';
const MIN = 60_000;
/** Locks after 5 minutes away: short enough to beat a grab-and-run, long
 *  enough that hopping to Messages and back never asks. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5 * MIN;
export const LOCK_TIMEOUTS_MS = [0, 1 * MIN, 5 * MIN, 15 * MIN] as const;

export interface OwnerLockState {
  /** Prefs and the device's enrollment have been read. */
  readonly ready: boolean;
  /** The device has Face ID / Touch ID or a passcode set (never on web). */
  readonly available: boolean;
  /** The owner's choice; defaults to on when `available`. */
  readonly enabled: boolean;
  readonly timeoutMs: number;
  /** The one-time "nothing enrolled" notice has been shown. */
  readonly noticeShown: boolean;
}

let state: OwnerLockState = {
  ready: Platform.OS === 'web', available: false, enabled: true, timeoutMs: DEFAULT_LOCK_TIMEOUT_MS, noticeShown: false,
};
const listeners = new Set<() => void>();

function setState(patch: Partial<OwnerLockState>, persist = false): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  if (persist) {
    const { enabled, timeoutMs, noticeShown } = state;
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify({ enabled, timeoutMs, noticeShown }))
      .catch((e: unknown) => console.warn('[owner-lock] could not save prefs', e));
  }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getState = () => state;
export const useOwnerLock = (): OwnerLockState => useSyncExternalStore(subscribe, getState, getState);

/** The gate is armed: the owner wants it and the device can prompt. */
export const isLockEnabled = (): boolean => state.available && state.enabled;

/** Re-reads enrollment (it can change in iOS Settings while we are away). */
export async function refreshAvailability(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    setState({ available: level !== LocalAuthentication.SecurityLevel.NONE });
  } catch (e: unknown) {
    console.warn('[owner-lock] enrollment check failed', e);
  }
}

/** Reads saved prefs and enrollment once, from the root layout. Never throws. */
export async function restoreOwnerLock(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object') {
      const p = saved as Record<string, unknown>;
      setState({
        ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
        ...((LOCK_TIMEOUTS_MS as readonly unknown[]).includes(p.timeoutMs) ? { timeoutMs: p.timeoutMs as number } : {}),
        ...(p.noticeShown === true ? { noticeShown: true } : {}),
      });
    }
  } catch (e: unknown) {
    console.warn('[owner-lock] could not read prefs', e);
  }
  await refreshAvailability();
  setState({ ready: true });
}

export const setLockEnabled = (enabled: boolean) => setState({ enabled }, true);
export const setLockTimeout = (timeoutMs: number) => setState({ timeoutMs }, true);
export const markLockNoticeShown = () => setState({ noticeShown: true }, true);

async function authenticate(reason: string): Promise<boolean> {
  const res = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel' });
  if (res.success) return true;
  // Face ID and the passcode were both removed while we were away: there is
  // nothing left to check, and taking either off needed the passcode anyway.
  if (res.error === 'passcode_not_set' || res.error === 'not_enrolled') {
    await refreshAvailability();
    return !state.available;
  }
  return false;
}

const gate = createOwnerGate({ authenticate, now: Date.now, isEnabled: isLockEnabled });

/**
 * The one check before a sensitive action. True when the owner is verified —
 * the gate is off, a check passed in the last ~60 s, or a new one just did.
 */
export const requireOwner = gate.requireOwner;
/** Always prompts; for the lock screen. */
export const unlockOwner = gate.unlock;

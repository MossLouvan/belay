// The Local Network permission, as the app uses it: ask early (with a line of
// explanation first), and after a LAN failure ask whether the permission is
// why. The reading lives in BelayPinModule (LocalNetworkCheck.swift); the
// decision is in local-network.ts. Android and web have no such permission,
// and a binary built before these functions existed answers 'unknown'.

import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { Diagnosis } from './diagnose';
import type { LocalNetworkStatus } from './local-network';
import { LOCAL_NETWORK_MESSAGE, LOCAL_NETWORK_TITLE, isLanUrl, isLocalNetworkBlocked } from './local-network';

interface LocalNetworkNative {
  localNetworkStatus?: () => Promise<string>;
  triggerLocalNetworkPrompt?: () => Promise<string>;
}

const native: LocalNetworkNative | null =
  Platform.OS === 'ios' ? requireOptionalNativeModule<LocalNetworkNative>('BelayPin') : null;

const PRIMED_KEY = 'belay.localNetworkPrimed';

const asStatus = (raw: string): LocalNetworkStatus => (raw === 'granted' || raw === 'denied' ? raw : 'unknown');

export async function localNetworkStatus(): Promise<LocalNetworkStatus> {
  if (!native?.localNetworkStatus) return 'unknown';
  try {
    return asStatus(await native.localNetworkStatus());
  } catch (e: unknown) {
    console.warn('localNetworkStatus failed', e);
    return 'unknown';
  }
}

export async function triggerLocalNetworkPrompt(): Promise<LocalNetworkStatus> {
  if (!native?.triggerLocalNetworkPrompt) return 'unknown';
  try {
    return asStatus(await native.triggerLocalNetworkPrompt());
  } catch (e: unknown) {
    console.warn('triggerLocalNetworkPrompt failed', e);
    return 'unknown';
  }
}

/** The banner's copy; `localNetwork` tells the renderer to offer Open Settings. */
export const LOCAL_NETWORK_DIAGNOSIS: Diagnosis = {
  title: LOCAL_NETWORK_TITLE,
  message: LOCAL_NETWORK_MESSAGE,
  localNetwork: true,
};

/**
 * After a failure reaching `urls`: the Local Network diagnosis when the
 * permission is what blocked it, else null (keep the ordinary one). Only asks
 * the native side when a LAN address on iOS is involved.
 */
export async function localNetworkDiagnosis(urls: readonly string[], error?: string): Promise<Diagnosis | null> {
  const base = { platform: Platform.OS, urls, error };
  if (!native || !urls.some(isLanUrl)) return null;
  if (isLocalNetworkBlocked(base)) return LOCAL_NETWORK_DIAGNOSIS;
  return isLocalNetworkBlocked({ ...base, status: await localNetworkStatus() }) ? LOCAL_NETWORK_DIAGNOSIS : null;
}

/**
 * Right before the first LAN attempt on this install: one line saying why,
 * then the system prompt, waiting for the answer so the attempt that follows
 * is not the one the prompt swallows. Once per install; iOS asks only once.
 */
export async function primeLocalNetwork(urls: readonly string[]): Promise<void> {
  if (!native?.triggerLocalNetworkPrompt || !urls.some(isLanUrl)) return;
  try {
    if (await AsyncStorage.getItem(PRIMED_KEY)) return;
    await AsyncStorage.setItem(PRIMED_KEY, '1');
  } catch (e: unknown) {
    console.warn('local network prime flag unavailable', e);
    return;
  }
  await new Promise<void>((resolve) => {
    Alert.alert(
      'Find your computer on Wi-Fi',
      'Next, iPhone asks to let Belay find devices on your local network. Tap Allow so Belay can reach your computer directly.',
      [{ text: 'Continue', onPress: () => resolve() }],
      { cancelable: false },
    );
  });
  await triggerLocalNetworkPrompt();
}

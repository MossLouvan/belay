// "My Computers" — pick which machine to control.
//
// This is the screen the whole multi-computer model exists for: open the app,
// see the Mac and the Windows PC, tap one, and it connects. No addresses, no
// pairing codes, no walking to the machine.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Screen, Card, Column, Row, Heading, Caption, Txt, Button, ListItem, Dot,
  Banner, EmptyState, Sheet, haptic,
} from '../src/ui';
import { useTheme } from '../src/theme';
import { useConnection } from '../src/connection';
import { SavedDevice, isReachableFromAnywhere } from '../src/devices/model';
import { useReachability, Reachability } from '../src/devices/reachability';

/** How a platform is described in the list. */
function platformLabel(device: SavedDevice): string {
  if (device.platform === 'darwin') return 'Mac';
  if (device.platform === 'win32') return 'Windows';
  return 'Computer';
}

function statusFor(state: Reachability | undefined): 'good' | 'bad' | 'neutral' {
  if (state === 'online') return 'good';
  if (state === 'offline') return 'bad';
  return 'neutral';
}

function statusText(state: Reachability | undefined, isActive: boolean): string {
  if (state === 'checking' || state === undefined) return 'Checking…';
  if (state === 'offline') return 'Asleep or off';
  return isActive ? 'Connected' : 'Ready';
}

export default function Devices() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { devices, active, switchTo, forget, phase, activeUrl } = useConnection();
  const { byId, refresh } = useReachability(devices);

  const [pendingForget, setPendingForget] = useState<SavedDevice | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const onPick = useCallback(async (device: SavedDevice) => {
    haptic('light');
    setSwitching(device.id);
    try {
      await switchTo(device.id);
      router.replace('/(tabs)/screen');
    } finally {
      setSwitching(null);
    }
  }, [switchTo]);

  const onConfirmForget = useCallback(async () => {
    if (!pendingForget) return;
    const id = pendingForget.id;
    setPendingForget(null);
    await forget(id);
  }, [pendingForget, forget]);

  if (devices.length === 0) {
    return (
      <Screen>
        <Column gap="lg" style={{ paddingTop: insets.top + theme.space.lg }}>
          <Heading>My computers</Heading>
          <EmptyState
            title="No computers yet"
            message="Run the Tether host agent on your Mac or Windows PC, then add it here."
            action={{ label: 'Add a computer', onPress: () => router.push('/') }}
          />
        </Column>
      </Screen>
    );
  }

  // Only ever shown when at least one computer cannot survive an address
  // change: LAN addresses are an optimization, not somewhere you can come back
  // to from outside the house.
  const lanOnly = devices.filter((d) => !isReachableFromAnywhere(d));

  return (
    <Screen scroll>
      <Column gap="lg" style={{ paddingTop: insets.top + theme.space.lg }}>
        <Column gap="xs">
          <Heading>My computers</Heading>
          <Caption>Tap one to take control.</Caption>
        </Column>

        {phase === 'unreachable' && active ? (
          <Banner
            status="bad"
            title={`Could not reach ${active.label}`}
            message="It may be asleep, powered off, or on a network this phone cannot see."
            action={{ label: 'Try again', onPress: refresh }}
          />
        ) : null}

        <Card>
          <Column gap="xs">
            {devices.map((device) => {
              const isActive = active?.id === device.id;
              const state = byId[device.id];
              return (
                <ListItem
                  key={device.id}
                  testID={`device-${device.id}`}
                  title={device.label}
                  subtitle={`${platformLabel(device)} · ${statusText(state, isActive && phase === 'connected')}`}
                  selected={isActive}
                  disabled={switching !== null}
                  leading={<Dot status={statusFor(state)} />}
                  accessibilityHint={`Control ${device.label}`}
                  onPress={() => void onPick(device)}
                  trailing={
                    <Button
                      variant="ghost"
                      size="sm"
                      label="Forget"
                      accessibilityLabel={`Forget ${device.label}`}
                      onPress={() => setPendingForget(device)}
                    />
                  }
                />
              );
            })}
          </Column>
        </Card>

        {isActiveConnected(phase) && activeUrl ? (
          <Caption style={{ textAlign: 'center' }}>
            Connected over {describeUrl(activeUrl)}
          </Caption>
        ) : null}

        {lanOnly.length > 0 ? (
          <Banner
            status="warn"
            title={lanOnly.length === 1
              ? `${lanOnly[0].label} only works on your home network`
              : 'Some computers only work on your home network'}
            message={
              'Their addresses change, and this phone cannot ask for the new one from ' +
              'outside. Install Tailscale on both to reach them from anywhere.'
            }
          />
        ) : null}

        <Row gap="sm">
          <View style={{ flex: 1 }}>
            <Button label="Add a computer" variant="secondary" fullWidth onPress={() => router.push('/')} />
          </View>
          <Button label="Refresh" variant="ghost" onPress={refresh} />
        </Row>

        <View style={{ height: insets.bottom + theme.space.lg }} />
      </Column>

      <Sheet
        visible={pendingForget !== null}
        onClose={() => setPendingForget(null)}
        title={pendingForget ? `Forget ${pendingForget.label}?` : 'Forget this computer?'}
      >
        <Column gap="md">
          <Txt>
            This phone will be un-paired from it. Your other computers are not affected,
            and you can add it again with a new pairing code.
          </Txt>
          <Row gap="sm">
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="secondary" fullWidth onPress={() => setPendingForget(null)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Forget" variant="danger" fullWidth onPress={() => void onConfirmForget()} />
            </View>
          </Row>
        </Column>
      </Sheet>
    </Screen>
  );
}

function isActiveConnected(phase: string): boolean {
  return phase === 'connected';
}

/** Human description of which path is in use, without showing a raw URL. */
function describeUrl(url: string): string {
  const host = url.replace(/^https?:\/\//, '').split(':')[0];
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'Tailscale';
  if (host.endsWith('.ts.net')) return 'Tailscale';
  return 'your local network';
}

// "My Computers" — pick which machine to control.
//
// This is the screen the whole multi-computer model exists for: open the app,
// see the Mac and the Windows PC, tap one, and it connects. No addresses, no
// pairing codes, no walking to the machine.
//
// Ledger anatomy: title, a mono status line, the header rule, then the
// machines as hairline-separated rows — every row tappable, reachability
// carried by the dot and the mono status word, no card around any of it.

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import {
  Screen, Row, Heading, Label, Caption, Txt, Button, IconButton, ListItem, Dot,
  Banner, EmptyState, LedgerRow, Rule, Sheet, haptic,
} from '../src/ui';
import { useTheme } from '../src/theme';
import { useConnection } from '../src/connection';
import { isReachableFromAnywhere } from '../src/devices/model';
import type { SavedDevice } from '../src/devices/model';
import { useReachability } from '../src/devices/reachability';
import type { Reachability } from '../src/devices/reachability';
import { DiscoveredSection } from '../src/devices/discovered-section';

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
  const { devices, active, addDevice, switchTo, forget, phase, activeUrl } = useConnection();
  const { byId, refresh } = useReachability(devices);

  const [pendingForget, setPendingForget] = useState<SavedDevice | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  /** Bumped by Refresh so the tailnet look-around re-runs with the probes. */
  const [discoveryNonce, setDiscoveryNonce] = useState(0);

  const refreshAll = useCallback(() => {
    refresh();
    setDiscoveryNonce((n) => n + 1);
  }, [refresh]);

  /**
   * Save a discovered computer and land on its screen — the identical
   * outcome the typed and scanned pairing flows produce, so one tap here is
   * the same as a full pairing there.
   */
  const onDiscoveredAdd = useCallback(async (device: SavedDevice) => {
    await addDevice(device);
    router.replace('/(tabs)/screen');
  }, [addDevice]);

  const onPick = useCallback(async (device: SavedDevice) => {
    haptic('light');
    // Re-picking the computer you are already connected to is "never mind":
    // return to the tab that linked here instead of re-racing its addresses
    // and dumping the user on Screen. Anything else — another machine, or the
    // active one while unreachable — is a real (re)connect.
    if (device.id === active?.id && phase === 'connected' && router.canGoBack()) {
      router.back();
      return;
    }
    setSwitching(device.id);
    try {
      await switchTo(device.id);
      router.replace('/(tabs)/screen');
    } finally {
      setSwitching(null);
    }
  }, [switchTo, active, phase]);

  const onConfirmForget = useCallback(async () => {
    if (!pendingForget) return;
    const id = pendingForget.id;
    setPendingForget(null);
    await forget(id);
  }, [pendingForget, forget]);

  const margin = theme.layout.margin;

  if (devices.length === 0) {
    return (
      <Screen padding="page">
        <View style={{ paddingTop: theme.space.md }}>
          <Row justify="space-between" align="flex-end" gap="sm">
            <Heading>My computers</Heading>
            {router.canGoBack() ? (
              <IconButton
                accessibilityLabel="Back"
                variant="plain"
                onPress={() => router.back()}
              >
                <Txt variant="title" tone="dim">{'‹'}</Txt>
              </IconButton>
            ) : null}
          </Row>
          <Rule bleed={margin} style={{ marginTop: theme.space.md }} />
          <EmptyState
            title="No computers yet"
            message="Run the Belay host agent on your Mac or Windows PC, then add it here."
            action={{ label: 'Add a computer', onPress: () => router.push({ pathname: '/', params: { add: '1' } }) }}
          />
        </View>
      </Screen>
    );
  }

  // Only ever shown when at least one computer cannot survive an address
  // change: LAN addresses are an optimization, not somewhere you can come back
  // to from outside the house.
  const lanOnly = devices.filter((d) => !isReachableFromAnywhere(d));

  return (
    <Screen scroll padding="page">
      <View style={{ paddingTop: theme.space.md, gap: theme.space.lg }}>
        <View>
          <Row justify="space-between" align="flex-end" gap="sm">
            <Heading>My computers</Heading>
            {/* Now that every tab header links here, arriving by push is the
                normal case — and the swipe-back gesture needs its visible
                twin (docs/DESIGN.md §11.2). ‹ alone is sanctioned in this
                corner (§11.1). */}
            {router.canGoBack() ? (
              <IconButton
                testID="devices-back"
                accessibilityLabel="Back"
                variant="plain"
                onPress={() => router.back()}
              >
                <Txt variant="title" tone="dim">{'‹'}</Txt>
              </IconButton>
            ) : null}
          </Row>
          <Label style={{ marginTop: theme.space.xxs, marginBottom: 0 }}>
            {`${devices.length} paired · tap one to take control`}
          </Label>
          <Rule bleed={margin} style={{ marginTop: theme.space.md }} />
        </View>

        {phase === 'unreachable' && active ? (
          <Banner
            status="bad"
            title={`Could not reach ${active.label}`}
            message="It may be asleep, powered off, or on a network this phone cannot see."
            action={{ label: 'Try again', onPress: refresh }}
          />
        ) : null}

        <View>
          {devices.map((device) => {
            const isActive = active?.id === device.id;
            const state = byId[device.id];
            return (
              <View key={device.id}>
                <ListItem
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
                <Rule bleed={margin} />
              </View>
            );
          })}
        </View>

        {isActiveConnected(phase) && activeUrl ? (
          <LedgerRow label="Connected over" value={describeUrl(activeUrl)} valueTone="dim" rule={false} />
        ) : null}

        {/* The connected computer can see the rest of the tailnet, so adding
            the other machine becomes one tap instead of typing an address. */}
        <DiscoveredSection
          saved={devices}
          connected={isActiveConnected(phase)}
          viaLabel={active?.label ?? 'your computer'}
          nonce={discoveryNonce}
          onAdd={onDiscoveredAdd}
        />

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
            <Button label="Add a computer" variant="secondary" fullWidth onPress={() => router.push({ pathname: '/', params: { add: '1' } })} />
          </View>
          <Button label="Refresh" variant="ghost" onPress={refreshAll} />
        </Row>

        <Caption>
          Forgetting a computer un-pairs this phone from it; the host keeps running.
        </Caption>
      </View>

      <Sheet
        visible={pendingForget !== null}
        onClose={() => setPendingForget(null)}
        title={pendingForget ? `Forget ${pendingForget.label}?` : 'Forget this computer?'}
      >
        <View style={{ gap: theme.space.md }}>
          <Txt>
            This phone will be un-paired from it. Your other computers are not affected,
            and you can add it again with a new pairing code.
          </Txt>
          <Row gap="sm">
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="secondary" fullWidth onPress={() => setPendingForget(null)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Forget this computer" variant="danger" fullWidth onPress={() => void onConfirmForget()} />
            </View>
          </Row>
        </View>
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

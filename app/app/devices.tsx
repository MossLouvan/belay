// "My Computers" — pick which machine to control.
//
// This is the screen the whole multi-computer model exists for: open the app,
// see the Mac and the Windows PC, tap one, and it connects. No addresses, no
// pairing codes, no walking to the machine.
//
// Sweep anatomy (Next Terminal): title, a mono status line, the header rule,
// then each machine as its own clean bordered Card row — name, one dim status
// line, a small status dot, a tracked FORGET. The active computer carries the
// soft accent fill, the reference's sidebar-active treatment. Advisories are
// subtle bordered cards with a 2pt status edge, never saturated fills.

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';

import {
  Screen, Row, Heading, Label, Caption, Txt, Button, IconButton, Card,
  EmptyState, LedgerRow, Rule, Sheet, TrackLabel, haptic, StatusBadge,
} from '../src/ui';
import { StatusNotice } from '../src/devices/notice';
import { useTheme } from '../src/theme';
import { useConnection } from '../src/connection';
import { isReachableFromAnywhere } from '../src/devices/model';
import type { SavedDevice } from '../src/devices/model';
import { useReachability } from '../src/devices/reachability';
import type { Reachability } from '../src/devices/reachability';
import { useAutoReconnect } from '../src/devices/use-auto-reconnect';
import { DiscoveredSection } from '../src/devices/discovered-section';

/** How a platform is described in the list. */
function platformLabel(device: SavedDevice): string {
  if (device.platform === 'darwin') return 'Mac';
  if (device.platform === 'win32') return 'Windows';
  return 'Computer';
}

function statusLabel(state: Reachability | undefined): string | null {
  if (state === 'online') return 'Online';
  if (state === 'offline') return 'Offline';
  return null; // checking state
}

function statusText(state: Reachability | undefined, isActive: boolean): string {
  if (state === 'checking' || state === undefined) return 'Checking…';
  if (state === 'offline') return 'Asleep or off';
  return isActive ? 'Connected' : 'Ready';
}

/**
 * One saved computer as a clean bordered card row: status dot, name, one dim
 * status line, a tracked FORGET. The active computer's card takes the soft
 * accent fill — the reference's sidebar-active treatment — and nothing else
 * on the row carries colour beyond the small dot.
 */
function DeviceCard({
  device,
  isActive,
  connected,
  state,
  disabled,
  onPick,
  onForget,
}: {
  device: SavedDevice;
  isActive: boolean;
  connected: boolean;
  state: Reachability | undefined;
  disabled: boolean;
  onPick: () => void;
  onForget: () => void;
}) {
  const theme = useTheme();
  const subtitle = `${platformLabel(device)} · ${statusText(state, connected)}`;

  return (
    <Card
      flush
      style={{
        overflow: 'hidden',
        backgroundColor: isActive ? theme.colors.accentSoft : theme.colors.surface,
      }}
    >
      {/* Pressable row + trailing control as siblings: nesting the FORGET
          button inside the row's Pressable is invalid HTML on web and double
          fires on native (same split ListItem uses). */}
      <Row gap="sm" style={{ paddingLeft: theme.space.md, paddingRight: theme.space.md }}>
        <Pressable
          testID={`device-${device.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${device.label}, ${subtitle}`}
          accessibilityHint={`Control ${device.label}`}
          accessibilityState={{ disabled, selected: isActive }}
          disabled={disabled}
          onPress={onPick}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: theme.layout.rowHeight,
            justifyContent: 'center',
            paddingVertical: theme.space.sm,
            opacity: disabled ? 0.45 : pressed ? theme.motion.pressOpacity : 1,
          })}
        >
          <View style={{ flex: 1, gap: 4 }}>
            <Row gap="xs" align="center">
              <Txt variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>{device.label}</Txt>
              {statusLabel(state) ? <StatusBadge label={statusLabel(state)!} variant="quiet" /> : null}
            </Row>
            <Txt variant="caption" tone="dim" numberOfLines={1}>{subtitle}</Txt>
          </View>
        </Pressable>
        <TrackLabel
          label="Forget"
          accessibilityLabel={`Forget ${device.label}`}
          onPress={onForget}
        />
      </Row>
    </Card>
  );
}

export default function Devices() {
  const theme = useTheme();
  const { devices, active, addDevice, switchTo, forget, reconnect, phase, activeUrl } = useConnection();
  const { byId, refresh } = useReachability(devices);

  const [pendingForget, setPendingForget] = useState<SavedDevice | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  /** Bumped by Refresh so the tailnet look-around re-runs with the probes. */
  const [discoveryNonce, setDiscoveryNonce] = useState(0);
  /** True once the user asks Belay to keep re-attempting a dead connection. */
  const [keepTrying, setKeepTrying] = useState(false);
  const reconnectAttempts = useAutoReconnect(keepTrying, phase, reconnect);

  // Stand down the moment the machine answers, and whenever the active computer
  // changes out from under the loop — the old target's retries mean nothing to
  // a computer you just switched to.
  useEffect(() => {
    if (phase === 'connected') setKeepTrying(false);
  }, [phase]);
  useEffect(() => {
    setKeepTrying(false);
  }, [active?.id]);

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

        {active && (phase === 'unreachable' || (keepTrying && phase === 'connecting')) ? (
          keepTrying ? (
            <StatusNotice
              testID="reconnect-banner"
              status="warn"
              title={`Reconnecting to ${active.label}…`}
              message={
                `Belay keeps trying and will connect the moment it wakes${
                  reconnectAttempts > 0 ? ` · attempt ${reconnectAttempts}` : ''
                }.`
              }
              action={{ label: 'Stop', onPress: () => setKeepTrying(false) }}
            />
          ) : (
            <StatusNotice
              testID="unreachable-banner"
              status="bad"
              title={`Could not reach ${active.label}`}
              message="It may be asleep, powered off, or on a network this phone cannot see. Belay can keep trying and connect the moment it wakes."
              action={{ label: 'Keep trying', onPress: () => { haptic('light'); setKeepTrying(true); } }}
            />
          )
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              isActive={active?.id === device.id}
              connected={active?.id === device.id && phase === 'connected'}
              state={byId[device.id]}
              disabled={switching !== null}
              onPick={() => void onPick(device)}
              onForget={() => setPendingForget(device)}
            />
          ))}
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
          <StatusNotice
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

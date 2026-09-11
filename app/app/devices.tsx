// "Your computers" — pick which machine to control.
//
// This is the screen the whole multi-computer model exists for: open the app,
// see the Mac and the Windows PC, tap one, and it connects. No addresses, no
// pairing codes, no walking to the machine.
//
// Drawn from the two concept mockups in output/design-concepts-2026-09-11/:
// masthead, page title, a short stack of computer cards, the Add computer row,
// and the five-tab bar. Everything that used to live on the page between those
// — the tailnet look-around, the "connected over" readout, Refresh, the
// forget-explains-itself caption — moved into the two sheets this screen owns.
// They are all still one tap away; none of them is the first thing you see.

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { Screen, Caption, Txt, Button, Row, Sheet, haptic } from '../src/ui';
import { useAgentAttention } from '../src/agent/attention-store';
import { fleetLine } from '../src/agent/fleet-line';
import { StatusNotice } from '../src/devices/notice';
import { useTheme } from '../src/theme';
import { useLook } from '../src/design/use-look';
import { useConnection } from '../src/connection';
import { isReachableFromAnywhere } from '../src/devices/model';
import type { SavedDevice } from '../src/devices/model';
import { useReachability } from '../src/devices/reachability';
import { useAutoReconnect } from '../src/devices/use-auto-reconnect';
import { DiscoveredSection } from '../src/devices/discovered-section';
import { AddComputer } from '../src/devices/add-computer';
import { AddComputerRow } from '../src/devices/add-computer-row';
import { DeviceCard } from '../src/devices/device-card';
import { DevicesHeader } from '../src/devices/devices-header';
import { EmptyComputers } from '../src/devices/empty-computers';
import { ThemeToggle } from '../src/settings/theme-toggle';
import { AppearanceNav } from '../src/home/appearance-nav';

export default function Devices() {
  const theme = useTheme();
  const look = useLook();
  const { devices, active, addDevice, switchTo, forget, reconnect, phase, activeUrl } = useConnection();
  // The attention store is host-scoped (reset on switch), so its counts
  // describe exactly one computer: the connected one. Every other card gets
  // null and shows no line — no "0 running", no placeholder.
  const { sessions: agentSessions, discovered: agentDiscovered, hooks: agentHooks } = useAgentAttention();
  const agents = phase === 'connected' ? fleetLine(agentSessions, agentDiscovered, agentHooks) : null;
  const { byId, refresh } = useReachability(devices);

  const [pendingForget, setPendingForget] = useState<SavedDevice | null>(null);
  /** The computer whose settings sheet is open, if any. */
  const [details, setDetails] = useState<SavedDevice | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [addingOpen, setAddingOpen] = useState(false);
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
    setAddingOpen(false);
    await addDevice(device);
    router.replace('/(home)/screen');
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
      router.replace('/(home)/screen');
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

  // Only ever shown when at least one computer cannot survive an address
  // change: LAN addresses are an optimization, not somewhere you can come back
  // to from outside the house.
  const lanOnly = devices.filter((d) => !isReachableFromAnywhere(d));

  const sheets = (
    <>
      <Sheet visible={optionsOpen} onClose={() => setOptionsOpen(false)} title="Options" testID="appearance-sheet">
        <View style={{ gap: theme.space.md }}>
          <View>
            <Caption style={{ marginBottom: theme.space.sm }}>
              Current is light and clear. Fieldwork is dark and tactile.
            </Caption>
            <ThemeToggle testID="appearance-picker" />
          </View>
          {activeUrl && phase === 'connected' ? (
            <Caption testID="connected-over">{`Connected over ${describeUrl(activeUrl)}.`}</Caption>
          ) : null}
          <Button label="Check again" testID="refresh-devices" variant="secondary" fullWidth onPress={() => { refreshAll(); setOptionsOpen(false); }} />
        </View>
      </Sheet>

      <Sheet visible={addingOpen} onClose={() => setAddingOpen(false)} title="Add computer" testID="add-computer-sheet">
        <View style={{ gap: theme.space.md }}>
          <AddComputer heading={false} />
          {/* The connected computer can see the rest of the tailnet, so adding
              the other machine becomes one tap instead of typing an address.
              It belongs in this sheet, not on the list: it is an add path. */}
          <DiscoveredSection
            saved={devices}
            connected={phase === 'connected'}
            viaLabel={active?.label ?? 'your computer'}
            nonce={discoveryNonce}
            onAdd={onDiscoveredAdd}
          />
        </View>
      </Sheet>

      <Sheet
        visible={details !== null}
        onClose={() => setDetails(null)}
        title={details?.label ?? 'Computer'}
        testID="device-sheet"
      >
        <View style={{ gap: theme.space.md }}>
          <Caption>
            {details && activeUrl && active?.id === details.id && phase === 'connected'
              ? `Connected over ${describeUrl(activeUrl)}.`
              : 'Belay reaches this computer at whichever of its saved addresses answers first.'}
          </Caption>
          <Button
            label="Forget this computer"
            accessibilityLabel={details ? `Forget ${details.label}` : 'Forget this computer'}
            testID="forget-device"
            variant="secondary"
            fullWidth
            onPress={() => { const d = details; setDetails(null); setPendingForget(d); }}
          />
        </View>
      </Sheet>

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
    </>
  );

  if (devices.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <EmptyComputers onAdd={() => setAddingOpen(true)} onOpenOptions={() => setOptionsOpen(true)} />
        {sheets}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <Screen scroll padding="page" contentStyle={{ paddingBottom: theme.space.xl }}>
        <View style={{ gap: theme.space.lg }}>
          <DevicesHeader onAdd={() => setAddingOpen(true)} onOpenOptions={() => setOptionsOpen(true)} />

          <View style={{ marginBottom: look.titleGap }}>
            <Txt variant="display" heading>{look.devicesTitle}</Txt>
            {look.devicesSubtitle ? (
              <Txt variant="body" tone="dim" style={{ marginTop: 2 }}>{look.devicesSubtitle}</Txt>
            ) : null}
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
                agents={active?.id === device.id ? agents : null}
                onPick={() => void onPick(device)}
                onOpenDetails={() => setDetails(device)}
                onOpenAgent={() => router.navigate('/agent')}
              />
            ))}
            <AddComputerRow onPress={() => setAddingOpen(true)} />
          </View>

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
        </View>
      </Screen>
      <AppearanceNav selected="screen" />
      {sheets}
    </View>
  );
}

/** Human description of which path is in use, without showing a raw URL. */
function describeUrl(url: string): string {
  const host = url.replace(/^https?:\/\//, '').split(':')[0];
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'Tailscale';
  if (host.endsWith('.ts.net')) return 'Tailscale';
  return 'your local network';
}

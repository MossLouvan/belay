// "Also on your tailnet" — the computers a connected host can vouch for,
// offered as one-tap adds.
//
// The connected computer enumerates its own tailnet peers and reports the
// ones running Belay (server/src/discover-hosts.ts); this section turns each
// into a single tap: race its addresses from *this phone's* vantage point,
// pair code-lessly over the tailnet, save it through the same
// `buildSavedDevice` path a typed address takes. No IP, no port, no code.
//
// Discovered rows deliberately do not look like saved rows: no status dot, a
// "found via" subtitle, and an ADD affordance where saved rows carry Forget —
// a computer you have not added yet must read as an offer, not a possession.

import React, { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { router } from 'expo-router';

import { api, checkHost, pair } from '../api';
import type { DiscoverHostsReply, DiscoveredHost } from '../api';
import { Banner, Button, Caption, Label, ListItem, Micro, Rule, haptic } from '../ui';
import { useTheme } from '../theme';
import type { SavedDevice } from './model';
import { buildSavedDevice } from './from-host';
import { raceAddresses } from './race';
import { candidateUrls, newlyDiscovered, pairNeedsCode, summarizeDiscovery } from './discovered';

/** Matches the name the connect screen pairs under, so the host's device list
 *  reads the same whichever path added this phone. */
const deviceName = (): string => {
  if (Platform.OS === 'web') return 'Browser';
  if (Platform.OS === 'ios') return 'iPhone';
  return 'Android';
};

function platformWord(platform: string): string {
  if (platform === 'darwin') return 'Mac';
  if (platform === 'win32') return 'Windows';
  return 'Computer';
}

type ScanState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly at: number }
  | { readonly kind: 'ready'; readonly reply: DiscoverHostsReply; readonly at: number };

interface AddFailure {
  readonly message: string;
  /** Set when the fix is the code path, which the connect screen owns. */
  readonly offerCode: boolean;
}

export interface DiscoveredSectionProps {
  /** The saved list, so already-added computers are never offered again. */
  saved: readonly SavedDevice[];
  /** Only a connected host can be asked to look. */
  connected: boolean;
  /** The connected computer's name — the empty states say who looked. */
  viaLabel: string;
  /** Bumped by the screen's Refresh to look again. */
  nonce: number;
  /** Persist + connect; the parent owns navigation afterwards. */
  onAdd: (device: SavedDevice) => Promise<void>;
}

export function DiscoveredSection({ saved, connected, viaLabel, nonce, onAdd }: DiscoveredSectionProps) {
  const theme = useTheme();
  const [scan, setScan] = useState<ScanState>({ kind: 'loading' });
  const [adding, setAdding] = useState<string | null>(null);
  const [failure, setFailure] = useState<Readonly<Record<string, AddFailure>>>({});

  useEffect(() => {
    if (!connected) return;
    let live = true;
    api.discoverHosts()
      .then((reply) => { if (live) setScan({ kind: 'ready', reply, at: Date.now() }); })
      .catch((e: unknown) => {
        if (!live) return;
        const message = e instanceof Error ? e.message : 'the request failed';
        setScan({ kind: 'error', message, at: Date.now() });
      });
    return () => { live = false; };
  }, [connected, nonce]);

  const addHost = useCallback(async (host: DiscoveredHost) => {
    haptic('light');
    setAdding(host.id);
    setFailure(({ [host.id]: _cleared, ...rest }) => rest);
    try {
      // The reporting host proved the peer from where *it* stands; this phone
      // must find its own way in, so the peer's addresses are raced exactly
      // like a saved computer's.
      const winner = await raceAddresses(
        candidateUrls(host).map((url) => ({ url })),
        async (url, signal) => {
          const health = await checkHost(url, signal);
          return { ok: health.ok, hostId: health.id };
        },
      );
      if (!winner) {
        setFailure((prev) => ({
          ...prev,
          [host.id]: {
            message: `None of ${host.label}'s addresses answered from this phone. `
              + 'If Tailscale is off on this phone, turn it on and try again.',
            offerCode: false,
          },
        }));
        return;
      }

      // Code-less: over the owner's tailnet the host recognises this phone
      // through the Tailscale daemon, the same trust the reporting host used
      // to vouch for it. An empty code takes the server's tailnet path.
      const result = await pair(winner.url, '', deviceName());
      // Re-read /health as the typed flow does, so the saved computer carries
      // the host's current identity and full address list.
      const identity = await checkHost(result.host);
      haptic('success');
      await onAdd(buildSavedDevice(result, identity, Date.now()));
    } catch (e: unknown) {
      haptic('error');
      const message = e instanceof Error ? e.message : 'pairing failed';
      setFailure((prev) => ({
        ...prev,
        [host.id]: pairNeedsCode(message)
          ? {
              message: `${host.label} asked for a pairing code — this phone reached it `
                + 'outside your tailnet, so it cannot vouch for who is asking.',
              offerCode: true,
            }
          : { message: `Could not pair with ${host.label}: ${message}`, offerCode: false },
      }));
    } finally {
      setAdding(null);
    }
  }, [onAdd]);

  if (!connected) return null;

  const margin = theme.layout.margin;
  const heading = (
    <Label style={{ marginBottom: theme.space.xs }}>Also on your tailnet</Label>
  );

  if (scan.kind === 'loading') {
    return (
      <View>
        {heading}
        <Caption>Asking {viaLabel} to look for your other computers…</Caption>
      </View>
    );
  }

  if (scan.kind === 'error') {
    return (
      <View>
        {heading}
        <Caption>{`Could not ask ${viaLabel} to look: ${scan.message}`}</Caption>
        <Micro style={{ marginTop: theme.space.xxs }}>{`Checked ${timeOf(scan.at)} · Refresh looks again`}</Micro>
      </View>
    );
  }

  const fresh = newlyDiscovered(scan.reply.hosts, saved);
  const summary = summarizeDiscovery(scan.reply, fresh.length, viaLabel);

  return (
    <View>
      {heading}
      {fresh.map((host) => (
        <View key={host.id}>
          <ListItem
            testID={`discovered-${host.id}`}
            title={host.label}
            subtitle={`${platformWord(host.platform)} · found via ${viaLabel} · not added yet`}
            disabled={adding !== null}
            accessibilityHint={`Add ${host.label} without a code`}
            onPress={() => void addHost(host)}
            trailing={
              <Button
                variant="secondary"
                size="sm"
                label="Add"
                loading={adding === host.id}
                disabled={adding !== null && adding !== host.id}
                accessibilityLabel={`Add ${host.label}`}
                onPress={() => void addHost(host)}
              />
            }
          />
          {failure[host.id] ? (
            <Banner
              status="warn"
              message={failure[host.id].message}
              action={failure[host.id].offerCode
                ? { label: 'Use a pairing code', onPress: () => router.push({ pathname: '/', params: { add: '1' } }) }
                : undefined}
              style={{ marginBottom: theme.space.sm }}
            />
          ) : null}
          <Rule bleed={margin} />
        </View>
      ))}
      {summary ? (
        <View style={{ gap: theme.space.xxs }}>
          <Caption>{summary.message}</Caption>
          <Micro>{`Checked ${timeOf(scan.at)} · Refresh looks again`}</Micro>
        </View>
      ) : (
        <Micro style={{ marginTop: theme.space.xxs }}>
          {`Tap to add — no code needed on your own tailnet. Checked ${timeOf(scan.at)}`}
        </Micro>
      )}
    </View>
  );
}

function timeOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

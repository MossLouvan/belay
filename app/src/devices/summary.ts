// How the active connection is described in one glance — the words behind the
// switch-computer element every tab header carries.
//
// The description is honest about what the app actually knows. The connection
// context records the outcome of the most recent address race; it does not
// heartbeat afterwards. So "connected" here means "the last attempt to reach
// this computer succeeded", and each tab's own status line remains the live
// truth for its surface (the stream's fps, the terminal's pty, the stats
// poll). This element answers the other two questions — *which* computer and
// *by what path* — plus that one coarse fact, and claims nothing more.
//
// Pure, so it can be unit tested under node without React or react-native.

import type { AddressKind, SavedDevice } from './model';
import type { ConnectPhase } from '../connection';

/** Mirrors the ui Status vocabulary without value-importing react-native. */
export type SummaryStatus = 'neutral' | 'good' | 'warn' | 'bad';

export interface ConnectionSummary {
  /** Rendered as an 11pt tracked label — the header chip's text. */
  readonly text: string;
  readonly status: SummaryStatus;
  /** Pulse only while something is actually in flight. */
  readonly pulse: boolean;
  /** Spoken form: full sentences, no mid-dots. */
  readonly accessibilityLabel: string;
}

/**
 * Short name for the path in use. MagicDNS is a Tailscale hostname — naming
 * the DNS scheme instead of the network would mean nothing to anyone.
 */
export function kindLabel(kind: AddressKind): string {
  if (kind === 'lan') return 'LAN';
  if (kind === 'relay') return 'Relay';
  return 'Tailscale';
}

/** The same path, in words a screen reader can say. */
export function kindSpoken(kind: AddressKind): string {
  if (kind === 'lan') return 'your local network';
  if (kind === 'relay') return 'a relay';
  return 'Tailscale';
}

/**
 * Which kind of address a resolved URL is. Matched against the device's own
 * saved addresses — the race hands back a URL it was given, so an exact match
 * is the normal case and a miss means we genuinely do not know the path.
 */
export function kindOfUrl(
  device: SavedDevice,
  url: string | null,
): AddressKind | null {
  if (!url) return null;
  return device.addresses.find((a) => a.url === url)?.kind ?? null;
}

export function connectionSummary(
  device: SavedDevice | undefined,
  phase: ConnectPhase,
  activeUrl: string | null,
): ConnectionSummary {
  if (!device) {
    return {
      text: 'No computer',
      status: 'neutral',
      pulse: false,
      accessibilityLabel: 'No computer connected. Opens My Computers.',
    };
  }

  // Display name for the header chip: drop the mDNS/domain suffix so a long
  // "Name.local" doesn't truncate. The full label stays in the a11y string.
  const name = device.label.replace(/\.(local|lan|home)$/i, '');

  if (phase === 'connecting') {
    return {
      text: `${name} · connecting`,
      status: 'warn',
      pulse: true,
      accessibilityLabel: `Connecting to ${device.label}. Opens My Computers.`,
    };
  }

  if (phase === 'unreachable') {
    return {
      text: `${name} · unreachable`,
      status: 'bad',
      pulse: false,
      accessibilityLabel: `Can't reach ${device.label}. Opens My Computers.`,
    };
  }

  if (phase === 'connected') {
    const kind = kindOfUrl(device, activeUrl);
    return {
      // A URL that matches none of the saved addresses should not happen, but
      // guessing a path would be worse than admitting only the connection.
      text: kind ? `${name} · ${kindLabel(kind)}` : name,
      status: 'good',
      pulse: false,
      accessibilityLabel: kind
        ? `Connected to ${device.label} over ${kindSpoken(kind)}. Opens My Computers.`
        : `Connected to ${device.label}. Opens My Computers.`,
    };
  }

  // 'idle': a computer is selected but no attempt has been made yet.
  return {
    text: device.label,
    status: 'neutral',
    pulse: false,
    accessibilityLabel: `${device.label}. Opens My Computers.`,
  };
}

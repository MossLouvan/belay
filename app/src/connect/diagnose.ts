// Turning terse transport failures into something a person can act on.
//
// The host agent only ever reports one failure for a bad pairing attempt
// ("invalid or expired pairing code") because it cannot distinguish a wrong
// code from an expired one without leaking whether a guess was close. So the
// copy here covers both causes honestly instead of guessing at one.

import { Platform } from 'react-native';
import { prettyHost } from './host-input';

export interface Diagnosis {
  readonly title: string;
  readonly message: string;
}

/** Fetch rejections differ per runtime; these are the shapes we actually see. */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /failed to fetch/i,
  /network request failed/i,
  /load failed/i,
  /networkerror/i,
  /econnrefused/i,
  /connection refused/i,
];

const TIMEOUT_PATTERNS: readonly RegExp[] = [/timed out/i, /timeout/i, /abort/i];

const isNetworkFailure = (raw: string): boolean => NETWORK_PATTERNS.some((p) => p.test(raw));
const isTimeout = (raw: string): boolean => TIMEOUT_PATTERNS.some((p) => p.test(raw));

/**
 * A page served over HTTPS cannot open a plain-HTTP connection: the browser
 * blocks it before any request leaves, and the rejection looks identical to the
 * host being down. Worth calling out, because no amount of network fiddling
 * will fix it.
 */
function mixedContentHint(url: string): string {
  if (Platform.OS !== 'web') return '';
  if (!url.startsWith('http://')) return '';
  const protocol = typeof globalThis !== 'undefined'
    ? (globalThis as { location?: { protocol?: string } }).location?.protocol
    : undefined;
  if (protocol !== 'https:') return '';
  return ' This page is served over HTTPS, so your browser blocks plain-HTTP connections to your PC — open Belay over http:// instead.';
}

const REACHABILITY_STEPS =
  'Check that the host agent is running on your PC (npm start in the server folder), that the address matches one it printed, and that both devices are on the same network. Away from home, use the PC\'s Tailscale address (100.x.y.z).';

/** Explains why `/health` did not answer, or answered with something unexpected. */
export function diagnoseHostFailure(url: string, raw?: string): Diagnosis {
  const detail = (raw || '').trim();
  const name = prettyHost(url);

  const status = /^host returned (\d{3})$/.exec(detail);
  if (status) {
    const code = Number(status[1]);
    if (code === 404) {
      return {
        title: `Something answered at ${name}, but it isn't Belay`,
        message: 'It replied 404 where the host agent reports its health, so whatever is listening there is most likely a different program. Double-check the port — the agent listens on 8787 by default.',
      };
    }
    if (code === 401 || code === 403) {
      return {
        title: `${name} refused the request (${code})`,
        message: 'The host agent never asks for credentials on this check, so the refusal most likely came from something in front of your PC — a proxy, VPN gateway or firewall. Connect to the PC directly, or use its Tailscale address.',
      };
    }
    return {
      title: `${name} answered with an error (${code})`,
      message: 'Something at that address is up but not serving Belay. If it is the host agent, restarting it on your PC usually clears this; if a proxy sits in between, try the PC directly or its Tailscale address.',
    };
  }

  if (isTimeout(detail)) {
    return {
      title: `${name} didn't respond in time`,
      message: `Nothing came back within a few seconds — the request may never have arrived, or the reply is stuck. ${REACHABILITY_STEPS}${mixedContentHint(url)}`,
    };
  }

  if (!detail || isNetworkFailure(detail)) {
    return {
      title: `Can't reach ${name}`,
      message: `${REACHABILITY_STEPS}${mixedContentHint(url)}`,
    };
  }

  return { title: `Can't reach ${name}`, message: `${detail}. ${REACHABILITY_STEPS}` };
}

/** Explains why `/pair` rejected us. */
export function diagnosePairFailure(url: string, raw: string): Diagnosis {
  const detail = (raw || '').trim();

  if (/invalid or expired/i.test(detail)) {
    return {
      title: "That code didn't work",
      message: 'Pairing codes are single-use and expire five minutes after they appear. Check the Belay window on your PC for the current code — it refreshes itself — and enter that one.',
    };
  }

  if (isTimeout(detail) || isNetworkFailure(detail)) {
    return {
      title: 'Lost contact with your PC',
      message: `The host stopped answering part-way through pairing. ${REACHABILITY_STEPS}`,
    };
  }

  if (!detail) {
    return { title: 'Pairing failed', message: `The host rejected the pairing attempt without saying why. ${REACHABILITY_STEPS}` };
  }

  return { title: 'Pairing failed', message: `${prettyHost(url)} said: ${detail}` };
}

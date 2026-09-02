// The WebRTC path is opt-in until it earns default. Until the loss-lab
// conformance suite passes, JPEG-over-WebSocket stays the default transport.
//
// STATUS: this flag currently gates nothing at runtime — the signaling relay
// (relay.ts) and the client state machine are validated, tested scaffolding that
// is NOT yet bound to a WebSocket route or an RTCPeerConnection (see
// docs/WEBRTC-SLICE.md). When the slice is wired, the /ws/webrtc upgrade and the
// signaling verbs must check this flag so a half-finished path can never regress
// the shipping product. Kept now so enablement is a wiring change, not an API one.
//
// Read through productEnv so it honours BELAY_WEBRTC with the legacy TETHER_
// fallback, exactly like every other knob (see env.ts).

import { productEnv } from '../env.js';

export function webrtcEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return flagOn(productEnv('WEBRTC', env));
}

/**
 * The cloud rendezvous path (infra/rendezvous) — off by default, and
 * additionally implied off whenever WebRTC itself is off, because the cloud
 * path only carries WebRTC signaling. STATUS: like the early BELAY_WEBRTC
 * flag, this currently gates wiring that does not exist yet — the host-side
 * rendezvous client is the next slice (docs/SCALABILITY.md). Kept now so
 * enablement stays a wiring change, not an API one, and so no half-finished
 * cloud path can ever regress the LAN/Tailscale tiers.
 */
export function cloudSignalingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return webrtcEnabled(env) && flagOn(productEnv('CLOUD_SIGNALING', env));
}

function flagOn(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

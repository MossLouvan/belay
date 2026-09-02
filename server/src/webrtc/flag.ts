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
  const raw = productEnv('WEBRTC', env);
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

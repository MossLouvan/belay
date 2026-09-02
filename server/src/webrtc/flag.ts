// The WebRTC path is opt-in until it earns default. Until the loss-lab
// conformance suite passes, JPEG-over-WebSocket stays the default transport and
// the WebRTC signaling verbs are only wired up when this flag is set — so a
// half-finished streaming path can never regress the shipping product.
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

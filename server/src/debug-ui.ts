// The debug harness flag.
//
// Same shape as virtualDisplayEnabled and webrtcEnabled: off unless explicitly
// turned on, read through productEnv so it honours the product prefix rather
// than hard-coding BELAY_.
//
// Why gated at all, given the page grants nothing without a token: a debug
// console answering on a LAN tells a stranger this machine runs Belay, what
// version, and which features it has. That is a hint nobody outside the
// household has any business collecting, and the cost of the flag is one line.

import { productEnv } from './env.js';

export function debugUiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = productEnv('DEBUG_UI', env);
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

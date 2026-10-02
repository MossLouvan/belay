// Parser for the claim QR the host shows when it starts unlinked.
//
//   belay://claim?c=<8-char base32 code>&n=<tunnel nodeId>
//
// Sibling of connect/pair-link.ts (same scheme handling, same "null for
// anything that is not ours" contract) so the one scanner screen can read
// either kind of code. The nodeId is kept: the phone later refuses to dial a
// tunnel whose nodeId differs from the one it claimed (design.md, Contracts).

import { normalizeClaimCode } from './api.ts';

export interface ParsedClaimLink {
  readonly code: string;
  readonly nodeId: string;
}

const CLAIM_CODE = /^[A-Z2-7]{8}$/;
/** The API's one nodeId encoding: the Ed25519 public key as exactly 64 lowercase hex (design.md). */
const NODE_ID = /^[0-9a-f]{64}$/;

export function parseClaimLink(raw: string): ParsedClaimLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'belay:' && url.protocol !== 'tether:') return null;
  const isClaim = url.hostname === 'claim' || url.pathname.replace(/\//g, '') === 'claim';
  if (!isClaim) return null;

  const code = normalizeClaimCode(url.searchParams.get('c') ?? '');
  const nodeId = (url.searchParams.get('n') ?? '').trim();
  if (!CLAIM_CODE.test(code) || !NODE_ID.test(nodeId)) return null;
  return { code, nodeId };
}

// Phones on this account waiting for one tap to join the connected computer
// (account trust; server/src/account-pair.ts). The host pushes them on the
// attention socket as `pairRequests`; this parses that half of the frame.
// No react-native, so pair-requests.test.mjs runs it in node.

export interface PairRequestRow {
  readonly id: string;
  readonly name: string;
  readonly expiresAt: number;
}

const clamp = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 32) || 'A phone';

/** `null` when the frame carries no list (older host) or a bad one. */
export function parsePairRequestsPush(raw: string): readonly PairRequestRow[] | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (typeof msg !== 'object' || msg === null) return null;
  const { type, pairRequests } = msg as { type?: unknown; pairRequests?: unknown };
  if (type !== 'attention' || !Array.isArray(pairRequests)) return null;
  const rows: PairRequestRow[] = [];
  for (const r of pairRequests as { id?: unknown; name?: unknown; expiresAt?: unknown }[]) {
    if (typeof r?.id !== 'string' || typeof r.name !== 'string' || typeof r.expiresAt !== 'number') return null;
    rows.push({ id: r.id, name: clamp(r.name), expiresAt: r.expiresAt });
  }
  return rows;
}

/** The host only sweeps on its next change; the phone hides lapsed ones itself. */
export function livePairRequests(rows: readonly PairRequestRow[], now: number): readonly PairRequestRow[] {
  return rows.filter((r) => r.expiresAt > now);
}

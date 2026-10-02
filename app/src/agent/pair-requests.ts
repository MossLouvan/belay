// Phones on this account waiting for one tap to join the connected computer
// (account trust; server/src/account-pair.ts). The host pushes them on the
// attention socket as `pairRequests`; this parses that half of the frame.
// No react-native, so pair-requests.test.mjs runs it in node.

export interface PairRequestRow {
  readonly id: string;
  readonly name: string;
  /** Also on the asking phone's screen: the owner checks they match. */
  readonly matchCode: string;
  /** What the account says the phone is, and when it joined (ms, or null). */
  readonly platform: string;
  readonly addedAt: number | null;
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
  for (const r of pairRequests as Record<string, unknown>[]) {
    if (typeof r?.id !== 'string' || typeof r.name !== 'string' || typeof r.expiresAt !== 'number') return null;
    rows.push({
      id: r.id,
      name: clamp(r.name),
      matchCode: typeof r.matchCode === 'string' && /^[A-Z2-9]{4}$/.test(r.matchCode) ? r.matchCode : '',
      platform: typeof r.platform === 'string' ? r.platform.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 16) || 'unknown' : 'unknown',
      addedAt: typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) && r.addedAt > 0 ? r.addedAt : null,
      expiresAt: r.expiresAt,
    });
  }
  return rows;
}

/** The host only sweeps on its next change; the phone hides lapsed ones itself. */
export function livePairRequests(rows: readonly PairRequestRow[], now: number): readonly PairRequestRow[] {
  return rows.filter((r) => r.expiresAt > now);
}

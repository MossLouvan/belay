// Pure cost accounting for agent sessions. Every finished turn arrives as a
// `result` event carrying `costUsd`; the feed shows it once ("✓ done · 12s ·
// $0.08") and scrolls on. This module folds those events into the running
// ledger the session header and the session list show, entirely on the phone
// — no server change, no new wire traffic. No React and no JSX, so
// `cost-ledger.test.mjs` can import it straight into Node.

import type { AgentEvent } from '../api';

/** Turn and dollar totals for one session — or, combined, for all of them. */
export interface CostLedger {
  /** Completed turns over the stored events (the host caps those at 400). */
  readonly turns: number;
  /** Dollars over the same window; turns the host never priced add zero. */
  readonly costUsd: number;
  readonly todayTurns: number;
  readonly todayCostUsd: number;
}

export const EMPTY_LEDGER: CostLedger = Object.freeze({
  turns: 0,
  costUsd: 0,
  todayTurns: 0,
  todayCostUsd: 0,
});

/**
 * "Today" as a person means it: the local calendar day, splitting at local
 * midnight — not a rolling 24 hours, which would quietly move money between
 * days as the clock ticked.
 */
export function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** A wire cost worth adding: finite and positive. Anything else is zero. */
function costOf(ev: AgentEvent): number {
  return typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd) && ev.costUsd > 0 ? ev.costUsd : 0;
}

/** Folds a session's stored events into its ledger. Only `result` events are
 * turns; narration and tool traffic belong to the turn that produced them. */
export function foldCosts(events: readonly AgentEvent[], now = Date.now()): CostLedger {
  return events.reduce<CostLedger>((acc, ev) => {
    if (ev.kind !== 'result') return acc;
    const cost = costOf(ev);
    const today = sameLocalDay(ev.t, now);
    return {
      turns: acc.turns + 1,
      costUsd: acc.costUsd + cost,
      todayTurns: today ? acc.todayTurns + 1 : acc.todayTurns,
      todayCostUsd: today ? acc.todayCostUsd + cost : acc.todayCostUsd,
    };
  }, EMPTY_LEDGER);
}

/** The session list's running total: every session's ledger, summed. */
export function combineLedgers(ledgers: readonly CostLedger[]): CostLedger {
  return ledgers.reduce<CostLedger>(
    (a, b) => ({
      turns: a.turns + b.turns,
      costUsd: a.costUsd + b.costUsd,
      todayTurns: a.todayTurns + b.todayTurns,
      todayCostUsd: a.todayCostUsd + b.todayCostUsd,
    }),
    EMPTY_LEDGER,
  );
}

/** Dollars to the cent. A spend too small to round to a cent says so rather
 * than printing the lie "$0.00". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function turnCount(n: number): string {
  return `${n} ${n === 1 ? 'turn' : 'turns'}`;
}

/**
 * The ledger row's words: "today · 14 turns · $1.92". A day with no activity
 * falls back to the all-time window ("total · …") instead of announcing an
 * empty today; a host that never prices turns gets the count without a fake
 * dollar figure; no turns at all yields '' so the row can hide entirely.
 */
export function ledgerLine(ledger: CostLedger): string {
  if (ledger.turns === 0) return '';
  const today = ledger.todayTurns > 0;
  const turns = today ? ledger.todayTurns : ledger.turns;
  const cost = today ? ledger.todayCostUsd : ledger.costUsd;
  const bits = [today ? 'today' : 'total', turnCount(turns), cost > 0 ? formatUsd(cost) : ''];
  return bits.filter(Boolean).join(' · ');
}

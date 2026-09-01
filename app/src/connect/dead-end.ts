// Detecting the pairing dead end before anyone types a digit.
//
// The host only mints a pairing code while nothing is paired with it — an
// already-paired host that restarts would otherwise hold a live five-minute
// code its banner never prints, an open door nobody could see. Correct on the
// host; a trap on the phone, which used to present six code boxes anyway and
// let someone sit entering codes that could not exist. /health already says
// everything needed to catch this: `paired: true` plus `pairing: 'code'`
// means a code is required from here and none will be issued.
//
// Detection is deliberately conservative. An older host omits both fields, and
// old hosts opened a pairing window unconditionally — so "field absent" means
// the code flow works, not that it is dead. Only an explicit `paired: true`
// can declare the dead end.

import type { HostCheck } from '../api';
import type { TailnetOutcome, TailnetPlan } from './tailnet';

/**
 * Where the tailnet route stands when the code route is dead, because the two
 * findings want different advice: a tailnet address that never answered points
 * at the Tailscale app on this phone, while one that answered and still asked
 * for a code means Tailscale is fine and only the computer can help.
 */
export type TailnetStanding =
  /** The host advertises no tailnet address at all. */
  | 'none'
  /** A tailnet address is advertised but has not been tried from this phone. */
  | 'untried'
  /** The tailnet address did not answer — Tailscale is likely off here. */
  | 'unreachable'
  /** Reached over the tailnet, but the host did not recognise this phone. */
  | 'unrecognised';

export interface PairingDeadEnd {
  readonly standing: TailnetStanding;
  /** The raw tailnet failure, kept so a stuck setup can be reported. */
  readonly detail?: string;
}

/**
 * Whether the code screen would be a dead end, and what is worth saying if so.
 *
 * `probe` is the outcome of re-checking the advertised tailnet address, when
 * that happened; null when it did not (the host advertised nothing new, or the
 * first check already landed on the tailnet address). `tailnetUrl` is
 * `tailnetUrlFrom(check)`, computed by the caller — taking it as an argument
 * keeps this module free of value imports, which is what lets `node --test`
 * load it without a bundler.
 */
export function detectDeadEnd(
  check: HostCheck,
  plan: TailnetPlan,
  probe: TailnetOutcome | null,
  tailnetUrl: string | null,
): PairingDeadEnd | null {
  // Codeless pairing is proceeding (or about to) — no code will be asked for.
  if (check.pairing === 'tailnet') return null;
  if (probe?.kind === 'paired-path') return null;

  // Nothing paired yet (or an older host that does not say): the host keeps a
  // live code on its screen, so the code entry is honest work, not a trap.
  if (check.paired !== true) return null;

  if (probe?.kind === 'tailscale-off') {
    return { standing: 'unreachable', detail: probe.detail };
  }
  if (probe?.kind === 'code-required') return { standing: 'unrecognised' };

  if (plan.kind === 'unavailable') {
    // `unavailable` covers two very different hosts: one with no tailnet
    // address at all, and one we already reached *over* its tailnet address
    // yet which still asked for a code — the plan collapses "nothing to try"
    // and "already tried" into one kind, so the address list tells them apart.
    return { standing: tailnetUrl ? 'unrecognised' : 'none' };
  }

  // An upgrade plan that was never probed. The live flow always probes before
  // reaching the code screen, but totality here beats trusting that forever.
  return { standing: 'untried' };
}

/**
 * The exact commands that reopen the pairing window on the computer.
 *
 * There is no gentler lever: the host has no unpair command, and it only
 * issues codes while nothing is paired — so the honest instruction is to
 * clear the paired devices (they live in the host's state file) and start
 * fresh. Both spellings of that file are removed: a host installed before the
 * rename keeps its pairings in tether-state.json, one after it in
 * deskhandler-state.json, and guessing wrong would leave the window shut.
 * DESKHANDLER_TEST_CODE is deliberately not offered: it disables expiry and
 * single-use, and the host itself warns it is for automated tests only.
 */
export function reopenPairingCommand(platform?: string): string {
  const remove = platform === 'win32'
    ? 'del deskhandler-state.json tether-state.json'
    : 'rm -f deskhandler-state.json tether-state.json';
  return `cd server\n${remove}\nnpm start`;
}

/**
 * Proof-of-life stamp for the dead-end notice (docs/DESIGN.md §11.4): a
 * static error screen reads as a crash, so the notice says when it last
 * looked. Local wall-clock time, since that is what the person's watch says.
 */
export function checkedAtLabel(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

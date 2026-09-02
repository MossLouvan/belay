// The one honest description of "what is true about the link right now".
//
// Every non-stream tab used to re-derive "am I connected?" in its own words;
// this maps the app-wide `ConnectPhase` (src/connection.tsx) to a single Dot
// status + wide-tracked mono label, so the phrasing can never drift from tab
// to tab (docs/FRONTEND-REVAMP.md §4.1). Kept as a pure function in its own
// `.ts` module so it is unit-testable under `node --test` without JSX.

import type { Status } from './feedback';

/** The four states the app-wide connection can be in. Mirrors ConnectPhase. */
export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'unreachable';

export interface ConnectionView {
  /** Dot tint — never the accent for a plain link state; accent means "decide". */
  readonly status: Status;
  /** Whether the dot should pulse (only while a link is actively forming). */
  readonly pulse: boolean;
  /** The wide-tracked mono label, already upper-cased by the caller's Label. */
  readonly label: string;
}

/**
 * Describe the connection for a status row.
 *
 * @param phase   the app-wide connect phase
 * @param machine the active computer's label, appended when known
 */
export function describeConnection(phase: ConnectionPhase, machine?: string): ConnectionView {
  const withMachine = (word: string): string => (machine ? `${word} · ${machine}` : word);
  switch (phase) {
    case 'connected':
      return { status: 'good', pulse: false, label: withMachine('Connected') };
    case 'connecting':
      return { status: 'accent', pulse: true, label: 'Connecting…' };
    case 'unreachable':
      return { status: 'bad', pulse: false, label: withMachine('Asleep or off') };
    case 'idle':
    default:
      return { status: 'neutral', pulse: false, label: 'Not connected' };
  }
}

// The guided Tailscale setup, as decisions a node test can hold down.
//
// The guide walks a novice through four steps — why, install, sign in,
// connect — and its whole promise is that nobody types a port or a 100.x
// address at the end. The host already told us everything: `/health`
// advertises the full address list (tailnet address included), and a request
// arriving over the owner's own tailnet pairs with no code. So the final step
// just watches. It re-runs the existing check on a timer and on returning
// from the Tailscale app, and the moment the tailnet answers, the continue
// button lights up with the discovered address already inside it.
//
// Everything here is pure — the step order, the progress fraction the rope
// animation pulls on, and the reading of a poll's result — so the screen
// component only has to schedule checks and move pixels.

import type { HostCheck } from '../api';
import { planTailnetUpgrade, readTailnetProbe, tailnetUrlFrom } from './tailnet.ts';

/**
 * The steps, in climbing order. `intro` sells the why; the last step is the
 * one that watches for the tailnet and hands over the discovered address.
 */
export const GUIDE_STEPS = ['intro', 'install', 'account', 'connect'] as const;

export type GuideStep = (typeof GUIDE_STEPS)[number];

/** Position of a step in the climb, 0-based. */
export function guideStepIndex(step: GuideStep): number {
  return GUIDE_STEPS.indexOf(step);
}

/** The step after this one, or null at the top. */
export function nextGuideStep(step: GuideStep): GuideStep | null {
  const i = guideStepIndex(step);
  return i >= 0 && i < GUIDE_STEPS.length - 1 ? GUIDE_STEPS[i + 1] : null;
}

/** The step before this one, or null at the bottom. */
export function prevGuideStep(step: GuideStep): GuideStep | null {
  const i = guideStepIndex(step);
  return i > 0 ? GUIDE_STEPS[i - 1] : null;
}

/**
 * How far up the climb this step is, 0 at the start and 1 at the top.
 *
 * This is the value the rope animation pulls on: a belayer takes in rope as
 * the climber ascends, so the rope on screen gets shorter as this grows.
 */
export function guideProgress(step: GuideStep): number {
  const i = guideStepIndex(step);
  return i <= 0 ? 0 : i / (GUIDE_STEPS.length - 1);
}

/**
 * How often the connect step re-asks the host while it waits.
 *
 * Long enough that a poll finishes before the next one is due (each check is
 * bounded well under this), short enough that the button lights within a
 * breath of the Tailscale switch being flipped. Returning from the Tailscale
 * app also triggers an immediate check, so this is the ceiling, not the wait.
 */
export const GUIDE_POLL_MS = 4000;

/** Each poll's request deadline — comfortably inside the poll interval. */
export const GUIDE_CHECK_TIMEOUT_MS = 3500;

/**
 * The address a poll should probe after the first check succeeds, if any.
 *
 * Null either because no second request is useful (the first check already
 * proved the tailnet, or the host advertises nothing new) — the poll then
 * reads the detection from the first check alone.
 */
export function guideProbeTarget(check: HostCheck, checkedUrl: string): string | null {
  if (!check.ok) return null;
  const plan = planTailnetUpgrade(check, checkedUrl);
  return plan.kind === 'upgrade' ? plan.url : null;
}

export type GuideDetection =
  /** On the tailnet — pair over this address with no code and no typing. */
  | { readonly kind: 'connected'; readonly url: string }
  /** Not there yet; keep watching. Carries the failure for the small print. */
  | { readonly kind: 'waiting'; readonly detail?: string }
  /** The computer itself has no tailnet address — Tailscale is missing there. */
  | { readonly kind: 'no-tailnet' }
  /** Reachable, but the host still insists on a code — fall back to digits. */
  | { readonly kind: 'code-required' };

/**
 * What one round of watching concluded.
 *
 * `check` is the poll of the address that worked before (usually LAN); `probe`
 * is the follow-up on `guideProbeTarget`, or null when none was needed. An
 * unreachable host is read as "waiting", not an error: the guide's whole job
 * runs while the user is off in another app flipping switches, and a phone
 * mid-way onto a tailnet drops packets before it delivers them.
 */
export function readGuideDetection(
  check: HostCheck,
  checkedUrl: string,
  probe: HostCheck | null,
): GuideDetection {
  if (!check.ok) return { kind: 'waiting', detail: check.error };

  const plan = planTailnetUpgrade(check, checkedUrl);
  if (plan.kind === 'ready') return { kind: 'connected', url: checkedUrl };
  if (plan.kind === 'unavailable') {
    // Two very different "nothing to upgrade" cases: the host advertises no
    // tailnet address at all (fix is on the computer), or the checked address
    // IS the tailnet one and the host still wants a code (fix is the code).
    return tailnetUrlFrom(check) ? { kind: 'code-required' } : { kind: 'no-tailnet' };
  }

  if (!probe) return { kind: 'waiting' };
  const outcome = readTailnetProbe(plan.url, probe);
  if (outcome.kind === 'paired-path') return { kind: 'connected', url: outcome.url };
  if (outcome.kind === 'code-required') return { kind: 'code-required' };
  return { kind: 'waiting', detail: outcome.detail };
}

/**
 * How long the connected confirmation stays on screen before the guide moves
 * on by itself — long enough to read "you're connected", short enough that
 * nobody wonders whether they were supposed to press something.
 */
export const AUTO_ADVANCE_DWELL_MS = 1000;

/**
 * The guide's hands-free ending, as a value a reducer can hold.
 *
 * The owner's question was "is there a way to not even need to press a
 * button?" — so when the tailnet answers, the connect step advances on its
 * own. But a network mid-way onto a tailnet can serve one lucky packet and
 * then drop the next, and auto-advancing on that lucky packet would pair
 * against an address that is about to vanish. So the machine demands two
 * consecutive connected readings: the first lights the screen, the second —
 * requested immediately, not a poll interval later — confirms it. A
 * non-connected reading in between resets the streak; `ready` never demotes.
 */
export type AutoAdvance =
  /** Nothing seen yet, or the streak was broken. */
  | { readonly kind: 'idle' }
  /** One connected reading — confirm it before moving anyone anywhere. */
  | { readonly kind: 'confirming'; readonly url: string }
  /** Confirmed twice over — the guide may advance without a tap. */
  | { readonly kind: 'ready'; readonly url: string };

/**
 * Fold one raw poll reading into the auto-advance machine.
 *
 * Takes the reading *before* the screen's own "never demote a lit button"
 * stickiness is applied — the debounce only means something against raw
 * readings, since the sticky value can never disagree with itself.
 */
export function nextAutoAdvance(current: AutoAdvance, reading: GuideDetection): AutoAdvance {
  if (current.kind === 'ready') return current;
  if (reading.kind !== 'connected') {
    // Idle stays the same value, not a fresh copy — a screen holding this in
    // state should not re-render on every empty poll.
    return current.kind === 'idle' ? current : { kind: 'idle' };
  }
  if (current.kind === 'confirming') return { kind: 'ready', url: reading.url };
  return { kind: 'confirming', url: reading.url };
}

// The machine panel's interior while there is no picture.
//
// This replaces three older pieces at once — the stranded "No picture from the
// host." caption, the red stream-error banner above the stage, and the floating
// permission card — with the one fixed empty/error anatomy of docs/DESIGN.md
// §11.4: STATE NAME, the observed fact (guesses labelled as guesses), one
// accent action that can actually succeed from here, and a proof-of-life line
// so a waiting screen never reads as a crashed one.
//
// The anatomy itself is the shared `GlassState` component (src/ui), which
// Screen and Terminal both render, so every empty, waiting and fault state in
// the app is centred and worded the same way. This file only decides WHAT the
// Screen panel says (`panelCopyFor`) and owns the live outage clock.

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getTheme } from '../theme';
import { GlassState, Micro } from '../ui';
import { retryPhrase } from './retry';
import type { Phase } from './stream';

/** The two verbs a stateless panel can offer (docs/DESIGN.md §11.3). */
export type PanelAction = 'retry' | 'help';

export interface PanelCopy {
  /** STATE NAME — micro-label, dim for waiting states, `bad` for faults. */
  readonly name: string;
  readonly severity: 'dim' | 'bad';
  /** What is observed to be true, one or two sentences, never a sure-sounding guess. */
  readonly body: string;
  readonly action?: PanelAction;
  readonly actionLabel?: string;
  /** Show the live outage clock ("Still trying · 9m") under the body. */
  readonly countdown: boolean;
  /** Static proof-of-life line when there is no outage clock to show. */
  readonly proof?: string;
}

/**
 * Pure mapping from what we actually know to what the panel says. Different
 * causes get different first lines; the anatomy never changes.
 */
export function panelCopyFor(
  connected: boolean,
  phase: Phase,
  streamError: string | null,
  captureBlocked: boolean,
  captureKnown: boolean,
  hostName: string
): PanelCopy {
  if (!connected) {
    return {
      name: 'Not connected',
      severity: 'dim',
      body: 'This phone is not paired with a computer yet. Pairing starts from the connect screen.',
      countdown: false,
    };
  }
  if (captureBlocked) {
    return {
      name: captureKnown ? 'Screen recording off' : 'Capture blocked',
      severity: 'bad',
      body: captureKnown
        ? 'The Mac reports that Screen Recording permission is not granted, so every frame would be black.'
        : 'The Mac could not capture the display, and the error reads like a macOS privacy refusal.',
      action: 'help',
      actionLabel: 'How to fix',
      countdown: false,
      proof: 'Checked again automatically every 15s',
    };
  }
  if (phase === 'reconnecting') {
    return {
      name: 'Reconnecting',
      severity: 'bad',
      // The observed fact is only that the stream dropped; the sleep/network
      // line is explicitly a guess — a confident wrong diagnosis is worse
      // than an honest one (docs/DESIGN.md §11.4).
      body: streamError ?? 'The stream dropped. This usually means a network blip or the computer going to sleep.',
      action: 'retry',
      actionLabel: 'Retry',
      countdown: true,
    };
  }
  if (phase === 'error' || phase === 'stalled') {
    return {
      name: 'No signal',
      severity: 'bad',
      body: streamError ?? `${hostName} closed the stream without sending a picture.`,
      action: 'retry',
      actionLabel: 'Retry',
      countdown: false,
    };
  }
  return {
    name: 'Connecting',
    severity: 'dim',
    body: `Opening the screen stream from ${hostName}…`,
    countdown: false,
  };
}

/**
 * "STILL TRYING · 9M" — the proof the app is alive. The old line here counted
 * backoff attempts ("RETRYING IN 4S · ATTEMPT 86"), which reads as an app
 * confessing it has blind-retried for ten minutes; the honest, useful fact is
 * how long the outage has lasted. The stream now probes `/health` between
 * backoff ticks and reconnects the instant the host answers, so there is no
 * countdown worth showing either — the phrasing lives in ./retry.ts where the
 * node tests hold it to its word.
 */
function OutageClock({ sinceMs }: { sinceMs: number | null }) {
  const ink = getTheme('dark').colors;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Micro testID="panel-countdown" style={{ color: ink.onMachineDim }}>
      {retryPhrase(now, sinceMs ?? now)}
    </Micro>
  );
}

export interface PanelStateProps {
  connected: boolean;
  phase: Phase;
  /** When the current outage began (`StreamState.retryingSinceMs`). */
  retryingSinceMs: number | null;
  streamError: string | null;
  captureBlocked: boolean;
  captureKnown: boolean;
  hostName: string;
  onRetry: () => void;
  onHelp: () => void;
  testID?: string;
}

/**
 * The guidance surface filling the empty machine panel — the shared GlassState
 * anatomy over the dark stage, positioned to cover it (the stage has nothing
 * to click while there is no picture). Its own presses are the way forward.
 */
export function PanelState({
  connected,
  phase,
  retryingSinceMs,
  streamError,
  captureBlocked,
  captureKnown,
  hostName,
  onRetry,
  onHelp,
  testID,
}: PanelStateProps) {
  const copy = panelCopyFor(connected, phase, streamError, captureBlocked, captureKnown, hostName);

  return (
    <View testID={testID} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      <GlassState
        status={copy.severity}
        name={copy.name}
        body={copy.body}
        action={
          copy.action && copy.actionLabel
            ? { label: copy.actionLabel, onPress: copy.action === 'help' ? onHelp : onRetry }
            : undefined
        }
        proof={copy.proof}
        proofSlot={copy.countdown ? <OutageClock sinceMs={retryingSinceMs} /> : undefined}
      />
    </View>
  );
}

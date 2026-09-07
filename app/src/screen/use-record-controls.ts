// Host-side screen recording, for handing frames to a Claude session. The
// capture runs — and the frames stay — on the computer; this is only the
// switch. It records the monitor currently being streamed, so what the user
// is looking at is what Claude gets. The record key's three meanings are a
// pure decision (screen-chrome.ts recordKeyAction).

import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { setOpenSession } from '../agent/attention-store';
import { SENT_NOTICE_MS } from './record';
import type { RecordPhase } from './record';
import type { SentInfo } from './record-parts';
import { recordKeyAction } from './screen-chrome';
import { useRecording } from './useRecording';
import type { RecordingControl } from './useRecording';
import { useTransient } from './use-transient';

export interface RecordControlsInputs {
  readonly active: boolean;
  /** The monitor being streamed — the one the capture records. */
  readonly screenIndex: number | undefined;
  readonly reportError: (message: string) => void;
}

export interface RecordControls {
  readonly recording: RecordingControl;
  readonly recordPhase: RecordPhase;
  readonly showRecordSheet: boolean;
  readonly openRecordSheet: () => void;
  readonly closeRecordSheet: () => void;
  /** One key, three meanings: start, stop, or review. */
  readonly onRecordKey: () => void;
  /** Stop and go straight to the review sheet. */
  readonly stopRecording: () => void;
  /** The receipt after the frames left, or null. */
  readonly sent: SentInfo | null;
  readonly onSent: (info: SentInfo) => void;
  readonly openSentSession: () => void;
}

export function useRecordControls({ active, screenIndex, reportError }: RecordControlsInputs): RecordControls {
  const recording = useRecording(active, reportError);
  const [showRecordSheet, setShowRecordSheet] = useState(false);
  const openRecordSheet = useCallback(() => setShowRecordSheet(true), []);
  const closeRecordSheet = useCallback(() => setShowRecordSheet(false), []);

  const recordPhase = recording.status.state;
  const onRecordKey = useCallback(() => {
    const action = recordKeyAction(recordPhase);
    if (action === 'start') void recording.start(screenIndex);
    else if (action === 'stop') void recording.stop();
    else setShowRecordSheet(true);
  }, [recordPhase, recording, screenIndex]);
  // Stopping opens the review sheet directly: the whole point of the stop was
  // to hand the clip to Claude, so the handoff should not hide behind a
  // second tap on a key that now reads SEND.
  const stopRecording = useCallback(() => {
    void recording.stop().then(() => setShowRecordSheet(true));
  }, [recording]);

  // The frames left; the user must not have to wonder whether they arrived.
  // The notice holds for a few seconds with the one-tap way into the session,
  // then stands down — it is a receipt, not a permanent fixture.
  const notice = useTransient<SentInfo>(SENT_NOTICE_MS);
  const sent = notice.value;
  const onSent = notice.show;
  const openSentSession = useCallback(() => {
    if (!sent) return;
    notice.clear();
    setOpenSession(sent.sessionId);
    router.navigate('/agent');
  }, [sent, notice.clear]);

  return {
    recording,
    recordPhase,
    showRecordSheet,
    openRecordSheet,
    closeRecordSheet,
    onRecordKey,
    stopRecording,
    sent,
    onSent,
    openSentSession,
  };
}

// The recording strip, the send sheet and the sent notice — everything the
// user sees of the host-side screen recorder besides the dock's REC key.
//
// The strip is deliberately impossible to miss: a computer whose screen is
// being captured is a privacy state, so while recording it sits above the
// panel (or floats over it in fullscreen), pulsing in the status red, and it
// stays up in the "recorded, not yet sent" state so a stopped clip is never
// silently forgotten. §11.4 anatomy: state name and observed truth in one
// line, and the way forward — STOP, or SEND / DISCARD — as tracked labels
// right next to it.

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../api';
import type { AgentSessionMeta } from '../api';
import { getTheme, useTheme } from '../theme';
import { Button, Caption, Column, Dot, Input, ListItem, Micro, Row, Sheet, TrackLabel, Txt } from '../ui';
import { HUD } from './parts';
import { autoStopMessage, stripText } from './record';
import type { RecordingStatus } from './record';
import type { SendResult } from './useRecording';

export interface RecordStripProps {
  status: RecordingStatus;
  onStop: () => void;
  onReview: () => void;
  /** Floating over the fullscreen stage: chrome uses the HUD scrim. */
  floating?: boolean;
}

/**
 * One line: pulsing dot, "RECORDING · 0:14 · 9 FRAMES", and the single next
 * action. Rendered only while there is a recording to talk about.
 */
export function RecordStrip({ status, onStop, onReview, floating = false }: RecordStripProps) {
  const theme = useTheme();
  if (status.state === 'idle') return null;

  const recording = status.state === 'recording';
  // The status red, not the accent: recording is a warning state, and §11.5
  // lets safety-relevant marks outrank the one-accent rule. On the fullscreen
  // scrim the dark theme's red keeps contrast over any frame.
  const alert = floating ? getTheme('dark').colors.bad : theme.colors.bad;
  const ink = floating ? HUD.ink : theme.colors.text;
  const inks = floating
    ? { restLabel: HUD.ink, activeLabel: ink, restTrack: HUD.hairline, activeTrack: HUD.ink }
    : undefined;
  const stopped = autoStopMessage(status.autoStopped);

  return (
    <View
      testID="record-strip"
      accessibilityRole="alert"
      style={{
        paddingHorizontal: floating ? theme.space.sm : theme.layout.margin,
        paddingVertical: theme.space.xxs,
        backgroundColor: floating ? HUD.scrim : undefined,
        borderRadius: floating ? theme.radius.xs : 0,
        borderWidth: floating ? theme.layout.hairline : 0,
        borderColor: HUD.hairline,
      }}
    >
      <Row justify="space-between" gap="sm">
        <Row gap="xs" style={{ flexShrink: 1 }}>
          <Dot color={alert} pulse={recording} label={recording ? 'Recording' : 'Recorded'} />
          <Txt testID="record-strip-text" variant="label" numberOfLines={1} style={{ color: recording ? alert : ink }}>
            {stripText(status)}
          </Txt>
        </Row>
        {recording ? (
          <TrackLabel
            testID="record-stop"
            label="Stop"
            accessibilityLabel="Stop recording the computer's screen"
            inks={inks}
            onPress={onStop}
          />
        ) : (
          <Row gap="sm">
            <TrackLabel
              testID="record-review"
              label="Send"
              accessibilityLabel="Send the recording to a Claude session"
              active
              inks={inks}
              onPress={onReview}
            />
          </Row>
        )}
      </Row>
      {!recording && stopped ? <Micro tone="dim">{stopped}</Micro> : null}
    </View>
  );
}

/** What the sent notice needs to say and to reopen. */
export interface SentInfo {
  readonly sessionId: string;
  readonly title: string;
  readonly frames: number;
}

export interface SentNoticeProps {
  info: SentInfo;
  /** Jump straight into the session the frames went to. */
  onOpen: () => void;
  floating?: boolean;
}

/**
 * The strip's closing line: after a send, one glance must answer "did Claude
 * get it?" and one tap must land in the session that did. Without this, a
 * successful send and a vanished recording look identical.
 */
export function SentNotice({ info, onOpen, floating = false }: SentNoticeProps) {
  const theme = useTheme();
  const good = floating ? getTheme('dark').colors.good : theme.colors.good;
  const ink = floating ? HUD.ink : theme.colors.text;
  const inks = floating
    ? { restLabel: HUD.ink, activeLabel: ink, restTrack: HUD.hairline, activeTrack: HUD.ink }
    : undefined;
  return (
    <View
      testID="record-sent"
      accessibilityRole="alert"
      style={{
        paddingHorizontal: floating ? theme.space.sm : theme.layout.margin,
        paddingVertical: theme.space.xxs,
        backgroundColor: floating ? HUD.scrim : undefined,
        borderRadius: floating ? theme.radius.xs : 0,
        borderWidth: floating ? theme.layout.hairline : 0,
        borderColor: HUD.hairline,
      }}
    >
      <Row justify="space-between" gap="sm">
        <Row gap="xs" style={{ flexShrink: 1 }}>
          <Dot color={good} label="Sent" />
          <Txt testID="record-sent-text" variant="label" numberOfLines={1} style={{ color: ink }}>
            {`Sent · ${info.frames} frame${info.frames === 1 ? '' : 's'} → ${info.title}`}
          </Txt>
        </Row>
        <TrackLabel
          testID="record-open-session"
          label="Open"
          accessibilityLabel={`Open the ${info.title} session Claude is reading the recording in`}
          active
          inks={inks}
          onPress={onOpen}
        />
      </Row>
    </View>
  );
}

export interface RecordSheetProps {
  visible: boolean;
  onClose: () => void;
  status: RecordingStatus;
  busy: boolean;
  onSend: (sessionId: string, note?: string) => Promise<SendResult>;
  onDiscard: () => void;
  /** Fired after a successful send, with what went where. */
  onSent: (info: SentInfo) => void;
}

/**
 * The handoff. The frames are written into the chosen session's project ON
 * THE COMPUTER and the prompt referencing them is queued there — nothing
 * rides through the phone. Kept to one decision when the machine can make the
 * rest: with a single session there is nothing to pick, so the sheet shows
 * where the frames go and offers SEND; the note is optional and says so,
 * because a skipped note still yields a good prompt (the host asks Claude to
 * describe what changes).
 */
export function RecordSheet({ visible, onClose, status, busy, onSend, onDiscard, onSent }: RecordSheetProps) {
  const theme = useTheme();
  const router = useRouter();
  const [sessions, setSessions] = useState<readonly AgentSessionMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    setError(null);
    api
      .agentSessions()
      .then(({ sessions: list }) => {
        if (disposed) return;
        setSessions(list);
        // Preselect the most recently used session — the list arrives sorted —
        // so the common case is one tap: SEND.
        setSelected((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      disposed = true;
    };
  }, [visible]);

  const frames = status.frames;
  const send = useCallback(() => {
    if (!selected) return;
    const target = sessions?.find((s) => s.id === selected);
    setError(null);
    onSend(selected, note)
      .then((result) => {
        setNote('');
        onClose();
        onSent({ sessionId: selected, title: target?.title ?? 'the session', frames: result.frames || frames });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [selected, sessions, note, frames, onSend, onClose, onSent]);

  const discard = useCallback(() => {
    onDiscard();
    onClose();
  }, [onDiscard, onClose]);

  const none = sessions !== null && sessions.length === 0;
  const only = sessions !== null && sessions.length === 1 ? sessions[0] : null;

  return (
    <Sheet visible={visible} onClose={onClose} title="Send recording to Claude" testID="record-sheet">
      <Column gap="sm">
        <Caption>
          {`${status.frames} frame${status.frames === 1 ? '' : 's'} over ${status.seconds}s, held on the computer. Send saves them into the session's project and asks Claude to read them in order and describe what changes.`}
        </Caption>

        {none ? (
          <Column gap="xs">
            <Txt variant="label" tone="dim">No Claude sessions</Txt>
            <Caption>The recording is held on the computer. Start a session on the Agent tab, then come back and send it.</Caption>
            <Button
              testID="record-open-agent"
              label="Open the Agent tab"
              size="sm"
              onPress={() => {
                onClose();
                router.navigate('/agent');
              }}
            />
          </Column>
        ) : only ? (
          // One session means zero choices: name where the frames go, inertly
          // (§11.1 — not a choice, so it must not look like one), and get out
          // of the way of SEND.
          <Column gap="none" testID="record-only-session">
            <Micro tone="dim">To</Micro>
            <Txt variant="bodyStrong" numberOfLines={1}>{only.title}</Txt>
            <Micro tone="dim" numberOfLines={1}>{only.cwd}</Micro>
          </Column>
        ) : (
          <Column gap="xxs">
            {(sessions ?? []).map((session) => (
              <ListItem
                key={session.id}
                testID={`record-session-${session.id}`}
                title={session.title}
                subtitle={session.cwd}
                selected={session.id === selected}
                onPress={() => setSelected(session.id)}
              />
            ))}
          </Column>
        )}

        {!none ? (
          <Input
            testID="record-note"
            value={note}
            onChangeText={setNote}
            placeholder="Ask something specific instead (optional)"
            accessibilityLabel="Note for Claude about the recording"
          />
        ) : null}

        {error ? (
          <Txt variant="label" style={{ color: theme.colors.bad }}>{error}</Txt>
        ) : null}

        {/* Send is the sheet's one primary action, full width; discard is a
            red tracked label on its own line — impossible to hit reaching for
            SEND, and unmistakably destructive (§11.5). */}
        {!none ? (
          <Button
            testID="record-send"
            label={busy ? 'Sending…' : 'Send to Claude'}
            disabled={busy || !selected}
            onPress={send}
          />
        ) : null}
        <TrackLabel
          testID="record-discard"
          label="Discard recording"
          accessibilityLabel="Discard the recording without sending it"
          labelColor={theme.colors.bad}
          trackColor={theme.colors.bad}
          align="center"
          disabled={busy}
          onPress={discard}
          hitSlop={theme.layout.hitSlop}
          style={{ alignSelf: 'center', paddingVertical: theme.space.xs }}
        />
      </Column>
    </Sheet>
  );
}

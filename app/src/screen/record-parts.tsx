// The recording strip and the send sheet — everything the user sees of the
// host-side screen recorder besides the dock's REC key.
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

export interface RecordSheetProps {
  visible: boolean;
  onClose: () => void;
  status: RecordingStatus;
  busy: boolean;
  onSend: (sessionId: string, note?: string) => Promise<unknown>;
  onDiscard: () => void;
}

/**
 * The handoff: pick a Claude session, optionally say what to look for, send.
 * The frames are written into that session's project ON THE COMPUTER and the
 * prompt referencing them is queued there — nothing rides through the phone.
 */
export function RecordSheet({ visible, onClose, status, busy, onSend, onDiscard }: RecordSheetProps) {
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

  const send = useCallback(() => {
    if (!selected) return;
    setError(null);
    onSend(selected, note)
      .then(() => {
        setNote('');
        onClose();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [selected, note, onSend, onClose]);

  const discard = useCallback(() => {
    onDiscard();
    onClose();
  }, [onDiscard, onClose]);

  const none = sessions !== null && sessions.length === 0;

  return (
    <Sheet visible={visible} onClose={onClose} title="Send recording to Claude" testID="record-sheet">
      <Column gap="sm">
        <Caption>
          {`${status.frames} frame${status.frames === 1 ? '' : 's'} over ${status.seconds}s, captured on the computer. Sending saves them into the session's project folder and asks Claude to read every frame in order.`}
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
            placeholder="What should Claude look for? (optional)"
            accessibilityLabel="Note for Claude about the recording"
          />
        ) : null}

        {error ? (
          <Txt variant="label" style={{ color: theme.colors.bad }}>{error}</Txt>
        ) : null}

        <Row gap="sm">
          {!none ? (
            <Button
              testID="record-send"
              label={busy ? 'Sending…' : 'Send to Claude'}
              disabled={busy || !selected}
              onPress={send}
              style={{ flex: 1 }}
            />
          ) : null}
          <Button
            testID="record-discard"
            label="Discard recording"
            variant="secondary"
            disabled={busy}
            onPress={discard}
            style={{ flex: 1 }}
          />
        </Row>
      </Column>
    </Sheet>
  );
}

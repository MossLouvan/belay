// Watching a session that Claude Code is running from the computer's own
// terminal — no `--resume`, no takeover, no typing. The same feed the live
// session view renders, fed by /ws/transcript, with exactly one action at the
// bottom: while the terminal is driving, a dim line says so and there is no
// button; once it has gone quiet, "Take over from phone" attaches the
// session (the existing flow) and hands off to the normal SessionView.
//
// Ledger voice throughout: ‹ Back is a Label, the live mark is a mono micro
// label, the accent is spent only on LIVE and the one primary button.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import type { DiscoveredSession } from '../api';
import { useTheme } from '../theme';
import { SwitchComputerLink } from '../devices/switch-link';
import { Button, Caption, Dot, Label, Micro, Row, Rule, Txt } from '../ui';
import { EventRow } from './feed';
import { buildFeed } from './feed-model';
import { ago, projectName } from './model';
import { liveLabel, watchLine } from './transcript-model';
import { useTranscriptStream } from './transcript-stream';

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/** Re-date the "quiet · 4m ago" mark this often; the flag itself is pushed. */
const CLOCK_MS = 30_000;

export function TranscriptView({
  session: d,
  onBack,
  onTakeOver,
}: {
  session: DiscoveredSession;
  onBack: () => void;
  /** Called with Belay's session id once the attach succeeds. */
  onTakeOver: (id: string) => void;
}) {
  const theme = useTheme();
  const stream = useTranscriptStream(d.claudeSessionId);
  const { link, session, events, live, lastWriteAt, note, reconnect } = stream;
  const [taking, setTaking] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<ScrollView>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, [lastWriteAt]);

  const feed = useMemo(() => buildFeed(events), [events]);

  const takeOver = useCallback(async () => {
    if (taking) return;
    setTaking(true);
    setError('');
    try {
      const snap = await api.agentAttach(d.claudeSessionId, d.cwd, d.preview || undefined);
      if (mounted.current) onTakeOver(snap.id);
    } catch (e: unknown) {
      if (mounted.current) {
        setError(messageOf(e, 'could not take over that session'));
        setTaking(false);
      }
    }
  }, [taking, d, onTakeOver]);

  const margin = theme.layout.margin;
  const cwd = session?.cwd || d.cwd;
  const title = session?.preview || d.preview || projectName(cwd) || 'untitled session';
  const mode = watchLine(stream);
  const mark = liveLabel(live, lastWriteAt || d.lastWriteAt || d.mtime, now, ago);

  return (
    <View testID="agent-transcript" style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: margin, paddingTop: theme.space.xs, paddingBottom: theme.space.sm }}>
        <Row justify="space-between" gap="sm">
          <Pressable
            testID="agent-transcript-back"
            accessibilityRole="button"
            accessibilityLabel="Back to sessions"
            onPress={onBack}
            hitSlop={theme.layout.hitSlop}
            style={({ pressed }) => ({ paddingVertical: theme.space.xs, opacity: pressed ? theme.motion.pressOpacity : 1 })}
          >
            <Label tone="accent" style={{ marginBottom: 0 }}>‹ Back</Label>
          </Pressable>
          <SwitchComputerLink />
        </Row>
        <Txt variant="subheading" heading numberOfLines={1} style={{ marginTop: theme.space.xxs }}>
          {title}
        </Txt>
        <Row justify="space-between" gap="sm" style={{ marginTop: theme.space.xxs }}>
          <Txt variant="monoSmall" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{cwd}</Txt>
          {/* The one fact that decides the button below: is a terminal typing. */}
          <Row gap="xs">
            {live ? <Dot status="accent" ring size={7} /> : null}
            <Micro testID="agent-transcript-live" tone={live ? 'accent' : 'faint'}>{mark}</Micro>
          </Row>
        </Row>
      </View>
      <Rule />

      {link === 'closed' || link === 'error' ? (
        <View
          testID="agent-transcript-offline"
          style={{
            marginHorizontal: margin,
            marginTop: theme.space.sm,
            padding: theme.space.sm,
            gap: theme.space.xs,
            backgroundColor: theme.colors.badSoft,
            borderRadius: theme.radius.xs,
            borderLeftWidth: theme.layout.ruleEmphasis,
            borderLeftColor: theme.colors.bad,
          }}
        >
          <Txt variant="label" color={theme.colors.onBadSoft}>
            {link === 'error' ? 'Could not read the transcript' : 'Disconnected'}
          </Txt>
          <Txt variant="caption" tone="dim">
            {link === 'error' ? note || 'The host refused the transcript.' : 'Disconnected from the transcript on the PC.'}
          </Txt>
          <Button testID="agent-transcript-reconnect" label="Reconnect" onPress={reconnect} size="sm" variant="secondary" />
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        testID="agent-transcript-feed"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: margin, paddingVertical: theme.space.md, gap: theme.space.sm }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {link === 'connecting' && !session ? (
          <Row gap="sm">
            <ActivityIndicator color={theme.colors.accent} />
            <Caption>Opening the transcript…</Caption>
          </Row>
        ) : null}
        {session && events.length === 0 ? (
          <Caption>Nothing in this session yet.</Caption>
        ) : null}
        {feed.map((item, i) => <EventRow key={`${item.event.t}-${i}`} event={item.event} result={item.result} />)}
        {live ? <ActivityIndicator color={theme.colors.accent} style={{ alignSelf: 'flex-start' }} /> : null}
      </ScrollView>

      {error ? (
        <Micro testID="agent-transcript-error" tone="bad" style={{ marginHorizontal: margin, marginBottom: theme.space.xs }}>{error}</Micro>
      ) : null}

      {mode === 'watching' ? (
        // A terminal is driving: the phone watches. No button — two hands on
        // one session is the one thing this screen exists to prevent.
        <View testID="agent-transcript-watching" style={{ paddingHorizontal: margin, paddingVertical: theme.space.sm }}>
          <Micro tone="dim">Being driven from the computer — watching</Micro>
        </View>
      ) : null}

      {mode === 'quiet' ? (
        <View style={{ paddingHorizontal: margin, paddingVertical: theme.space.sm }}>
          <Button
            testID="agent-take-over"
            label="Take over from phone"
            onPress={() => void takeOver()}
            loading={taking}
            fullWidth
            accessibilityHint="Resumes this session in Belay with approvals on this phone"
          />
        </View>
      ) : null}
    </View>
  );
}

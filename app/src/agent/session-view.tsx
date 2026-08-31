// One open session: the live feed, the Allow / Deny / Always prompt whenever
// Claude wants to touch the machine, and the prompt composer with hold-to-talk.
// Nothing runs without a tap; the host fails closed on silence.
//
// The approval prompt is the highest-stakes UI in the app, so it gets the
// page's one warn-soft band (docs/DESIGN.md §8) and its Allow keeps the accent
// even while the session pulses — safety-relevant actions outrank the
// one-accent rule (§11.5).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { router } from 'expo-router';
import { Banner, Button, Caption, Dot, Label, Micro, Row, Rule, TrackLabel, Txt } from '../ui';
import { countdown, expiryUrgent } from './attention';
import { EventRow } from './feed';
import { buildFeed } from './feed-model';
import { MicButton, openVoiceSettings, useVoice } from './mic';
import { appendTranscript, canPrompt, isBusy, statusLabel, statusTone } from './model';
import { useAgentSession } from './session';

/** Above this the composer stops growing and scrolls instead. */
const COMPOSER_MAX_HEIGHT = 110;
/** Height of the tab bar plus header the keyboard must clear. */
const KEYBOARD_OFFSET = 90;

export function SessionView({ id, onBack }: { id: string; onBack: () => void }) {
  const theme = useTheme();
  const session = useAgentSession(id);
  const { snapshot, events, status, pending, link, note, prompt, approve, stop, reconnect, setNote } = session;
  const [input, setInput] = useState('');
  const [showInput, setShowInput] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const composerRef = useRef<TextInput>(null);

  // Voice streams the utterance's whole text on every interim result, so the
  // composer shows words as they are spoken. The base is what was typed before
  // the hold began: each callback replaces only the dictated tail, never the
  // user's own text.
  const voiceBase = useRef('');
  const inputNow = useRef(input);
  inputNow.current = input;
  const onTranscript = useCallback((text: string) => {
    setInput(appendTranscript(voiceBase.current, text));
  }, []);
  const voice = useVoice(onTranscript, setNote);
  const beginTalk = useCallback(() => {
    voiceBase.current = inputNow.current;
    voice.start();
  }, [voice.start]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (!canPrompt(session)) {
      setNote(link !== 'open' ? 'not connected to the session — reconnect first' : 'Claude is still working — stop it first or wait');
      return;
    }
    prompt(text);
    setInput('');
    // After sending from a phone you want the reply, not the keyboard — and a
    // multiline composer has no Done key, so Send is its one visible exit.
    composerRef.current?.blur();
  }, [input, link, prompt, session, setNote]);

  // The approval clock: ticks each second only while an ask has a deadline,
  // so the user sees the window shrinking instead of learning about it when
  // the host silently gives up.
  const deadline = pending?.expiresAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline]);

  const answer = useCallback((allow: boolean, always = false) => {
    if (!pending) return;
    setShowInput(false);
    approve(pending.id, allow, always);
  }, [approve, pending]);

  // Tool results ride the wire as their own events but render folded under
  // the calls that produced them; the pairing is pure and cheap, redone only
  // when the event list changes.
  const feed = useMemo(() => buildFeed(events), [events]);

  const busy = isBusy(status);
  const listening = voice.state === 'listening' || voice.state === 'starting';
  const margin = theme.layout.margin;
  const tone = statusTone(status);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
      keyboardVerticalOffset={KEYBOARD_OFFSET}
    >
      <View style={{ paddingHorizontal: margin, paddingTop: theme.space.xs, paddingBottom: theme.space.sm }}>
        <Row justify="space-between" gap="sm">
          <Pressable
            testID="agent-back"
            accessibilityRole="button"
            accessibilityLabel="Back to sessions"
            onPress={onBack}
            hitSlop={theme.layout.hitSlop}
            style={({ pressed }) => ({ paddingVertical: theme.space.xs, opacity: pressed ? theme.motion.pressOpacity : 1 })}
          >
            <Label tone="accent" style={{ marginBottom: 0 }}>‹ Back</Label>
          </Pressable>
          <Row gap="sm">
            {/* The other half of supervising from a phone: seeing what it did
                to the files, not only what it said it was doing. */}
            <TrackLabel
              testID="agent-changes"
              label="Changes"
              accessibilityHint="Shows what Claude changed in this project"
              onPress={() =>
                router.push({
                  pathname: '/changes',
                  params: {
                    session: id,
                    title: snapshot?.title ?? '',
                    cwd: snapshot?.cwd ?? '',
                  },
                })
              }
            />
            {busy ? <Button testID="agent-stop" label="Stop" size="sm" variant="danger" onPress={stop} /> : null}
          </Row>
        </Row>
        <Txt variant="subheading" heading numberOfLines={1} style={{ marginTop: theme.space.xxs }}>
          {snapshot?.title || '…'}
        </Txt>
        <Row gap="xs" style={{ marginTop: theme.space.xxs }}>
          <Dot
            status={link === 'open' ? (status === 'idle' ? 'neutral' : tone) : 'neutral'}
            pulse={status === 'running'}
            size={7}
          />
          <Label testID="agent-status" style={{ marginBottom: 0 }} tone={link === 'open' && status !== 'idle' ? tone : 'dim'}>
            {link === 'open' ? statusLabel(status) : link}
          </Label>
        </Row>
      </View>
      <Rule />

      {link === 'closed' || link === 'error' ? (
        <View
          testID="agent-offline"
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
            {link === 'error' ? 'Connection failed' : 'Disconnected'}
          </Txt>
          <Txt variant="caption" tone="dim">
            {link === 'error' ? note || 'The session connection failed.' : 'Disconnected from the session on the PC.'}
          </Txt>
          <Button testID="agent-reconnect" label="Reconnect" onPress={reconnect} size="sm" variant="secondary" />
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        testID="agent-feed"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: margin, paddingVertical: theme.space.md, gap: theme.space.sm }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {link === 'connecting' && !snapshot ? (
          <Row gap="sm">
            <ActivityIndicator color={theme.colors.accent} />
            <Caption>Opening the session…</Caption>
          </Row>
        ) : null}
        {snapshot && events.length === 0 ? (
          <Caption>
            {`Tell Claude what to do in ${snapshot.cwd || 'this project'}. It plans, edits and runs things on the PC — and every action stops here for your approval first.`}
          </Caption>
        ) : null}
        {feed.map((item, i) => <EventRow key={`${item.event.t}-${i}`} event={item.event} result={item.result} />)}
        {status === 'running' ? <ActivityIndicator color={theme.colors.accent} style={{ alignSelf: 'flex-start' }} /> : null}
      </ScrollView>

      {pending ? (
        <View
          testID="agent-ask"
          style={{
            marginHorizontal: margin,
            marginBottom: theme.space.xs,
            padding: theme.space.sm,
            gap: theme.space.xs,
            backgroundColor: theme.colors.warnSoft,
            borderRadius: theme.radius.xs,
            borderLeftWidth: theme.layout.ruleEmphasis,
            borderLeftColor: theme.colors.warn,
          }}
        >
          <Row justify="space-between" gap="sm">
            <Txt variant="label" color={theme.colors.onWarnSoft}>Approval needed</Txt>
            {deadline !== undefined ? (
              <Micro testID="agent-ask-countdown" tone={expiryUrgent(deadline, now) ? 'bad' : 'dim'}>
                {`auto-denies in ${countdown(deadline, now)}`}
              </Micro>
            ) : null}
          </Row>
          <Txt variant="mono" selectable numberOfLines={showInput ? undefined : 3}>
            <Txt variant="mono" tone="accent">{pending.tool}</Txt>
            {pending.detail ? `  ${pending.detail}` : ''}
          </Txt>
          {showInput ? (
            <ScrollView
              style={{ maxHeight: 140, backgroundColor: theme.colors.surface, borderRadius: theme.radius.xs }}
              contentContainerStyle={{ padding: theme.space.sm }}
              nestedScrollEnabled
            >
              <Txt variant="monoSmall" tone="dim" selectable>{pending.input}</Txt>
            </ScrollView>
          ) : (
            <Pressable
              testID="agent-ask-expand"
              accessibilityRole="button"
              accessibilityLabel="Show the full tool input"
              onPress={() => setShowInput(true)}
              hitSlop={theme.layout.hitSlop}
            >
              <Label style={{ marginBottom: 0 }}>Show full input ▾</Label>
            </Pressable>
          )}
          <Row gap="xs">
            <Button testID="agent-deny" label="Deny" variant="danger" size="sm" onPress={() => answer(false)} style={{ flex: 1 }} />
            <Button testID="agent-allow" label="Allow" size="sm" onPress={() => answer(true)} style={{ flex: 1 }} />
            <Button
              testID="agent-always"
              label={`Always ${pending.tool}`}
              variant="secondary"
              size="sm"
              accessibilityHint="Allows this tool for the rest of this session without asking"
              onPress={() => answer(true, true)}
              style={{ flex: 1.3 }}
            />
          </Row>
        </View>
      ) : null}

      {note && link === 'open' ? (
        <Banner
          testID="agent-note"
          status="warn"
          message={note}
          // A denied permission can only be fixed in the Settings app, so the
          // banner carries the door rather than leaving a dead-end error line.
          action={voice.needsSettings ? { label: 'Open Settings', onPress: openVoiceSettings } : undefined}
          style={{ marginHorizontal: margin, marginBottom: theme.space.xs }}
        />
      ) : null}

      <Rule />
      <View style={{ paddingHorizontal: margin, paddingVertical: theme.space.sm }}>
        <Row gap="sm" align="flex-end">
          <MicButton testID="agent-mic" state={voice.state} onStart={beginTalk} onStop={voice.stop} disabled={link !== 'open'} />
          <TextInput
            ref={composerRef}
            testID="agent-input"
            value={input}
            onChangeText={setInput}
            placeholder={listening ? 'Listening…' : link === 'open' ? 'Tell Claude what to do…' : 'Not connected'}
            placeholderTextColor={listening ? theme.colors.accent : theme.colors.textFaint}
            multiline
            accessibilityLabel="Prompt for Claude"
            maxFontSizeMultiplier={1.4}
            style={{
              flex: 1,
              maxHeight: COMPOSER_MAX_HEIGHT,
              minHeight: theme.layout.minTouch,
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.xs,
              borderWidth: listening ? theme.layout.ruleEmphasis : theme.layout.hairline,
              borderColor: listening ? theme.colors.focus : theme.colors.border,
              color: theme.colors.text,
              paddingHorizontal: theme.space.sm,
              paddingVertical: theme.space.sm,
              fontSize: 15,
              lineHeight: 20,
            }}
          />
          <Button
            testID="agent-send"
            label="Send"
            size="sm"
            onPress={send}
            disabled={!input.trim() || !canPrompt(session)}
            hapticTone="medium"
            accessibilityLabel="Send the prompt"
          />
        </Row>
      </View>
    </KeyboardAvoidingView>
  );
}

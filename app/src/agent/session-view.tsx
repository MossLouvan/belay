// One open session: the live feed, the Allow / Deny / Always card whenever
// Claude wants to touch the machine, and the prompt composer with hold-to-talk.
// Nothing runs without a tap; the host fails closed on silence.

import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { Badge, Banner, Button, Caption, Card, Dot, IconButton, Label, Row, Txt } from '../ui';
import { EventRow } from './feed';
import { MicButton, useVoice } from './mic';
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

  const onTranscript = useCallback((text: string) => setInput((prev) => appendTranscript(prev, text)), []);
  const voice = useVoice('/transcribe', onTranscript, setNote);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    if (!canPrompt(session)) {
      setNote(link !== 'open' ? 'not connected to the session — reconnect first' : 'Claude is still working — stop it first or wait');
      return;
    }
    prompt(text);
    setInput('');
  }, [input, link, prompt, session, setNote]);

  const answer = useCallback((allow: boolean, always = false) => {
    if (!pending) return;
    setShowInput(false);
    approve(pending.id, allow, always);
  }, [approve, pending]);

  const busy = isBusy(status);
  const canvas = theme.isDark ? theme.colors.black : theme.colors.surface;
  const recording = voice.state === 'recording';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
      keyboardVerticalOffset={KEYBOARD_OFFSET}
    >
      <Row justify="space-between" gap="sm" style={{ paddingHorizontal: theme.space.md, paddingBottom: theme.space.xs }}>
        <Row gap="xs" style={{ flex: 1 }}>
          <Pressable
            testID="agent-back"
            accessibilityRole="button"
            accessibilityLabel="Back to sessions"
            onPress={onBack}
            hitSlop={theme.layout.hitSlop}
            style={({ pressed }) => ({ paddingVertical: 6, paddingRight: 4, opacity: pressed ? 0.6 : 1 })}
          >
            <Txt variant="bodyStrong" tone="accent">‹ Back</Txt>
          </Pressable>
          <Dot status={link === 'open' ? statusTone(status) : 'neutral'} pulse={status === 'running'} label={statusLabel(status)} />
          <Txt variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>{snapshot?.title || '…'}</Txt>
        </Row>
        <Row gap="xs">
          <Badge testID="agent-status" label={link === 'open' ? statusLabel(status) : link} status={link === 'open' ? (status === 'idle' ? 'neutral' : statusTone(status)) : 'neutral'} />
          {busy ? <Button testID="agent-stop" label="Stop" size="sm" variant="danger" onPress={stop} /> : null}
        </Row>
      </Row>

      {link === 'closed' || link === 'error' ? (
        <Row
          testID="agent-offline"
          gap="sm"
          style={{
            marginHorizontal: theme.space.sm,
            marginBottom: theme.space.xs,
            padding: theme.space.sm,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.badSoft,
          }}
        >
          <Txt variant="caption" color={theme.colors.onBadSoft} style={{ flex: 1, fontWeight: '700' }}>
            {link === 'error' ? note || 'The session connection failed.' : 'Disconnected from the session.'}
          </Txt>
          <Button testID="agent-reconnect" label="Reconnect" onPress={reconnect} size="sm" variant="secondary" />
        </Row>
      ) : null}

      <ScrollView
        ref={scrollRef}
        testID="agent-feed"
        style={{
          flex: 1,
          marginHorizontal: theme.space.sm,
          backgroundColor: canvas,
          borderRadius: theme.radius.md,
          borderWidth: theme.layout.hairline,
          borderColor: theme.colors.border,
        }}
        contentContainerStyle={{ padding: theme.space.md, gap: theme.space.sm }}
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
        {events.map((event, i) => <EventRow key={`${event.t}-${i}`} event={event} />)}
        {status === 'running' ? <ActivityIndicator color={theme.colors.accent} style={{ alignSelf: 'flex-start' }} /> : null}
      </ScrollView>

      {pending ? (
        <Card
          testID="agent-ask"
          padding="sm"
          elevation="md"
          style={{ marginHorizontal: theme.space.sm, marginTop: theme.space.sm, borderColor: theme.colors.accent }}
        >
          <Label>Claude wants to run</Label>
          <Txt variant="mono" selectable numberOfLines={showInput ? undefined : 3} style={{ marginBottom: theme.space.xs }}>
            <Txt variant="mono" tone="accent" style={{ fontWeight: '700' }}>{pending.tool}</Txt>
            {pending.detail ? `  ${pending.detail}` : ''}
          </Txt>
          {showInput ? (
            <ScrollView
              style={{ maxHeight: 140, backgroundColor: canvas, borderRadius: theme.radius.sm, marginBottom: theme.space.xs }}
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
              style={{ marginBottom: theme.space.xs }}
            >
              <Caption>show full input ▾</Caption>
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
        </Card>
      ) : null}

      {note && link === 'open' ? (
        <Banner testID="agent-note" status="warn" message={note} style={{ marginHorizontal: theme.space.sm, marginTop: theme.space.xs }} />
      ) : null}

      <View style={{ padding: theme.space.sm, gap: theme.space.xs }}>
        <Row gap="sm" align="flex-end">
          <MicButton testID="agent-mic" state={voice.state} onPressIn={voice.start} onPressOut={voice.stop} disabled={link !== 'open'} />
          <TextInput
            testID="agent-input"
            value={input}
            onChangeText={setInput}
            placeholder={recording ? 'Listening…' : link === 'open' ? 'Tell Claude what to do…' : 'Not connected'}
            placeholderTextColor={recording ? theme.colors.accent : theme.colors.textFaint}
            multiline
            accessibilityLabel="Prompt for Claude"
            maxFontSizeMultiplier={1.4}
            style={{
              flex: 1,
              maxHeight: COMPOSER_MAX_HEIGHT,
              minHeight: theme.layout.minTouch,
              backgroundColor: theme.colors.surfaceAlt,
              borderRadius: theme.radius.md,
              borderWidth: recording ? 2 : theme.layout.hairline,
              borderColor: recording ? theme.colors.accent : theme.colors.borderStrong,
              color: theme.colors.text,
              paddingHorizontal: theme.space.md,
              paddingVertical: theme.space.sm + 2,
              fontSize: 15,
              lineHeight: 20,
            }}
          />
          <IconButton
            testID="agent-send"
            accessibilityLabel="Send the prompt"
            variant="accent"
            onPress={send}
            disabled={!input.trim() || !canPrompt(session)}
            hapticTone="medium"
          >
            <Text allowFontScaling={false} style={{ color: theme.colors.onAccentSoft, fontSize: 18, fontWeight: '800' }}>↑</Text>
          </IconButton>
        </Row>
      </View>
    </KeyboardAvoidingView>
  );
}

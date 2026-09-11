// A pty-backed agent session: the real `claude` on the computer, drawn on the
// phone, with the phone as one attached client among however many.
//
// There is no second terminal renderer here. The screen is the Terminal tab's
// machinery — `terminal-ansi` parses, `terminal-output` draws, `terminal-keys`
// supplies the Esc / Tab / Ctrl / arrows a phone keyboard does not have — and
// this file is the part that is specific to sharing one pty: the header that
// says who else is attached and why the screen may be narrower than this
// phone can draw, and the states behind a session that ended or refused.
//
// Everything that decides anything lives in `attach-model.ts` and
// `attach-session.ts`; what is left here is layout.

import React, { useCallback, useRef, useState } from 'react';
import {
  FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, TextInput, View,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../theme';
import { SwitchComputerLink } from '../devices/switch-link';
import { Button, Dot, IconButton, Label, Micro, Row, Rule, TrackLabel, Txt } from '../ui';
import type { GlassStateProps } from '../ui';
import { useKeyboardShown } from '../ui/keyboard-lift';
import { ANSI_RAMPS } from '../terminal-ansi';
import type { TermLine } from '../terminal-ansi';
import { KeyBar } from '../terminal-keys';
import { TerminalOutput } from '../terminal-output';
import { useTerminalGeometry } from '../terminal-geometry';
import { useAgentAttach } from './attach-session';
import { useAttachedCount } from './attached-count';
import { attachedNote, linkLabel, sizeNote } from './attach-model';

const LINE_HEIGHT_RATIO = 1.45;
/** How close to the bottom still counts as "following" the output. */
const FOLLOW_SLACK_PX = 24;

type FontKey = 'sm' | 'md' | 'lg';
const FONT_SIZES: Readonly<Record<FontKey, number>> = { sm: 11, md: 12.5, lg: 15 };
const NEXT_FONT: Readonly<Record<FontKey, FontKey>> = { sm: 'md', md: 'lg', lg: 'sm' };
const FONT_NAMES: Readonly<Record<FontKey, string>> = { sm: 'small', md: 'medium', lg: 'large' };

export interface PtySessionViewProps {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  /**
   * Clients attached as the session list last saw it. The handshake's own
   * count is a snapshot taken when this phone attached and never moves again,
   * so somebody joining afterwards is only visible through this.
   */
  readonly attached?: number;
  readonly onBack: () => void;
}

export function PtySessionView({ id, title, cwd, attached, onBack }: PtySessionViewProps) {
  const theme = useTheme();
  const keyboardUp = useKeyboardShown();
  const [fontKey, setFontKey] = useState<FontKey>('md');
  const [input, setInput] = useState('');
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const listRef = useRef<FlatList<TermLine>>(null);
  followingRef.current = following;

  const fontSize = FONT_SIZES[fontKey];
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
  const padding = theme.space.sm;
  // The transcript is a machine panel: true-dark in both themes, so it always
  // takes the dark ANSI ramp (docs/DESIGN.md §3.4).
  const canvas = theme.colors.machine;

  const { geometry, onRowWidth, onProbeWidth, onOutputLayout } = useTerminalGeometry(
    fontSize, lineHeight, padding,
  );
  const { state, term, send, clear, reattach } = useAgentAttach(id, geometry);

  const scrollToEnd = useCallback(() => listRef.current?.scrollToEnd({ animated: false }), []);
  const follow = useCallback(() => {
    setFollowing(true);
    scrollToEnd();
  }, [scrollToEnd]);
  const onContentSizeChange = useCallback(() => {
    if (followingRef.current) scrollToEnd();
  }, [scrollToEnd]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setFollowing(distance <= FOLLOW_SLACK_PX);
  }, []);

  /** TYPE: exactly the field's text, no return — it lands in Claude's prompt box. */
  const typeInput = useCallback(() => {
    if (input.length === 0) return;
    setInput('');
    setFollowing(true);
    send(input);
  }, [input, send]);

  /** RUN: the text plus return. With the field empty it is just the return. */
  const runInput = useCallback(() => {
    setInput('');
    setFollowing(true);
    send(`${input}\r`);
  }, [input, send]);

  // Tab belongs to the session, not to this screen: the real CLI is on the far
  // end and does its own completion, so there is no dance to run here.
  const rawTab = useCallback(() => send('\t'), [send]);
  // Arrows go raw for the same reason; there is no local history to recall.
  const noHistory = useCallback(() => {}, []);

  const live = state.link === 'open' && state.ready;
  const blank = term.lines.length <= 1 && (term.lines[0]?.chars.length ?? 0) === 0;
  // Somebody joining after this phone attached is invisible on the socket, so
  // the count is polled while the screen is live (attached-count.ts).
  const clients = useAttachedCount(id, live, attached);
  const shrunk = sizeNote(state, clients);
  const others = attachedNote(state, clients);

  const glass: Omit<GlassStateProps, 'style' | 'testID'> | null = (() => {
    if (state.link === 'exited') {
      return {
        status: 'dim',
        name: 'Session ended',
        body: 'The Claude session on the computer exited. Attaching again starts a fresh one in this folder.',
        action: { label: 'Start again', onPress: reattach },
      };
    }
    if (state.link === 'error') {
      return {
        status: 'bad',
        name: 'Could not attach',
        body: state.note || 'The computer refused the attach.',
        action: { label: 'Try again', onPress: reattach },
      };
    }
    if (state.link === 'closed' || state.link === 'connecting') {
      return {
        status: 'dim',
        name: state.retries > 0 ? 'Reattaching' : 'Attaching',
        // Never a dead screen: the host replays the scrollback on attach, so
        // the promise made here is one the reconnect actually keeps.
        body: 'Joining the session on the computer. Everything on its screen comes back as soon as it answers.',
      };
    }
    if (live && blank) {
      return {
        status: 'dim',
        name: 'Attached',
        body: `The session is running in ${cwd || 'this project'}. Type below — you are at its terminal.`,
        proof: '> _',
      };
    }
    return null;
  })();

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: theme.space.xs, paddingBottom: theme.space.sm }}>
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
            <TrackLabel
              testID="agent-changes"
              label="Changes"
              accessibilityHint="Shows what Claude changed in this project"
              onPress={() => router.push({ pathname: '/changes', params: { session: id, title, cwd } })}
            />
            {!live ? (
              <Button testID="agent-reattach" label="Reattach" size="sm" variant="secondary" onPress={reattach} />
            ) : null}
          </Row>
        </Row>
        <Txt variant="subheading" heading numberOfLines={1} style={{ marginTop: theme.space.xxs }}>
          {state.session?.title || title || '…'}
        </Txt>
        <Row justify="space-between" gap="sm" style={{ marginTop: theme.space.xxs }}>
          <Row gap="xs" style={{ flexShrink: 1 }}>
            <Dot status={live ? 'good' : 'neutral'} size={7} />
            <Label testID="agent-attach-link" style={{ marginBottom: 0 }} tone={live ? 'dim' : 'warn'}>
              {linkLabel(state)}
            </Label>
            {/* Someone else is looking at this — the one fact about a shared
                pty that changes what you should do next. */}
            {others ? <Micro testID="agent-attached" tone="accent">{others}</Micro> : null}
          </Row>
          <SwitchComputerLink />
        </Row>
        {/* Quietly, and only when true: the screen is this narrow because
            another attached client is smaller, not because the phone is. */}
        {shrunk ? (
          <Micro testID="agent-size-note" tone="dim" style={{ marginTop: theme.space.xxs }}>{shrunk}</Micro>
        ) : null}
      </View>

      <Rule />
      <TerminalOutput
        listRef={listRef}
        lines={term.lines}
        ramp={ANSI_RAMPS.dark}
        redraw={fontKey}
        fontSize={fontSize}
        lineHeight={lineHeight}
        padding={padding}
        canvas={canvas}
        glass={glass}
        cursor={live ? { row: term.row, col: term.col } : null}
        following={following}
        onFollow={follow}
        onRowWidth={onRowWidth}
        onProbeWidth={onProbeWidth}
        onOutputLayout={onOutputLayout}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
      />
      <Rule />

      <View style={{ paddingTop: theme.space.xs, paddingBottom: theme.space.sm, gap: theme.space.xs }}>
        <KeyBar
          onSend={send}
          onClear={clear}
          onHistory={noHistory}
          onTab={rawTab}
          ptyMode
          onFontCycle={() => setFontKey((k) => NEXT_FONT[k])}
          fontLabel={FONT_NAMES[fontKey]}
        />
        <Row gap="sm" style={{ paddingHorizontal: theme.layout.margin }}>
          <Txt variant="mono" tone="dim" style={{ fontSize: 16 }}>›</Txt>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <TextInput
              testID="agent-pty-input"
              value={input}
              onChangeText={setInput}
              placeholder={live ? 'Type into the session…' : 'Not attached'}
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={typeInput}
              accessibilityLabel="Session input"
              maxFontSizeMultiplier={1.4}
              style={{
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xs,
                borderWidth: theme.layout.hairline,
                borderColor: theme.colors.border,
                color: theme.colors.text,
                fontFamily: theme.font.mono,
                paddingLeft: theme.space.md,
                paddingRight: keyboardUp ? theme.layout.minTouch : theme.space.md,
                minHeight: theme.layout.minTouch,
                fontSize: 14,
              }}
            />
            {/* The keyboard is a state and needs a visible exit (§11.2);
                return TYPEs the line and deliberately keeps focus. */}
            {keyboardUp ? (
              <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center' }}>
                <IconButton
                  testID="agent-pty-hide-keyboard"
                  accessibilityLabel="Hide the keyboard"
                  variant="plain"
                  onPress={() => Keyboard.dismiss()}
                >
                  <Txt variant="label" tone="dim">⌄</Txt>
                </IconButton>
              </View>
            ) : null}
          </View>
          <Button
            testID="agent-pty-type"
            label="Type"
            onPress={typeInput}
            size="sm"
            accessibilityHint="Sends the text to the session without pressing return"
          />
          <Button
            testID="agent-pty-run"
            label="Run"
            variant="secondary"
            onPress={runInput}
            size="sm"
            accessibilityHint="Sends the text and presses return; with the field empty, just presses return"
          />
        </Row>
      </View>
    </KeyboardAvoidingView>
  );
}

// Terminal. A WebSocket to the host's shell.
//
// Output is parsed by `src/terminal-ansi` into a styled screen buffer, so SGR
// colour, `\r` overwrites and `clear` all behave instead of leaking escape
// codes into the transcript. Below the transcript sits a key accessory bar
// (`src/terminal-keys`), because a phone keyboard has no Esc, Tab, Ctrl,
// arrows, pipe or tilde and a terminal without them is close to unusable.
//
// `cols`/`rows` are derived from the measured viewport (`src/terminal-geometry`)
// and a `resize` is sent whenever they change — a wrong size makes anything
// that draws a full screen render garbage.
//
// The shell itself — socket, screen buffer, history — lives in
// `src/terminal/session-store`, not here: the bottom bar replaces this route
// on every tab switch, and a shell owned by the route died with it (#90).

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  FlatList,
  Keyboard,
  NativeScrollEvent,
  NativeSyntheticEvent,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { SwitchComputerLink } from '../../src/devices/switch-link';
import { wsUrl } from '../../src/api';
import { Banner, Button, IconButton, Row, Rule, Txt, StatusBadge } from '../../src/ui';
import type { GlassStateProps } from '../../src/ui';
import { useKeyboardShown } from '../../src/ui/keyboard-lift';
import { useTheme } from '../../src/theme';
import { ANSI_RAMPS } from '../../src/terminal-ansi';
import type { TermLine } from '../../src/terminal-ansi';
import { KeyBar } from '../../src/terminal-keys';
import { TerminalOutput } from '../../src/terminal-output';
import { useTerminalGeometry, DEFAULT_GEOMETRY } from '../../src/terminal-geometry';
import type { Geometry } from '../../src/terminal-geometry';
import type { ServerMessage } from '../../src/terminal-session';
import {
  clearTerm, ensureTermSession, getTermSession, postTerm, pushTermHistory, reopenTermSession, sendTerm,
  setTermCompletionHandler, setTermGeometry, subscribeTermSession,
} from '../../src/terminal/session-store';
import { applyCandidate, parseCompletion } from '../../src/terminal/complete';
import { planTab, trackPrimed } from '../../src/terminal/primed';
import { CandidateRow } from '../../src/terminal/candidate-row';
import { TerminalHelpSheet } from '../../src/terminal/help-sheet';
import { ToolPanel } from '../../src/home/panel';

// --- constants ---------------------------------------------------------------

const LINE_HEIGHT_RATIO = 1.45;
const RESIZE_DEBOUNCE_MS = 200;
/** How close to the bottom still counts as "following" the output. */
const FOLLOW_SLACK_PX = 24;
/**
 * Below this window height (a phone in landscape) the title row and the pipe
 * banner are dropped so the transcript keeps rows to show (#91); the pipe
 * fact moves into the status badge.
 */
const SHORT_VIEWPORT_PX = 500;
/** Longer than the host's own completion ceiling plus a network round trip, so
    a reply that will ever come is never abandoned — but a host agent built
    before completion existed (which ignores the request entirely) releases the
    key in a couple of seconds instead of hanging it. */
const COMPLETE_TIMEOUT_MS = 2500;
const TAB_NOTICE_MS = 5000;
const PIPE_TAB_NOTICE =
  'NO COMPLETION — the host shell has no TTY, so tab has nothing to ask. Update Belay on your computer, then restart it.';

type FontKey = 'sm' | 'md' | 'lg';
const FONT_SIZES: Readonly<Record<FontKey, number>> = { sm: 11, md: 12.5, lg: 15 };
const NEXT_FONT: Readonly<Record<FontKey, FontKey>> = { sm: 'md', md: 'lg', lg: 'sm' };
const FONT_NAMES: Readonly<Record<FontKey, string>> = { sm: 'small', md: 'medium', lg: 'large' };

// --- screen ------------------------------------------------------------------

/** The panel route: the unchanged tab body inside the shared slide-up chrome. */
export default function TerminalPanel() {
  return (
    <ToolPanel tab="terminal" testID="terminal-panel">
      <TerminalTab />
    </ToolPanel>
  );
}

function TerminalTab() {
  const { connection, phase } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // The keyboard is a state and needs a visible exit (docs/DESIGN.md §11.2).
  // The key bar's `⌄ hide` key exists but lives at the end of a horizontally
  // scrolling row, and the transcript's drag-to-dismiss is invisible — so the
  // field itself carries a trailing dismiss while the keyboard is up, the
  // same idiom as the Screen tab's TYPE row.
  const keyboardUp = useKeyboardShown();
  const short = useWindowDimensions().height < SHORT_VIEWPORT_PX;

  const { term, status, mode, error, history } = useSyncExternalStore(subscribeTermSession, getTermSession, getTermSession);
  const [input, setInput] = useState('');
  const [fontKey, setFontKey] = useState<FontKey>('md');
  const [following, setFollowing] = useState(true);
  const [candidates, setCandidates] = useState<readonly string[] | null>(null);
  const [completing, setCompleting] = useState(false);
  const [tabNotice, setTabNotice] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  const geometryRef = useRef<Geometry>(DEFAULT_GEOMETRY);
  const followingRef = useRef(true);
  const listRef = useRef<FlatList<TermLine>>(null);
  const historyIndex = useRef<number>(-1);
  const inputRef = useRef('');
  /** Whether the shell's line buffer is believed to hold text — the ledger
      TYPE writes to and tab reads from (src/terminal/primed.ts). A ref, not
      state: it changes inside `send`, and nothing renders from it. */
  const primedRef = useRef(false);
  const completionSeq = useRef(0);
  const pendingCompletion = useRef<{ id: string; sent: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionHandler = useRef<(msg: ServerMessage) => void>(() => {});

  const fontSize = FONT_SIZES[fontKey];
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
  // The transcript is a machine panel: true-dark in BOTH themes, so it always
  // takes the dark ANSI ramp — there is no ANSI-on-light palette to maintain
  // any more (docs/DESIGN.md §3.4).
  const canvas = theme.colors.machine;
  const OUTPUT_PADDING = theme.space.sm;
  const ramp = ANSI_RAMPS.dark;

  const { geometry, onRowWidth, onProbeWidth, onOutputLayout } = useTerminalGeometry(
    fontSize,
    lineHeight,
    OUTPUT_PADDING
  );

  // Mirrors of state that the WebSocket callbacks and the flush timer need to
  // read without being re-created — those closures outlive a single render.
  geometryRef.current = geometry;
  followingRef.current = following;
  inputRef.current = input;

  // --- session ---------------------------------------------------------------

  /** The upgrade URL needs a single-use ticket first, so opening is async. */
  const openShell = useCallback(() => {
    const { cols, rows } = geometryRef.current;
    return wsUrl('/ws/terminal', { cols, rows }).then((url) => new WebSocket(url));
  }, []);

  // Keyed on the host: a tab round trip or a reconnect to the same computer
  // finds the shell still running; a different computer gets a fresh one.
  const host = connection?.host ?? null;
  useEffect(() => {
    if (host === null) return;
    ensureTermSession(host, openShell);
  }, [host, openShell]);

  // Routed through a ref: the store holds one handler, but the dance needs
  // the render-current input and pending state.
  useEffect(() => {
    setTermCompletionHandler((msg) => completionHandler.current(msg));
    return () => {
      setTermCompletionHandler(() => {});
      // A dance cannot outlive this screen: the reply would land nowhere.
      if (pendingCompletion.current) {
        clearTimeout(pendingCompletion.current.timer);
        pendingCompletion.current = null;
      }
    };
  }, []);

  const send = useCallback((data: string) => {
    // Every keystroke that reaches the shell updates the primed ledger —
    // the key bar's letters and arrows included, since an up-arrow can pull
    // a whole history line into the shell's buffer without this screen
    // typing a thing.
    if (sendTerm(data)) primedRef.current = trackPrimed(primedRef.current, data);
  }, []);

  /** Sends an arbitrary control message; `send` above stays keystrokes-only. */
  const post = useCallback((message: object): boolean => postTerm(message), []);

  // --- tab completion --------------------------------------------------------
  //
  // The input is a line buffer of its own, so completion is a negotiated dance
  // with the shell (see src/terminal/complete.ts and the host's
  // terminal-complete.ts): the host replays the line into the pty, taps tab,
  // captures the echo, and empties the shell's line again. Because the shell
  // always ends empty, this TextInput is the only line buffer that persists —
  // the two can never drift, whatever the shell answered.
  //
  // TYPE deliberately violates that emptiness — it parks text at the shell's
  // prompt with no return — so the dance is gated on the primed ledger
  // (src/terminal/primed.ts): once the shell's buffer holds anything, tab
  // flushes the field and goes through raw, and the shell's own completion
  // does the work in the transcript instead.

  const showTabNotice = useCallback((message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setTabNotice(message);
    noticeTimer.current = setTimeout(() => setTabNotice(''), TAB_NOTICE_MS);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const requestComplete = useCallback(() => {
    // §11.4: a Tab that cannot work says so and names the way forward, rather
    // than being a key that silently does nothing.
    if (mode === 'pipe') {
      showTabNotice(PIPE_TAB_NOTICE);
      return;
    }
    if (status !== 'open' || pendingCompletion.current) return;
    const plan = planTab(input, primedRef.current);
    // An empty field has nothing to complete; pass the tab through raw so a
    // full-screen program driven from the key bar still receives it.
    if (plan.kind === 'passthrough') {
      send(plan.data);
      return;
    }
    // The shell already holds part of the line (a TYPE, a history recall):
    // the dance would replay this field on top of it and Ctrl-U the lot away,
    // so the field joins the shell's line instead and the tab goes through
    // raw — the shell's own completion answers, visibly, at its prompt.
    if (plan.kind === 'flush') {
      setInput('');
      setCandidates(null);
      setFollowing(true);
      send(plan.data);
      return;
    }
    const id = String(++completionSeq.current);
    const timer = setTimeout(() => {
      if (pendingCompletion.current?.id !== id) return;
      pendingCompletion.current = null;
      setCompleting(false);
      showTabNotice(
        "COMPLETION TIMED OUT — the shell didn't answer, so the line was left as you typed it. An older host agent may not support completion yet.",
      );
    }, COMPLETE_TIMEOUT_MS);
    pendingCompletion.current = { id, sent: input, timer };
    setCompleting(true);
    setCandidates(null);
    if (!post({ type: 'complete', id, text: input })) {
      clearTimeout(timer);
      pendingCompletion.current = null;
      setCompleting(false);
    }
  }, [input, mode, post, send, showTabNotice, status]);

  const handleCompletion = useCallback((msg: ServerMessage) => {
    const pending = pendingCompletion.current;
    if (!pending || msg.id !== pending.id) return;
    clearTimeout(pending.timer);
    pendingCompletion.current = null;
    setCompleting(false);
    if (msg.status === 'unsupported') {
      showTabNotice(PIPE_TAB_NOTICE);
      return;
    }
    if (msg.status !== 'ok') return;
    // The line moved on while the shell was thinking; a completion of the old
    // text splicing into the new one is exactly the desync this design bans.
    if (inputRef.current !== pending.sent) return;
    const result = parseCompletion(pending.sent, msg.raw ?? '');
    if (result.kind === 'line') {
      setInput(result.line);
    } else if (result.kind === 'candidates') {
      setInput(result.line);
      setCandidates(result.candidates);
    } else if (result.kind === 'unreadable') {
      showTabNotice(
        "COMPLETION UNREADABLE — the shell answered with a full-screen redraw this input can't follow; the line was left as typed.",
      );
    } else {
      showTabNotice('NO MATCH — the shell found nothing to complete here.');
    }
  }, [showTabNotice]);
  completionHandler.current = handleCompletion;

  const pickCandidate = useCallback((candidate: string) => {
    setCandidates(null);
    setInput((current) => applyCandidate(current, candidate));
  }, []);

  const onChangeInput = useCallback((text: string) => {
    setInput(text);
    // Any edit stales the offered list — it answered a line that no longer exists.
    setCandidates(null);
  }, []);

  // Resize is debounced: rotation and font changes fire a burst of layouts.
  // The parser wraps at the new width at once; the host hears about it after
  // the burst settles. A socket that closed mid-debounce is handled by onclose.
  useEffect(() => {
    setTermGeometry(geometry);
    if (status !== 'open') return undefined;
    const timer = setTimeout(() => postTerm({ type: 'resize', ...geometry }), RESIZE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [geometry, status]);

  // --- interaction -----------------------------------------------------------

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setFollowing(distance <= FOLLOW_SLACK_PX);
  }, []);

  const scrollToEnd = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: false });
  }, []);

  const follow = useCallback(() => {
    setFollowing(true);
    scrollToEnd();
  }, [scrollToEnd]);

  const onContentSizeChange = useCallback(() => {
    if (followingRef.current) scrollToEnd();
  }, [scrollToEnd]);

  /** TYPE, the field's primary action: exactly the field's text, no return.
      The bytes land in the shell's line buffer (or in vim, less, a prompt —
      wherever is reading), where tab can finish them or more typing can join
      them. Nothing executes until RUN or the key bar's ⏎ says so. */
  const typeInput = useCallback(() => {
    if (input.length === 0) return;
    setInput('');
    setCandidates(null);
    setFollowing(true);
    send(input);
  }, [input, send]);

  /** RUN: the field's text plus return. With the field empty it is just the
      return — the way a line already parked at the prompt by TYPE gets run. */
  const runInput = useCallback(() => {
    const command = input;
    if (command.length > 0) pushTermHistory(command);
    historyIndex.current = -1;
    setInput('');
    setCandidates(null);
    setFollowing(true);
    send(`${command}\r`);
  }, [input, send]);

  const recallHistory = useCallback((direction: -1 | 1) => {
    if (history.length === 0) return;
    const current = historyIndex.current === -1 ? history.length : historyIndex.current;
    const next = Math.max(0, Math.min(history.length, current + direction));
    historyIndex.current = next >= history.length ? -1 : next;
    setInput(next >= history.length ? '' : history[next]);
  }, [history]);

  const clearScreen = useCallback(() => {
    clearTerm();
    setFollowing(true);
    // Ctrl+L makes a real pty redraw its prompt; a piped shell ignores it.
    if (mode === 'pty') send('\x0c');
  }, [mode, send]);

  const reconnect = useCallback(() => {
    // A fresh shell starts at an empty prompt, whatever the last one held.
    primedRef.current = false;
    setCandidates(null);
    reopenTermSession(openShell);
  }, [openShell]);

  // When the app-wide link comes back, a shell that died with it reopens by
  // itself, so the disconnected banner dismisses without a tap. Edge-triggered
  // on the phase transition (via refs), never on the terminal's own status —
  // a shell that fails against a healthy link must not retry in a loop.
  const statusRef = useRef(status);
  statusRef.current = status;
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const cameBack = prevPhaseRef.current !== 'connected' && phase === 'connected';
    prevPhaseRef.current = phase;
    if (!cameBack) return;
    const current = statusRef.current;
    if (current === 'closed' || current === 'error') reconnect();
  }, [phase, reconnect]);

  // --- render ----------------------------------------------------------------

  const live = status === 'open';
  const blank = term.lines.length <= 1 && (term.lines[0]?.chars.length ?? 0) === 0;
  // The shell's own fact — pty or piped — spoken only while the shell is
  // actually open. Connection state is never restated here: the device pill
  // in the same row is the one voice for the link (one voice per fact), and
  // shell-level states live on the glass itself.
  const shellLabel = mode === 'pipe' ? (short ? 'shell, no TTY' : 'shell') : mode === 'pty' ? 'pty' : 'ready';
  // What the machine panel says when the transcript is not the story —
  // empty, waiting, exited, dropped — in the one shared GlassState anatomy
  // (docs/DESIGN.md §11.4, "faults live on the glass"). A dropped socket is
  // only news while the link itself is healthy: while the link is down or
  // forming, the device pill already tells that story and a contradicting
  // "disconnected" shout would be a second voice for the same fact.
  const glass: Omit<GlassStateProps, 'style' | 'testID'> | null = (() => {
    if (status === 'connecting') {
      return { status: 'dim', name: 'Connecting', body: 'Opening a shell on the computer…' };
    }
    if (status === 'exited') {
      return {
        status: 'dim',
        name: 'Shell exited',
        body: 'The shell on the computer ended.',
        action: { label: 'Reconnect', onPress: reconnect },
      };
    }
    if ((status === 'closed' || status === 'error') && phase === 'connected') {
      return {
        status: 'bad',
        name: 'Shell disconnected',
        body: error || 'The terminal connection to the computer dropped.',
        action: { label: 'Reconnect', onPress: reconnect },
      };
    }
    if (live && blank) {
      // The designed READY state: not a fault, an invitation — with a prompt
      // hint as the proof-of-life line.
      return { status: 'dim', name: 'Ready', body: 'Commands you run appear here.', proof: '> _' };
    }
    return null;
  })();

  return (
    // The panel (src/home/panel.tsx) owns keyboard avoidance for every tool,
    // so the key bar and the command row ride up on the keyboard's own curve
    // without this screen owning an offset of its own.
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      {/* Concise header: title plus the one status line below — nothing
          restated, no controls but the sanctioned trailing overflow (§11.1),
          behind which lives the help sheet that writes the key bar down.
          Text size moved into the key bar (`Aa`) where it belongs. */}
      <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: short ? theme.space.xs : theme.space.md, paddingBottom: short ? theme.space.xs : theme.space.md }}>
        {/* In a short (landscape) window the title row goes: the lit tab in
            the bar already names the screen, and every row here is a row the
            transcript does not get (#91). */}
        {short ? null : (
          <Row justify="space-between" gap="sm">
            <Txt variant="display" heading>
              Terminal
            </Txt>
            <IconButton
              testID="term-help"
              accessibilityLabel="Terminal help"
              variant="plain"
              onPress={() => setShowHelp(true)}
            >
              <Txt variant="label" tone="dim">⋯</Txt>
            </IconButton>
          </Row>
        )}
        <Row justify="space-between" gap="sm" style={{ marginTop: short ? 0 : theme.space.xxs }}>
          {/* One connection voice: the device pill (trailing) owns the link
              story. The leading slot speaks only while the shell is open —
              the shell's own fact, which can never contradict the pill. In
              every other state it stays empty and the pill (or the one
              banner below) carries the news. Mirrors the Screen tab's
              header: leading slot for the surface's live fact, device pill
              trailing (docs/DESIGN.md §10). */}
          <Row gap="xs" style={{ flexShrink: 1 }}>
            {live ? (
              <StatusBadge 
                label={`Connected · ${shellLabel}`} 
                variant="subtle"
                testID="term-status"
              />
            ) : null}
          </Row>
          <Row gap="xs">
            <SwitchComputerLink />
            {short ? (
              <IconButton testID="term-help" accessibilityLabel="Terminal help" variant="plain" onPress={() => setShowHelp(true)}>
                <Txt variant="label" tone="dim">⋯</Txt>
              </IconButton>
            ) : null}
          </Row>
        </Row>
      </View>

      {mode === 'pipe' && !short ? (
        <Banner
          testID="term-pipe-notice"
          status="warn"
          title="No TTY on the host"
          message="The host fell back to a piped shell, so there is no cursor addressing, no tab completion and no job control. Commands still run and output still streams."
          style={{ marginHorizontal: theme.layout.margin, marginBottom: theme.space.sm }}
        />
      ) : null}

      {/* Shell faults (exited, dropped) live ON the glass below via
          GlassState, not as a coloured card here — the panel is where the
          shell's state is, and the phase edge above reopens a dropped shell
          the moment the link returns. */}

      {/* The header (or trailing banner) rule doubles as the machine panel's
          top hairline — two parallel rules may never sit adjacent (§6). */}
      <Rule />
      <TerminalOutput
        listRef={listRef}
        lines={term.lines}
        ramp={ramp}
        redraw={fontKey}
        fontSize={fontSize}
        lineHeight={lineHeight}
        padding={OUTPUT_PADDING}
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

      {/* The panel's bottom hairline; the key bar and input dock sit under it
          back on the page surface. */}
      <Rule />
      <View style={{ paddingTop: theme.space.xs, paddingBottom: theme.space.sm, gap: theme.space.xs }}>
        {candidates ? (
          <CandidateRow candidates={candidates} onPick={pickCandidate} onDismiss={() => setCandidates(null)} />
        ) : null}
        <KeyBar
          onSend={send}
          onClear={clearScreen}
          onHistory={recallHistory}
          onTab={requestComplete}
          ptyMode={mode !== 'pipe'}
          onFontCycle={() => setFontKey((k) => NEXT_FONT[k])}
          fontLabel={FONT_NAMES[fontKey]}
        />

        {completing || tabNotice ? (
          <Txt
            testID="term-tab-notice"
            variant="micro"
            tone={completing ? 'dim' : 'warn'}
            style={{ paddingHorizontal: theme.layout.margin }}
          >
            {completing ? 'ASKING THE SHELL…' : tabNotice}
          </Txt>
        ) : null}

        <Row gap="sm" style={{ paddingHorizontal: theme.layout.margin }}>
          {/* The continuation prompt stays, in quiet ink — the accent on this
              screen belongs to TYPE alone: it is the field's default action,
              and RUN stands beside it in ink (docs/DESIGN.md §10). */}
          <Txt variant="mono" tone="dim" style={{ fontSize: 16 }}>›</Txt>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <TextInput
              testID="term-input"
              value={input}
              onChangeText={onChangeInput}
              placeholder={live ? 'Type into the shell…' : 'Not connected'}
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={typeInput}
              accessibilityLabel="Shell input"
              maxFontSizeMultiplier={1.4}
              style={{
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xs,
                borderWidth: theme.layout.hairline,
                borderColor: theme.colors.border,
                color: theme.colors.text,
                fontFamily: theme.font.mono,
                paddingLeft: theme.space.md,
                // Clears the trailing dismiss so long input scrolls under the
                // field's edge, not under the glyph.
                paddingRight: keyboardUp ? theme.layout.minTouch : theme.space.md,
                minHeight: theme.layout.minTouch,
                fontSize: 14,
              }}
            />
            {/* The field's own way out of the keyboard, in the trailing spot
                the Screen tab's TYPE row uses. Return can't do it — it TYPEs
                the line and deliberately keeps focus for the next one. */}
            {keyboardUp ? (
              <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center' }}>
                <IconButton
                  testID="term-hide-keyboard"
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
            testID="term-type"
            label="Type"
            onPress={typeInput}
            size="sm"
            accessibilityHint="Sends the text to the shell without pressing return"
          />
          <Button
            testID="term-run"
            label="Run"
            variant="secondary"
            onPress={runInput}
            size="sm"
            accessibilityHint="Sends the text and presses return; with the field empty, just presses return"
          />
        </Row>
      </View>

      <TerminalHelpSheet visible={showHelp} onClose={() => setShowHelp(false)} />
    </View>
  );
}

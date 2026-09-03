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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { SwitchComputerLink } from '../../src/devices/switch-link';
import { wsUrl } from '../../src/api';
import { Banner, Button, Dot, IconButton, Row, Rule, SegmentedControl, Txt } from '../../src/ui';
import { useTheme } from '../../src/theme';
import { ANSI_RAMPS, clearTermState, createTermState, feed } from '../../src/terminal-ansi';
import type { TermLine, TermOptions, TermState } from '../../src/terminal-ansi';
import { KeyBar } from '../../src/terminal-keys';
import { TerminalOutput } from '../../src/terminal-output';
import { useTerminalGeometry, DEFAULT_GEOMETRY } from '../../src/terminal-geometry';
import type { Geometry } from '../../src/terminal-geometry';
import { EMPTY_OUTPUT, FLUSH_MS, drainOutput, parseServerMessage, pushOutput } from '../../src/terminal-session';
import type { OutputBuffer, ServerMessage } from '../../src/terminal-session';
import { applyCandidate, parseCompletion } from '../../src/terminal/complete';
import { planTab, trackPrimed } from '../../src/terminal/primed';
import { CandidateRow } from '../../src/terminal/candidate-row';
import { TerminalHelpSheet } from '../../src/terminal/help-sheet';

// --- constants ---------------------------------------------------------------

/** Lines of scrollback kept in memory. ~1500 short lines is a few MB at worst. */
const MAX_SCROLLBACK = 1500;
const LINE_HEIGHT_RATIO = 1.45;
const RESIZE_DEBOUNCE_MS = 200;
/** How close to the bottom still counts as "following" the output. */
const FOLLOW_SLACK_PX = 24;
const MAX_HISTORY = 50;
/** Longer than the host's own completion ceiling plus a network round trip, so
    a reply that will ever come is never abandoned — but a host agent built
    before completion existed (which ignores the request entirely) releases the
    key in a couple of seconds instead of hanging it. */
const COMPLETE_TIMEOUT_MS = 2500;
const TAB_NOTICE_MS = 5000;
const PIPE_TAB_NOTICE =
  'NO COMPLETION — the host shell has no TTY, so tab has nothing to ask. Run "npm i node-pty" next to the host agent, then restart it.';

type FontKey = 'sm' | 'md' | 'lg';
const FONT_SIZES: Readonly<Record<FontKey, number>> = { sm: 11, md: 12.5, lg: 15 };

type Status = 'connecting' | 'open' | 'closed' | 'exited' | 'error';
type ShellMode = 'pty' | 'pipe';

// --- screen ------------------------------------------------------------------

export default function TerminalTab() {
  const { connection, phase } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [term, setTerm] = useState<TermState>(createTermState);
  const [status, setStatus] = useState<Status>('connecting');
  const [mode, setMode] = useState<ShellMode | null>(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [fontKey, setFontKey] = useState<FontKey>('md');
  const [following, setFollowing] = useState(true);
  const [session, setSession] = useState(0);
  const [candidates, setCandidates] = useState<readonly string[] | null>(null);
  const [completing, setCompleting] = useState(false);
  const [tabNotice, setTabNotice] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const bufferRef = useRef<OutputBuffer>(EMPTY_OUTPUT);
  const geometryRef = useRef<Geometry>(DEFAULT_GEOMETRY);
  const followingRef = useRef(true);
  const listRef = useRef<FlatList<TermLine>>(null);
  const historyRef = useRef<readonly string[]>([]);
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

  const flush = useCallback(() => {
    const { text, next } = drainOutput(bufferRef.current);
    bufferRef.current = next;
    if (text.length === 0) return;
    const options: TermOptions = { ...geometryRef.current, maxLines: MAX_SCROLLBACK };
    setTerm((prev) => feed(prev, text, options));
  }, []);

  useEffect(() => {
    if (!connection) return undefined;
    setStatus('connecting');
    setError('');
    setMode(null);
    // A fresh shell starts at an empty prompt, whatever the last one held.
    primedRef.current = false;

    // The upgrade URL now needs a single-use ticket fetched over HTTP first, so
    // opening is asynchronous. `cancelled` guards the gap: the effect can be
    // torn down while that request is in flight, and a socket opened afterwards
    // would have no cleanup attached to it.
    let cancelled = false;
    let socket: WebSocket | null = null;

    const openSocket = async (): Promise<void> => {
      let opened: WebSocket;
      try {
        const { cols, rows } = geometryRef.current;
        opened = new WebSocket(await wsUrl('/ws/terminal', { cols, rows }));
      } catch (e: unknown) {
        if (cancelled) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : 'could not open a terminal session');
        return;
      }
      if (cancelled) { opened.close(); return; }

      socket = opened;
      wsRef.current = opened;
      attach(opened);
    };

    const attach = (socket: WebSocket): void => {
      socket.onopen = () => setStatus('open');
    socket.onmessage = (event: MessageEvent) => {
      const msg = parseServerMessage(event.data);
      if (!msg) return;
      if (msg.type === 'ready') {
        setMode(msg.mode === 'pipe' ? 'pipe' : 'pty');
      } else if (msg.type === 'data' && msg.data !== undefined) {
        bufferRef.current = pushOutput(bufferRef.current, msg.data);
      } else if (msg.type === 'completion') {
        // Routed through a ref: this closure is created once per session, but
        // the handler needs the render-current input and pending state.
        completionHandler.current(msg);
      } else if (msg.type === 'exit') {
        bufferRef.current = pushOutput(bufferRef.current, '\r\n');
        setStatus('exited');
      }
    };
    socket.onerror = () => {
      setError('the terminal connection failed');
      setStatus((s) => (s === 'exited' ? s : 'error'));
    };
    socket.onclose = () => setStatus((s) => (s === 'exited' || s === 'error' ? s : 'closed'));
    };

    void openSocket();

    const timer = setInterval(flush, FLUSH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      // A dance cannot outlive its shell: the reply channel is gone, so the
      // wait would only ever end in the timeout notice.
      if (pendingCompletion.current) {
        clearTimeout(pendingCompletion.current.timer);
        pendingCompletion.current = null;
      }
      setCompleting(false);
      setCandidates(null);
      if (!socket) return;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      if (wsRef.current === socket) wsRef.current = null;
    };
  }, [connection, flush, session]);

  const send = useCallback((data: string) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({ type: 'data', data }));
      // Every keystroke that reaches the shell updates the primed ledger —
      // the key bar's letters and arrows included, since an up-arrow can pull
      // a whole history line into the shell's buffer without this screen
      // typing a thing.
      primedRef.current = trackPrimed(primedRef.current, data);
    } catch {
      setError('could not reach the shell — try reconnecting');
    }
  }, []);

  /** Sends an arbitrary control message; `send` above stays keystrokes-only. */
  const post = useCallback((message: object): boolean => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, []);

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
  useEffect(() => {
    const socket = wsRef.current;
    if (!socket || status !== 'open') return undefined;
    const timer = setTimeout(() => {
      try {
        socket.send(JSON.stringify({ type: 'resize', ...geometry }));
      } catch {
        // A socket that closed mid-debounce is handled by onclose.
      }
    }, RESIZE_DEBOUNCE_MS);
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
    if (command.length > 0) {
      const next = [...historyRef.current.filter((h) => h !== command), command];
      historyRef.current = next.slice(-MAX_HISTORY);
    }
    historyIndex.current = -1;
    setInput('');
    setCandidates(null);
    setFollowing(true);
    send(`${command}\r`);
  }, [input, send]);

  const recallHistory = useCallback((direction: -1 | 1) => {
    const history = historyRef.current;
    if (history.length === 0) return;
    const current = historyIndex.current === -1 ? history.length : historyIndex.current;
    const next = Math.max(0, Math.min(history.length, current + direction));
    historyIndex.current = next >= history.length ? -1 : next;
    setInput(next >= history.length ? '' : history[next]);
  }, []);

  const clearScreen = useCallback(() => {
    bufferRef.current = EMPTY_OUTPUT;
    setTerm(clearTermState);
    setFollowing(true);
    // Ctrl+L makes a real pty redraw its prompt; a piped shell ignores it.
    if (mode === 'pty') send('\x0c');
  }, [mode, send]);

  const reconnect = useCallback(() => {
    bufferRef.current = EMPTY_OUTPUT;
    setTerm(createTermState());
    setSession((n) => n + 1);
  }, []);

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
  // shell-level faults get the single banner below.
  const shellLabel = mode === 'pipe' ? 'shell' : mode === 'pty' ? 'pty' : 'ready';
  // The shell ending is a shell fact (an `exit`, a crash) and is worth a warn
  // banner whenever it happens. A dropped/failed socket is only news while the
  // link itself is healthy — while the link is down or still forming, the
  // device pill already tells that story and a contradicting "disconnected"
  // shout would be a second voice for the same fact.
  const shellDown = status === 'closed' || status === 'error';
  const showOffline = status === 'exited' || (shellDown && phase === 'connected');

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}
    >
      {/* Standard header anatomy: title, then the label status line — the pty
          badge died into a plain "· PTY" suffix here (docs/DESIGN.md §10). */}
      <View style={{ paddingHorizontal: theme.layout.margin, paddingTop: theme.space.md, paddingBottom: theme.space.md }}>
        <Row justify="space-between" gap="sm">
          <Txt variant="title" heading>
            Terminal
          </Txt>
          <Row gap="xs">
            <SegmentedControl
              testID="term-font"
              accessibilityLabel="Text size"
              options={[{ value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }]}
              value={fontKey}
              onChange={setFontKey}
              style={{ width: 108 }}
            />
            {/* The overflow glyph in its sanctioned trailing corner (§11.1);
                behind it lives the help sheet that writes the key bar down. */}
            <IconButton
              testID="term-help"
              accessibilityLabel="Terminal help"
              variant="plain"
              onPress={() => setShowHelp(true)}
            >
              <Txt variant="label" tone="dim">⋯</Txt>
            </IconButton>
          </Row>
        </Row>
        <Row justify="space-between" gap="sm" style={{ marginTop: theme.space.xxs }}>
          {/* One connection voice: the device pill (trailing) owns the link
              story. The leading slot speaks only while the shell is open —
              the shell's own fact, which can never contradict the pill. In
              every other state it stays empty and the pill (or the one
              banner below) carries the news. Mirrors the Screen tab's
              header: leading slot for the surface's live fact, device pill
              trailing (docs/DESIGN.md §10). */}
          <Row gap="xs" style={{ flexShrink: 1 }}>
            {live ? (
              <>
                <Dot status="good" pulse label={`live · ${shellLabel}`} />
                <Txt testID="term-status" variant="label" tone="dim" numberOfLines={1}>
                  {`live · ${shellLabel}`}
                </Txt>
              </>
            ) : null}
          </Row>
          <SwitchComputerLink />
        </Row>
      </View>

      {mode === 'pipe' ? (
        <Banner
          testID="term-pipe-notice"
          status="warn"
          title="No TTY on the host"
          message="The host fell back to a piped shell, so there is no cursor addressing, no tab completion and no job control. Commands still run and output still streams."
          style={{ marginHorizontal: theme.layout.margin, marginBottom: theme.space.sm }}
        />
      ) : null}

      {/* The one shell-fault banner. It never appears while the link itself
          is down or forming — the device pill is the voice for that — and it
          dismisses itself: the phase edge above reopens the shell the moment
          the link returns. Reconnect stays as the manual path for a shell
          that died against a healthy link. */}
      {showOffline ? (
        <Banner
          testID="term-offline"
          status={status === 'exited' ? 'warn' : 'bad'}
          title={status === 'exited' ? 'Shell exited' : 'Shell disconnected'}
          message={error || (status === 'exited' ? 'The shell on the computer ended.' : 'The terminal connection to the computer dropped.')}
          action={{ label: 'Reconnect', onPress: reconnect }}
          style={{ marginHorizontal: theme.layout.margin, marginBottom: theme.space.sm }}
        />
      ) : null}

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
        placeholder={status === 'connecting' ? 'Opening a shell…' : 'No output yet.'}
        blank={blank}
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
        <KeyBar onSend={send} onClear={clearScreen} onHistory={recallHistory} onTab={requestComplete} ptyMode={mode !== 'pipe'} />

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
            blurOnSubmit={false}
            onSubmitEditing={typeInput}
            accessibilityLabel="Shell input"
            maxFontSizeMultiplier={1.4}
            style={{
              flex: 1,
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.xs,
              borderWidth: theme.layout.hairline,
              borderColor: theme.colors.border,
              color: theme.colors.text,
              fontFamily: theme.font.mono,
              paddingHorizontal: theme.space.md,
              minHeight: theme.layout.minTouch,
              fontSize: 14,
            }}
          />
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
    </KeyboardAvoidingView>
  );
}

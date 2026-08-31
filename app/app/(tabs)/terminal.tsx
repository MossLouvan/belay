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
import { wsUrl } from '../../src/api';
import { Banner, Button, Dot, Row, Rule, SegmentedControl, Txt } from '../../src/ui';
import { useTheme } from '../../src/theme';
import { ANSI_RAMPS, clearTermState, createTermState, feed } from '../../src/terminal-ansi';
import type { TermLine, TermOptions, TermState } from '../../src/terminal-ansi';
import { KeyBar } from '../../src/terminal-keys';
import { TerminalOutput } from '../../src/terminal-output';
import { useTerminalGeometry, DEFAULT_GEOMETRY } from '../../src/terminal-geometry';
import type { Geometry } from '../../src/terminal-geometry';
import { EMPTY_OUTPUT, FLUSH_MS, drainOutput, parseServerMessage, pushOutput } from '../../src/terminal-session';
import type { OutputBuffer } from '../../src/terminal-session';

// --- constants ---------------------------------------------------------------

/** Lines of scrollback kept in memory. ~1500 short lines is a few MB at worst. */
const MAX_SCROLLBACK = 1500;
const LINE_HEIGHT_RATIO = 1.45;
const RESIZE_DEBOUNCE_MS = 200;
/** How close to the bottom still counts as "following" the output. */
const FOLLOW_SLACK_PX = 24;
const MAX_HISTORY = 50;

type FontKey = 'sm' | 'md' | 'lg';
const FONT_SIZES: Readonly<Record<FontKey, number>> = { sm: 11, md: 12.5, lg: 15 };

type Status = 'connecting' | 'open' | 'closed' | 'exited' | 'error';
type ShellMode = 'pty' | 'pipe';

// --- screen ------------------------------------------------------------------

export default function TerminalTab() {
  const { connection } = useConnection();
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

  const wsRef = useRef<WebSocket | null>(null);
  const bufferRef = useRef<OutputBuffer>(EMPTY_OUTPUT);
  const geometryRef = useRef<Geometry>(DEFAULT_GEOMETRY);
  const followingRef = useRef(true);
  const listRef = useRef<FlatList<TermLine>>(null);
  const historyRef = useRef<readonly string[]>([]);
  const historyIndex = useRef<number>(-1);

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
    } catch {
      setError('could not reach the shell — try reconnecting');
    }
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

  const runInput = useCallback(() => {
    const command = input;
    if (command.length > 0) {
      const next = [...historyRef.current.filter((h) => h !== command), command];
      historyRef.current = next.slice(-MAX_HISTORY);
    }
    historyIndex.current = -1;
    setInput('');
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

  // --- render ----------------------------------------------------------------

  const live = status === 'open';
  const blank = term.lines.length <= 1 && (term.lines[0]?.chars.length ?? 0) === 0;
  const statusLabel =
    status === 'open' ? (mode === 'pipe' ? 'shell' : mode === 'pty' ? 'pty' : 'ready') :
    status === 'connecting' ? 'connecting' :
    status === 'exited' ? 'exited' :
    status === 'error' ? 'error' : 'closed';

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
          <SegmentedControl
            testID="term-font"
            accessibilityLabel="Text size"
            options={[{ value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }]}
            value={fontKey}
            onChange={setFontKey}
            style={{ width: 108 }}
          />
        </Row>
        <Row gap="xs" style={{ marginTop: theme.space.xxs }}>
          <Dot
            status={live ? 'good' : status === 'connecting' ? 'warn' : 'bad'}
            pulse={status === 'connecting' || live}
            label={statusLabel}
          />
          <Txt testID="term-status" variant="label" tone="dim">
            {live ? `live · ${statusLabel}` : statusLabel}
          </Txt>
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

      {!live && status !== 'connecting' ? (
        <Banner
          testID="term-offline"
          status={status === 'exited' ? 'warn' : 'bad'}
          title={status === 'exited' ? 'Shell exited' : 'Disconnected'}
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
        <KeyBar onSend={send} onClear={clearScreen} onHistory={recallHistory} ptyMode={mode !== 'pipe'} />

        <Row gap="sm" style={{ paddingHorizontal: theme.layout.margin }}>
          {/* The continuation prompt stays, in quiet ink — the accent on this
              screen belongs to RUN alone (docs/DESIGN.md §10). */}
          <Txt variant="mono" tone="dim" style={{ fontSize: 16 }}>›</Txt>
          <TextInput
            testID="term-input"
            value={input}
            onChangeText={setInput}
            placeholder={live ? 'Run a command…' : 'Not connected'}
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={runInput}
            accessibilityLabel="Shell command"
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
          <Button testID="term-run" label="Run" onPress={runInput} size="sm" />
        </Row>
      </View>
    </KeyboardAvoidingView>
  );
}

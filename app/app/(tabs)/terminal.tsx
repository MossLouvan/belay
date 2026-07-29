// Terminal. A WebSocket to the host's shell: output streams into a scrollback
// view (ANSI escapes stripped for a clean read), and a command line at the
// bottom sends input. Quick keys cover Enter, Ctrl+C, tab-completion and arrows.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { wsUrl } from '../../src/api';
import { Row, Dot } from '../../src/ui';
import { colors, radius, space, font } from '../../src/theme';

// Strip ANSI/VT control sequences so the scrollback stays legible without a
// full terminal emulator on the client.
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (window title etc.)
    .replace(/\x1b[@-Z\\-_]/g, '')                     // single-char escapes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')         // CSI sequences
    .replace(/\r/g, '');
}

export default function TerminalTab() {
  const { connection } = useConnection();
  const insets = useSafeAreaInsets();
  const [lines, setLines] = useState('');
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!connection) return;
    let closed = false;
    const ws = new WebSocket(wsUrl('/ws/terminal', { cols: 100, rows: 30 }));
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'ready') { setMode(msg.mode); }
        else if (msg.type === 'data') {
          // Cap scrollback so a chatty process can't grow memory without bound.
          setLines((prev) => {
            const next = prev + stripAnsi(msg.data);
            return next.length > 40000 ? next.slice(next.length - 40000) : next;
          });
        } else if (msg.type === 'exit') {
          setLines((p) => p + '\n[process exited]\n');
          setConnected(false);
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => { if (!closed) setConnected(false); };
    ws.onerror = () => setConnected(false);
    return () => { closed = true; ws.close(); };
  }, [connection]);

  const raw = (data: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'data', data }));
  };

  const runInput = () => {
    raw(input + '\r');
    setInput('');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <Row style={{ justifyContent: 'space-between', paddingHorizontal: space.md, paddingBottom: space.sm }}>
        <Row style={{ gap: 8 }}>
          <Dot color={connected ? colors.good : colors.bad} />
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Terminal</Text>
        </Row>
        <Text style={{ color: colors.textFaint, fontSize: 12 }}>{mode === 'pty' ? 'pty' : mode === 'pipe' ? 'shell' : ''}</Text>
      </Row>

      <ScrollView
        ref={scrollRef}
        testID="term-output"
        style={{ flex: 1, backgroundColor: colors.black, marginHorizontal: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}
        contentContainerStyle={{ padding: space.sm }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <Text selectable style={{ color: '#d6f5df', fontFamily: font.mono, fontSize: 12.5, lineHeight: 18 }}>
          {lines || 'Connecting to shell…'}
        </Text>
      </ScrollView>

      <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: insets.bottom + space.sm, gap: space.sm }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          <QKey label="Ctrl+C" onPress={() => raw('\x03')} />
          <QKey label="Tab" onPress={() => raw('\t')} />
          <QKey label="Enter" onPress={() => raw('\r')} />
          <QKey label="Up" onPress={() => raw('\x1b[A')} />
          <QKey label="Down" onPress={() => raw('\x1b[B')} />
          <QKey label="clear" onPress={() => { setLines(''); raw('cls\r'); }} />
        </ScrollView>
        <Row style={{ gap: space.sm }}>
          <Text style={{ color: colors.accent, fontFamily: font.mono, fontSize: 16, alignSelf: 'center' }}>›</Text>
          <TextInput
            testID="term-input"
            value={input}
            onChangeText={setInput}
            placeholder="Run a command…"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={runInput}
            style={{ flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, color: colors.text, fontFamily: font.mono, paddingHorizontal: space.md, paddingVertical: 11, fontSize: 14 }}
          />
          <Pressable testID="term-run" onPress={runInput} style={{ backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: space.md, justifyContent: 'center' }}>
            <Text style={{ color: colors.black, fontWeight: '800' }}>Run</Text>
          </Pressable>
        </Row>
      </View>
    </View>
  );
}

function QKey({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable testID={`qkey-${label}`} onPress={onPress} style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: colors.borderStrong }}>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13, fontFamily: font.mono }}>{label}</Text>
    </Pressable>
  );
}

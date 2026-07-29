// Remote screen. Streams JPEG frames from the host over a WebSocket and renders
// them; taps and drags on the image become normalized clicks/drags on the PC.
// A key bar and a text-send row cover keyboard input without a native keyboard.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Image, Pressable, TextInput, ScrollView, LayoutChangeEvent, GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { api, wsUrl } from '../../src/api';
import { Row, Dot } from '../../src/ui';
import { colors, radius, space } from '../../src/theme';

type Conn = 'connecting' | 'live' | 'error';

const QUALITY = { w: 1024, q: 50, fps: 12 };

export default function ScreenTab() {
  const { connection } = useConnection();
  const insets = useSafeAreaInsets();
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState<Conn>('connecting');
  const [fps, setFps] = useState(0);
  const [showKeys, setShowKeys] = useState(true);
  const [rightClick, setRightClick] = useState(false);
  const [text, setText] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const layout = useRef({ w: 1, h: 1 });
  const dragStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const frameCount = useRef(0);

  // Open the stream; reconnect on drop. Cleaned up on unmount.
  useEffect(() => {
    if (!connection) return;
    let closed = false;
    let reconnectTimer: any;

    const connect = () => {
      setStatus('connecting');
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl('/ws/screen', QUALITY));
      } catch {
        setStatus('error');
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => setStatus('live');
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'frame') {
            setFrame(`data:image/jpeg;base64,${msg.data}`);
            frameCount.current += 1;
          } else if (msg.type === 'error') {
            setStatus('error');
          }
        } catch { /* ignore */ }
      };
      ws.onerror = () => setStatus('error');
      ws.onclose = () => {
        if (!closed) { setStatus('error'); reconnectTimer = setTimeout(connect, 1500); }
      };
    };
    connect();

    const fpsTimer = setInterval(() => { setFps(frameCount.current); frameCount.current = 0; }, 1000);
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      clearInterval(fpsTimer);
      wsRef.current?.close();
    };
  }, [connection]);

  const onLayout = (e: LayoutChangeEvent) => {
    layout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };

  const norm = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    return {
      x: Math.max(0, Math.min(1, locationX / layout.current.w)),
      y: Math.max(0, Math.min(1, locationY / layout.current.h)),
    };
  };

  const onStart = (e: GestureResponderEvent) => {
    const p = norm(e);
    dragStart.current = { ...p, t: Date.now() };
  };

  // Short press with little movement = click; longer movement = drag.
  const onEnd = async (e: GestureResponderEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start) return;
    const p = norm(e);
    const moved = Math.hypot(p.x - start.x, p.y - start.y);
    try {
      if (moved > 0.02) {
        await api.drag(start.x, start.y, p.x, p.y);
      } else {
        await api.click(p.x, p.y, rightClick ? 'right' : 'left');
        if (rightClick) setRightClick(false);
      }
    } catch { /* transient */ }
  };

  const sendKey = useCallback((key: string, mods: string[] = []) => {
    api.key(key, mods).catch(() => {});
  }, []);

  const sendText = () => {
    if (!text) return;
    api.typeText(text).catch(() => {});
    setText('');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <Row style={{ justifyContent: 'space-between', paddingHorizontal: space.md, paddingBottom: space.sm }}>
        <Row style={{ gap: 8 }}>
          <Dot color={status === 'live' ? colors.good : status === 'connecting' ? colors.warn : colors.bad} />
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>
            {connection?.hostName || 'Screen'}
          </Text>
        </Row>
        <Text testID="fps" style={{ color: colors.textFaint, fontSize: 12 }}>
          {status === 'live' ? `${fps} fps` : status}
        </Text>
      </Row>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm }}>
        <View
          testID="screen-surface"
          onLayout={onLayout}
          onStartShouldSetResponder={() => true}
          onResponderGrant={onStart}
          onResponderRelease={onEnd}
          style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.black, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}
        >
          {frame ? (
            <Image source={{ uri: frame }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: colors.textFaint }}>
                {status === 'error' ? 'Reconnecting…' : 'Waiting for screen…'}
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={{ paddingHorizontal: space.sm, paddingBottom: insets.bottom + space.sm, gap: space.sm }}>
        <Row style={{ gap: space.sm }}>
          <Chip label={rightClick ? 'Right-click: ON' : 'Right-click'} active={rightClick} onPress={() => setRightClick((v) => !v)} testID="right-click" />
          <Chip label={showKeys ? 'Hide keys' : 'Show keys'} onPress={() => setShowKeys((v) => !v)} testID="toggle-keys" />
        </Row>

        {showKeys && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            <Key label="Esc" onPress={() => sendKey('escape')} />
            <Key label="Tab" onPress={() => sendKey('tab')} />
            <Key label="Enter" onPress={() => sendKey('enter')} />
            <Key label="Bksp" onPress={() => sendKey('backspace')} />
            <Key label="Ctrl+C" onPress={() => sendKey('c', ['ctrl'])} />
            <Key label="Ctrl+V" onPress={() => sendKey('v', ['ctrl'])} />
            <Key label="Win" onPress={() => sendKey('win')} />
            <Key label="Left" onPress={() => sendKey('left')} />
            <Key label="Up" onPress={() => sendKey('up')} />
            <Key label="Down" onPress={() => sendKey('down')} />
            <Key label="Right" onPress={() => sendKey('right')} />
          </ScrollView>
        )}

        <Row style={{ gap: space.sm }}>
          <TextInput
            testID="type-input"
            value={text}
            onChangeText={setText}
            placeholder="Type text to send to the PC…"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={sendText}
            style={{ flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, color: colors.text, paddingHorizontal: space.md, paddingVertical: 11, fontSize: 15 }}
          />
          <Pressable testID="send-text" onPress={sendText} style={{ backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: space.md, justifyContent: 'center' }}>
            <Text style={{ color: colors.black, fontWeight: '800' }}>Send</Text>
          </Pressable>
        </Row>
      </View>
    </View>
  );
}

function Chip({ label, onPress, active, testID }: { label: string; onPress: () => void; active?: boolean; testID?: string }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={{ backgroundColor: active ? colors.accent : colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 8, borderWidth: 1, borderColor: active ? colors.accent : colors.borderStrong }}>
      <Text style={{ color: active ? colors.black : colors.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function Key({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable testID={`key-${label}`} onPress={onPress} style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: colors.borderStrong, minWidth: 44, alignItems: 'center' }}>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

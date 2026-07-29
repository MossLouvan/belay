// Connect screen. Two steps: point at the host (URL/IP), then enter the 6-digit
// pairing code shown on the PC. On success we store a token and move to the
// tabs. If a saved connection already exists we skip straight through.

import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../src/connection';
import { checkHost, pair, normalizeHost } from '../src/api';
import { Button, Card, Heading, Sub, Label, Row, Dot } from '../src/ui';
import { colors, radius, space } from '../src/theme';

export default function Connect() {
  const { ready, connection, setConnection } = useConnection();
  const insets = useSafeAreaInsets();

  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'host' | 'code'>('host');
  const [checked, setChecked] = useState<{ name?: string; native?: boolean; paired?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Already paired from a previous launch -> go straight in.
  useEffect(() => {
    if (ready && connection) router.replace('/(tabs)/screen');
  }, [ready, connection]);

  const doCheck = async () => {
    setError('');
    const normalized = normalizeHost(host);
    if (!normalized) { setError('Enter your PC address, e.g. 100.64.0.1 or 192.168.1.20'); return; }
    setHost(normalized);
    setBusy(true);
    const res = await checkHost(normalized);
    setBusy(false);
    if (!res.ok) { setError(res.error || 'Could not reach that host'); return; }
    setChecked({ name: res.name, native: res.native, paired: res.paired });
    setStage('code');
  };

  const doPair = async () => {
    setError('');
    if (!/^\d{6}$/.test(code)) { setError('The pairing code is 6 digits'); return; }
    setBusy(true);
    try {
      const deviceName = Platform.OS === 'web' ? 'Browser' : 'iPhone';
      const conn = await pair(normalizeHost(host), code, deviceName);
      setConnection(conn);
      router.replace('/(tabs)/screen');
    } catch (e: any) {
      setError(e.message || 'Pairing failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{
          padding: space.lg,
          paddingTop: insets.top + space.xl,
          paddingBottom: insets.bottom + space.xl,
          flexGrow: 1,
          justifyContent: 'center',
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', marginBottom: space.xl }}>
          <LogoMark />
          <Heading style={{ marginTop: space.md }}>Tether</Heading>
          <Sub style={{ textAlign: 'center', marginTop: 6 }}>
            Control your PC from your phone.
          </Sub>
        </View>

        {stage === 'host' ? (
          <Card>
            <Label>PC address</Label>
            <TextInput
              testID="host-input"
              value={host}
              onChangeText={setHost}
              placeholder="100.64.0.1  or  192.168.1.20"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={Platform.OS === 'web' ? 'default' : 'url'}
              onSubmitEditing={doCheck}
              style={inputStyle}
            />
            <Sub style={{ marginTop: space.sm }}>
              On the same Wi-Fi, use the address the host prints. Away from home,
              use its Tailscale IP (starts with 100.).
            </Sub>
            {!!error && <ErrorText text={error} />}
            <Button label="Continue" onPress={doCheck} loading={busy} testID="check-host" style={{ marginTop: space.md }} />
          </Card>
        ) : (
          <Card>
            <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
              <Row style={{ gap: 8 }}>
                <Dot color={colors.good} />
                <Text style={{ color: colors.text, fontWeight: '700' }}>{checked?.name || 'PC'}</Text>
              </Row>
              <Text style={{ color: colors.textFaint, fontSize: 12 }}>
                {checked?.native ? 'screen + input' : 'terminal only'}
              </Text>
            </Row>

            <Label>Pairing code</Label>
            <TextInput
              testID="code-input"
              value={code}
              onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
              placeholder="123456"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              onSubmitEditing={doPair}
              style={[inputStyle, { letterSpacing: 8, fontSize: 22, textAlign: 'center' }]}
            />
            <Sub style={{ marginTop: space.sm }}>
              Enter the 6-digit code shown in the Tether window on your PC.
            </Sub>
            {!!error && <ErrorText text={error} />}
            <Button label="Pair" onPress={doPair} loading={busy} testID="pair-btn" style={{ marginTop: space.md }} />
            <Button
              label="Back"
              variant="ghost"
              onPress={() => { setStage('host'); setError(''); }}
              testID="back-btn"
              style={{ marginTop: space.sm }}
            />
          </Card>
        )}

        <Sub style={{ textAlign: 'center', marginTop: space.xl, fontSize: 12 }}>
          Your phone talks straight to your PC. Nothing routes through us.
        </Sub>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ErrorText({ text }: { text: string }) {
  return (
    <View testID="error" style={{ marginTop: space.sm, backgroundColor: '#2a161a', borderRadius: radius.sm, padding: space.sm, borderWidth: 1, borderColor: '#5c2a30' }}>
      <Text style={{ color: colors.bad, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

function LogoMark() {
  return (
    <View style={{ width: 66, height: 66, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 26, height: 26, borderRadius: 8, borderWidth: 4, borderColor: colors.black }} />
    </View>
  );
}

const inputStyle = {
  backgroundColor: colors.surfaceAlt,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: colors.borderStrong,
  color: colors.text,
  paddingHorizontal: space.md,
  paddingVertical: 13,
  fontSize: 16,
} as const;

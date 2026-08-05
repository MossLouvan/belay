// Connect screen — the first thing anyone sees, and the only place the app can
// lose someone entirely.
//
// Two steps: point at the computer (address), then trade the 6-digit code shown
// on it for a token. Around those two steps sits the onboarding a cold start
// needs: what has to be running, what to type, and what to do when it fails.
// A saved connection skips the whole thing.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../src/connection';
import { checkHost, pair } from '../src/api';
import { buildSavedDevice } from '../src/devices/from-host';
import { useTheme } from '../src/theme';
import { Caption, Card, Column, Label, Row, Txt, haptic } from '../src/ui';
import { Brand } from '../src/connect/brand';
import { Diagnosis, diagnoseHostFailure, diagnosePairFailure } from '../src/connect/diagnose';
import { forgetHost, loadRecentHosts, prettyHost, rememberHost, resolveHost } from '../src/connect/host-input';
import { AwayFromHomeNote, SetupSteps } from '../src/connect/onboarding';
import { HostStep } from '../src/connect/host-step';
import { CODE_LENGTH, HostSummary, PairStep } from '../src/connect/pair-step';
import { ThemeToggle } from '../src/settings/theme-toggle';

type Stage = 'host' | 'code' | 'success';

/** How long to wait for `/health` before calling the address unreachable. */
const HOST_CHECK_TIMEOUT_MS = 8000;
/** How long the success card is shown before the tabs take over. */
const SUCCESS_DWELL_MS = 600;

type HealthResult = Awaited<ReturnType<typeof checkHost>>;

const deviceName = (): string => {
  if (Platform.OS === 'web') return 'Browser';
  if (Platform.OS === 'ios') return 'iPhone';
  return 'Android';
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? ''));

/**
 * `checkHost` has no timeout of its own, and a filtered address can leave the
 * request hanging indefinitely — which reads to the user as a frozen app. The
 * race bounds the wait; the underlying request is abandoned, not cancelled.
 */
async function checkHostBounded(url: string): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<HealthResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'timed out' }), HOST_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([checkHost(url), bail]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function SuccessCard({ name }: { name: string }) {
  const theme = useTheme();
  return (
    <Card testID="pair-success">
      <Column align="center" gap="sm" style={{ paddingVertical: theme.space.md }}>
        <View
          accessibilityElementsHidden
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: theme.colors.goodSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Txt variant="title" color={theme.colors.onGoodSoft}>
            ✓
          </Txt>
        </View>
        <Txt variant="subheading" align="center">
          Paired with {name}
        </Txt>
        <Caption style={{ textAlign: 'center' }}>You will not need the code again on this device.</Caption>
      </Column>
    </Card>
  );
}

export default function Connect() {
  const { ready, connection, addDevice, devices, phase } = useConnection();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const [hostText, setHostText] = useState('');
  const [touched, setTouched] = useState(false);
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('host');
  const [host, setHost] = useState<HostSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [hostError, setHostError] = useState<Diagnosis | null>(null);
  const [pairError, setPairError] = useState<Diagnosis | null>(null);
  const [recent, setRecent] = useState<readonly string[]>([]);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** False once the screen is gone, so a late `/health` cannot set state. */
  const live = useRef(true);
  /** True while a `/health` check is in flight — blocks a second, overlapping one. */
  const checking = useRef(false);
  /** Identifies the newest check, so only its result may be applied. */
  const checkSeq = useRef(0);
  const resolution = useMemo(() => resolveHost(hostText), [hostText]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Already set up from a previous launch. One reachable computer goes straight
  // in; anything else lands on the computer list, which is the only screen that
  // can explain "your Mac did not answer" and offer somewhere to go next.
  useEffect(() => {
    if (!ready) return;
    if (connection) { router.replace('/(tabs)/screen'); return; }
    if (devices.length > 0 && phase !== 'connecting') router.replace('/devices');
  }, [ready, connection, devices.length, phase]);

  useEffect(() => {
    let live = true;
    loadRecentHosts().then((list) => {
      if (!live) return;
      setRecent(list);
      // Pre-fill the last computer used, so the common case is one tap.
      if (list.length > 0) setHostText((current) => current || prettyHost(list[0]));
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);

  const onChangeHost = useCallback((next: string) => {
    setHostText(next);
    setTouched(true);
    setHostError(null);
  }, []);

  const onChangeCode = useCallback((next: string) => {
    setCode(next);
    setPairError(null);
  }, []);

  const doCheck = useCallback(async () => {
    // A second submit while the first is still out (double Enter, a fast
    // double-tap, anything programmatic) would start a competing request whose
    // result could land last and overwrite the newer one.
    if (checking.current) return;

    setHostError(null);
    setTouched(true);
    const resolved = resolveHost(hostText);
    if (!resolved.ok) {
      setHostError({ title: 'Check the address', message: resolved.reason });
      return;
    }

    checking.current = true;
    const seq = checkSeq.current + 1;
    checkSeq.current = seq;
    setBusy(true);
    try {
      const result = await checkHostBounded(resolved.url);
      // Apply nothing from a superseded check, and nothing at all once the
      // screen is gone (the already-paired redirect can unmount mid-flight).
      if (!live.current || seq !== checkSeq.current) return;
      setBusy(false);

      if (!result.ok) {
        setHostError(diagnoseHostFailure(resolved.url, result.error));
        return;
      }

      haptic('success');
      setHost({
        url: resolved.url,
        name: result.name || 'your computer',
        // An older host that omits the flag is assumed capable — better than
        // warning about a limitation that may not exist.
        native: result.native !== false,
        paired: Boolean(result.paired),
      });
      setCode('');
      setPairError(null);
      setStage('code');
      rememberHost(resolved.url).then(
        (list) => {
          if (live.current) setRecent(list);
        },
        () => undefined,
      );
    } finally {
      checking.current = false;
    }
  }, [hostText]);

  const doPair = useCallback(async () => {
    if (!host) return;
    setPairError(null);
    if (code.length !== CODE_LENGTH) {
      setPairError({
        title: `Enter all ${CODE_LENGTH} digits`,
        message: 'The pairing code shown on your computer is six digits long.',
      });
      return;
    }

    setBusy(true);
    try {
      const result = await pair(host.url, code, deviceName());
      // Re-read /health now that we are paired, so the saved computer gets the
      // host's real identity and its full address list rather than just the one
      // URL that happened to be typed in.
      const identity = await checkHost(result.host);
      const device = buildSavedDevice(result, identity, Date.now());
      haptic('success');
      setStage('success');
      successTimer.current = setTimeout(() => {
        // Save and connect *before* navigating. The tabs guard redirects away
        // when there is no live connection, so leaving this unawaited bounces
        // the user straight back to this screen.
        void addDevice(device).then(() => router.replace('/(tabs)/screen'));
      }, SUCCESS_DWELL_MS);
    } catch (e: unknown) {
      haptic('error');
      setPairError(diagnosePairFailure(host.url, errorMessage(e)));
      setCode('');
    } finally {
      setBusy(false);
    }
  }, [host, code, addDevice]);

  const onBack = useCallback(() => {
    setStage('host');
    setPairError(null);
    setCode('');
  }, []);

  const onPickRecent = useCallback((url: string) => {
    setHostText(prettyHost(url));
    setTouched(true);
    setHostError(null);
  }, []);

  const onForgetRecent = useCallback((url: string) => {
    forgetHost(url).then(setRecent, () => undefined);
  }, []);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.md,
          paddingTop: insets.top + theme.space.lg,
          paddingBottom: insets.bottom + theme.space.xl,
          gap: theme.space.md,
          flexGrow: 1,
          justifyContent: 'center',
          width: '100%',
          maxWidth: theme.layout.contentMaxWidth,
          alignSelf: 'center',
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Brand />

        {stage === 'host' ? (
          <>
            <HostStep
              value={hostText}
              onChangeText={onChangeHost}
              resolution={resolution}
              showResolution={touched && hostText.trim().length > 0}
              busy={busy}
              onSubmit={doCheck}
              error={hostError}
              recent={recent}
              onPickRecent={onPickRecent}
              onForgetRecent={onForgetRecent}
            />
            <SetupSteps />
            <AwayFromHomeNote />
            <AppearanceRow />
          </>
        ) : null}

        {stage === 'code' && host ? (
          <PairStep
            host={host}
            code={code}
            onChangeCode={onChangeCode}
            onPair={doPair}
            onBack={onBack}
            busy={busy}
            error={pairError}
          />
        ) : null}

        {stage === 'success' && host ? <SuccessCard name={host.name} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Appearance control, parked at the bottom of the first screen. */
function AppearanceRow() {
  const theme = useTheme();
  return (
    <Card padding="sm">
      <Row justify="space-between" gap="sm">
        <Column style={{ flex: 1, paddingLeft: theme.space.xs }}>
          <Label>Appearance</Label>
          <Caption>Follows your device by default.</Caption>
        </Column>
        <ThemeToggle testID="theme-toggle" style={{ width: 190 }} />
      </Row>
    </Card>
  );
}

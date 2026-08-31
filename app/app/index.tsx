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
import { ScanStep } from '../src/connect/scan';
import { ParsedPairLink } from '../src/connect/pair-link';
import { raceAddresses } from '../src/devices/race';
import { useTheme } from '../src/theme';
import {
  Button, Caption, Card, Column, Label, Row, Txt, haptic,
} from '../src/ui';
import { Brand } from '../src/connect/brand';
import { Diagnosis, diagnoseHostFailure, diagnosePairFailure } from '../src/connect/diagnose';
import { forgetHost, loadRecentHosts, prettyHost, rememberHost, resolveHost } from '../src/connect/host-input';
import { AwayFromHomeNote, SetupSteps } from '../src/connect/onboarding';
import { HostStep } from '../src/connect/host-step';
import { planTailnetUpgrade, readTailnetProbe } from '../src/connect/tailnet';
import { TailscaleCard } from '../src/connect/tailscale-card';
import { CODE_LENGTH, HostSummary, PairStep } from '../src/connect/pair-step';
import { ThemeToggle } from '../src/settings/theme-toggle';

type Stage = 'host' | 'scan' | 'code' | 'success';

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

/**
 * The first of a scanned computer's addresses that answers.
 *
 * A QR lists every path the host knows about, and only some of them work from
 * wherever the phone is standing — the LAN address is useless on cellular, and
 * the Tailscale one is useless if Tailscale is not running. They are raced
 * rather than tried in order so a dead candidate costs one abandoned request
 * instead of a visible delay.
 */
async function firstReachable(urls: readonly string[]): Promise<string | null> {
  const winner = await raceAddresses(
    urls.map((url) => ({ url })),
    async (url, signal) => {
      const health = await checkHost(url, signal);
      return { ok: health.ok, hostId: health.id };
    },
  );
  return winner?.url ?? null;
}

/** Offers the scanner from the manual-entry screen. */
function ScanPrompt({ onPress }: { onPress: () => void }) {
  return (
    <Card>
      <Column gap="sm">
        <Txt variant="bodyStrong">Skip the typing</Txt>
        <Caption>
          The host agent prints a QR code when it starts. Scanning it fills in the
          address and the code for you.
        </Caption>
        <Button label="Scan the code" variant="secondary" fullWidth onPress={onPress} testID="scan-btn" />
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
  /**
   * Set when the computer answered but its tailnet address did not, which means
   * Tailscale is off on this phone rather than anything being wrong with the
   * host. Carries the host's name so the card can say which computer is waiting.
   */
  const [tailscaleOff, setTailscaleOff] = useState<string | null>(null);

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
    setTailscaleOff(null);
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

      // Over the owner's own tailnet the host has already verified this phone
      // and will pair without a code: go straight there. If that somehow fails
      // the normal code screen is the fallback, so nothing is lost by trying.
      //
      // When the check landed on a LAN address the host cannot recognise the
      // phone, even though the same phone reaching the same host over Tailscale
      // would pair with no code. The tailnet address is in the reply, so try it
      // rather than making anyone read a 100.x address off another screen.
      const plan = planTailnetUpgrade(result, resolved.url);
      if (plan.kind === 'ready' || plan.kind === 'upgrade') {
        const url = plan.kind === 'upgrade' ? plan.url : resolved.url;
        if (plan.kind === 'upgrade') {
          setBusy(true);
          const probe = await checkHostBounded(url);
          if (!live.current || seq !== checkSeq.current) return;
          setBusy(false);

          const outcome = readTailnetProbe(url, probe);
          if (outcome.kind === 'tailscale-off') {
            setTailscaleOff(result.name || 'Your computer');
            setStage('code');
            return;
          }
          if (outcome.kind === 'code-required') {
            setStage('code');
            return;
          }
        }

        setBusy(true);
        try { await completePairing(url, ''); } finally { if (live.current) setBusy(false); }
        return;
      }
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

  /**
   * Trade a code for a token and save the computer.
   *
   * Shared by the typed flow and the scanned one so the two cannot drift —
   * scanning must produce exactly the same saved computer as typing, including
   * the identity re-read below.
   */
  const completePairing = useCallback(async (hostUrl: string, pairingCode: string) => {
    try {
      const result = await pair(hostUrl, pairingCode, deviceName());
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
      setStage('code');
      setPairError(diagnosePairFailure(hostUrl, errorMessage(e)));
      setCode('');
    }
  }, [addDevice]);

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
      await completePairing(host.url, code);
    } finally {
      setBusy(false);
    }
  }, [host, code, completePairing]);

  /**
   * A scanned link carries the address and the code together, so there is
   * nothing left to type. The addresses are raced rather than assumed: the QR
   * lists every path the host knows, and only one of them is reachable from
   * wherever the phone happens to be standing.
   */
  const onScanned = useCallback(async (link: ParsedPairLink) => {
    setPairError(null);
    setBusy(true);
    try {
      const reachable = await firstReachable(link.addresses);
      if (!reachable) {
        setStage('host');
        setHostError({
          title: `Could not reach ${link.label}`,
          message:
            'The code scanned fine, but none of that computer\'s addresses answered ' +
            'from this network. Check it is awake and on the same Wi-Fi, or use Tailscale.',
        });
        return;
      }
      // Both outcome screens are gated on `host` (`stage === 'code' && host`,
      // `stage === 'success' && host`), so it must be set before the attempt.
      // Without it a failed pair — routine, since codes are single-use and
      // rotate — set the stage but rendered neither branch, stranding the user
      // on a blank screen with no error and no way back.
      setHost({
        url: reachable,
        name: link.label,
        // The link does not carry these; assume capable and unpaired, the same
        // benefit of the doubt `doCheck` gives an older host. Both only shape
        // advisory notes on the code screen, and the post-pair /health re-read
        // saves the computer with its real capabilities regardless.
        native: true,
        paired: false,
      });
      await completePairing(reachable, link.code);
    } finally {
      setBusy(false);
    }
  }, [completePairing]);

  const onBack = useCallback(() => {
    setStage('host');
    setPairError(null);
    setCode('');
    setTailscaleOff(null);
  }, []);

  /**
   * Re-run the whole check after the user turns Tailscale on.
   *
   * Deliberately the same path as the first attempt rather than a direct retry
   * of the tailnet address: with Tailscale up the host's reply may now name
   * addresses it could not before, so the upgrade decides again from scratch.
   */
  const onRetryTailscale = useCallback(() => {
    setTailscaleOff(null);
    setStage('host');
    setCode('');
    setPairError(null);
    void doCheck();
  }, [doCheck]);

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
            <ScanPrompt onPress={() => setStage('scan')} />
            <SetupSteps />
            <AwayFromHomeNote />
            <AppearanceRow />
          </>
        ) : null}

        {stage === 'scan' ? (
          <ScanStep onScanned={(link) => void onScanned(link)} onCancel={() => setStage('host')} />
        ) : null}

        {stage === 'code' && host ? (
          <>
            {/* The one-tap fix goes above the digits: turning Tailscale on is
                easier than reading a code off another screen, and it is what
                makes the computer reachable away from home too. */}
            {tailscaleOff ? (
              <TailscaleCard hostName={tailscaleOff} onRetry={onRetryTailscale} busy={busy} />
            ) : null}
            <PairStep
              host={host}
              code={code}
              onChangeCode={onChangeCode}
              onPair={doPair}
              onBack={onBack}
              busy={busy}
              error={pairError}
            />
          </>
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

// Connect screen — the first thing anyone sees, and the only place the app can
// lose someone entirely.
//
// Two steps: point at the computer (address), then trade the 6-digit code shown
// on it for a token. Around those two steps sits the onboarding a cold start
// needs: what has to be running, what to type, and what to do when it fails.
// A saved connection skips the whole thing.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../src/connection';
import { checkHost, pair } from '../src/api';
import { buildSavedDevice } from '../src/devices/from-host';
import { ScanStep } from '../src/connect/scan';
import { ParsedPairLink } from '../src/connect/pair-link';
import { raceAddresses } from '../src/devices/race';
import { hostIdentityMatches } from '../src/devices/identity';
import { useTheme } from '../src/theme';
import {
  Button, Caption, Micro, Rule, Txt, haptic,
} from '../src/ui';
import { Brand } from '../src/connect/brand';
import { Diagnosis, diagnoseHostFailure, diagnosePairFailure } from '../src/connect/diagnose';
import { forgetHost, loadRecentHosts, prettyHost, rememberHost, resolveHost } from '../src/connect/host-input';
import { AwayFromHomeNote, SetupSteps } from '../src/connect/onboarding';
import { HostStep } from '../src/connect/host-step';
import type { TailnetOutcome } from '../src/connect/tailnet';
import { TAILNET_PROBE_ATTEMPTS, planTailnetUpgrade, readTailnetProbe, tailnetUrlFrom } from '../src/connect/tailnet';
import { TailscaleStep } from '../src/connect/tailscale-card';
import type { PairingDeadEnd } from '../src/connect/dead-end';
import { detectDeadEnd } from '../src/connect/dead-end';
import { NoCodeStep } from '../src/connect/no-code-step';
import { CODE_LENGTH, HostSummary, PairStep } from '../src/connect/pair-step';
import { connectLanding } from '../src/connect/landing';

type Stage = 'host' | 'scan' | 'code' | 'success';

/** How long to wait for `/health` before calling the address unreachable. */
const HOST_CHECK_TIMEOUT_MS = 8000;
/** How long the success notice is shown before the tabs take over. */
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

function SuccessNotice({ name }: { name: string }) {
  const theme = useTheme();
  return (
    <View testID="pair-success" style={{ gap: theme.space.sm }}>
      <Txt variant="label" tone="good">{'\u2713 Paired'}</Txt>
      <Txt variant="subheading">Paired with {name}</Txt>
      <Caption>You will not need the code again on this device.</Caption>
      <Rule bleed={theme.layout.margin} />
    </View>
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
async function firstReachable(
  urls: readonly string[],
  expectedHostId: string,
): Promise<string | null> {
  const winner = await raceAddresses(
    urls.map((url) => ({ url })),
    async (url, signal) => {
      const health = await checkHost(url, signal);
      // The QR names the host's real id, so an address that answers with a
      // *different* id is a different machine on a reused address — reject it
      // rather than pair with, and hand a token to, the wrong computer. Never
      // legacy here: a scanned link always carries a real id.
      const ok = health.ok && hostIdentityMatches(expectedHostId, health.id, false);
      return { ok, hostId: health.id };
    },
  );
  return winner?.url ?? null;
}

/** Offers the scanner from the manual-entry screen. */
function ScanPrompt({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.sm }}>
      <Micro>
        The host agent prints a QR code when it starts. Scanning it fills in everything.
      </Micro>
      <Button label="Scan code" variant="secondary" fullWidth onPress={onPress} testID="scan-btn" />
      <Rule bleed={theme.layout.margin} />
    </View>
  );
}

export default function Connect() {
  const { ready, connection, addDevice, devices, phase } = useConnection();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  // Set by "Add a computer": the redirect below must stand down, or the
  // button that led here just bounces its user straight back.
  const { add } = useLocalSearchParams<{ add?: string }>();
  const adding = add === '1';

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
  /** The last tailnet failure, shown on the card so a stuck setup is diagnosable. */
  const [tailscaleDetail, setTailscaleDetail] = useState<string | null>(null);
  /**
   * Set when the code screen would be a trap: the host is already paired and
   * requires a code from this connection, but a paired host never issues one.
   * Carries what the check saw so the notice can state observation, not guess,
   * and a timestamp for the proof-of-life stamp (docs/DESIGN.md §11.4).
   */
  const [deadEnd, setDeadEnd] = useState<
    (PairingDeadEnd & { readonly checkedAt: number; readonly platform?: string }) | null
  >(null);

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
  // Unless the user came here on purpose to pair another machine — the
  // decision itself lives in connect/landing.ts, where node can test it.
  useEffect(() => {
    const dest = connectLanding({
      ready,
      connected: connection !== null,
      deviceCount: devices.length,
      connecting: phase === 'connecting',
      adding,
    });
    if (dest) router.replace(dest);
  }, [ready, connection, devices.length, phase, adding]);

  useEffect(() => {
    let live = true;
    loadRecentHosts().then((list) => {
      if (!live) return;
      setRecent(list);
      // Pre-fill the last computer used, so the common case is one tap — but
      // not when adding another: the most recent host is by definition the
      // machine already paired, the one address that cannot be the answer.
      if (!adding && list.length > 0) setHostText((current) => current || prettyHost(list[0]));
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
    setTailscaleDetail(null);
    setDeadEnd(null);
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
    setDeadEnd(null);
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

      // Run at every landing on stage 'code': the code screen is only honest
      // work while the host will actually issue a code, and an already-paired
      // host never does. Walking in blind is the exact hour-long trap the
      // dead-end notice exists to prevent.
      const flagDeadEnd = (probe: TailnetOutcome | null): boolean => {
        const dead = detectDeadEnd(result, plan, probe, tailnetUrlFrom(result));
        if (!dead) return false;
        setDeadEnd({ ...dead, checkedAt: Date.now(), platform: result.platform });
        return true;
      };

      if (plan.kind === 'ready' || plan.kind === 'upgrade') {
        const url = plan.kind === 'upgrade' ? plan.url : resolved.url;
        if (plan.kind === 'upgrade') {
          setBusy(true);
          // Retry rather than trust one deadline: the first packet over a cold
          // tailnet waits for the peers to find each other through a relay, and
          // that can outlast a single request on a link that then works fine.
          // One timeout is not evidence that Tailscale is off.
          let outcome = readTailnetProbe(url, { ok: false, error: 'not tried' });
          for (let attempt = 0; attempt < TAILNET_PROBE_ATTEMPTS; attempt += 1) {
            const probe = await checkHostBounded(url);
            if (!live.current || seq !== checkSeq.current) return;
            outcome = readTailnetProbe(url, probe);
            if (outcome.kind !== 'tailscale-off') break;
          }
          setBusy(false);

          if (outcome.kind === 'tailscale-off') {
            // When the host is also already paired, the dead-end notice owns
            // the Tailscale advice — showing both would be two notices making
            // the same point with two accent buttons.
            if (!flagDeadEnd(outcome)) {
              setTailscaleOff(result.name || 'Your computer');
              setTailscaleDetail(outcome.detail ?? null);
            }
            setStage('code');
            return;
          }
          if (outcome.kind === 'code-required') {
            flagDeadEnd(outcome);
            setStage('code');
            return;
          }
        }

        setBusy(true);
        try { await completePairing(url, ''); } finally { if (live.current) setBusy(false); }
        return;
      }
      flagDeadEnd(null);
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
      const reachable = await firstReachable(link.addresses, link.hostId);
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
    setTailscaleDetail(null);
    setDeadEnd(null);
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
    setTailscaleDetail(null);
    setDeadEnd(null);
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
          paddingHorizontal: theme.layout.margin,
          paddingTop: insets.top + theme.space.lg,
          paddingBottom: insets.bottom + theme.space.xl,
          gap: theme.space.lg,
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
            <Rule bleed={theme.layout.margin} />
            <ScanPrompt onPress={() => setStage('scan')} />
            <SetupSteps />
            <AwayFromHomeNote />
            {adding && router.canGoBack() ? (
              <Button
                testID="cancel-add"
                label={'\u2039 Back to My Computers'}
                variant="ghost"
                fullWidth
                onPress={() => router.back()}
              />
            ) : null}
          </>
        ) : null}

        {stage === 'scan' ? (
          <ScanStep onScanned={(link) => void onScanned(link)} onCancel={() => setStage('host')} />
        ) : null}

        {stage === 'code' && host ? (
          <>
            {/* When the host will never issue a code, the dead-end notice owns
                the top of the screen and the accent: it states what was seen
                and routes forward (Tailscale, or the reset on the computer).
                The code entry survives below it, demoted, because the phone's
                knowledge goes stale the moment someone resets pairing on the
                computer — but nothing pretends a code exists right now. */}
            {deadEnd ? (
              <NoCodeStep
                hostName={host.name}
                platform={deadEnd.platform}
                standing={deadEnd.standing}
                detail={deadEnd.detail}
                checkedAt={deadEnd.checkedAt}
                onRecheck={onRetryTailscale}
                busy={busy}
              />
            ) : null}
            {/* The one-tap fix goes above the digits: turning Tailscale on is
                easier than reading a code off another screen, and it is what
                makes the computer reachable away from home too. While it is
                shown it holds the screen's accent; Pair demotes to fallback. */}
            {!deadEnd && tailscaleOff ? (
              <TailscaleStep
                hostName={tailscaleOff}
                detail={tailscaleDetail}
                onRetry={onRetryTailscale}
                busy={busy}
              />
            ) : null}
            <PairStep
              host={host}
              code={code}
              onChangeCode={onChangeCode}
              onPair={doPair}
              onBack={onBack}
              busy={busy}
              error={pairError}
              primary={!tailscaleOff && !deadEnd}
              codeUnlikely={Boolean(deadEnd)}
            />
          </>
        ) : null}

        {stage === 'success' && host ? <SuccessNotice name={host.name} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

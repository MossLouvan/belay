// Sign in — the first screen on a fresh install, before any computer is paired
// (account/gate.ts says when). Three routes into one account: Apple, Google
// (once client ids exist), and a 6-digit email code. Brand block centred as the
// connect screen's is (DESIGN.md §2.6); one accent button per stage.

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { IconBrandApple, IconBrandGoogle, IconMail } from '@tabler/icons-react-native';

import { Banner, Button, Caption, Heading, Input, Screen, Txt, haptic } from '../ui';
import { useTheme } from '../theme';
import { Brand } from '../connect/brand';
import { CodeInput } from '../connect/code-input';
import { errorMessage } from '../connect/pair-flow';
import { useAccount } from './store';
import { GOOGLE_SIGN_IN_ENABLED, appleSignInAvailable, signInWithApple, signInWithGoogle } from './providers';

type Stage = 'pick' | 'email' | 'code';
const CODE_LENGTH = 6;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignInScreenProps {
  /** Called once a session is stored; the route decides where to go. */
  readonly onSignedIn: () => void;
}

export function SignInScreen({ onSignedIn }: SignInScreenProps) {
  const theme = useTheme();
  const { api, signIn } = useAccount();
  const [stage, setStage] = useState<Stage>('pick');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => { appleSignInAvailable().then(setAppleAvailable); }, []);

  /** Run one sign-in attempt with the shared busy/error plumbing. */
  const attempt = useCallback(async (run: () => Promise<boolean>) => {
    setBusy(true);
    setError(null);
    try {
      if (await run()) { haptic('success'); onSignedIn(); }
    } catch (e: unknown) {
      haptic('error');
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [onSignedIn]);

  const onApple = useCallback(() => attempt(async () => {
    const cred = await signInWithApple(await api.nonce());
    if (!cred) return false;
    await signIn(await api.signInApple(cred.identityToken, cred.nonce));
    return true;
  }), [attempt, api, signIn]);

  const onGoogle = useCallback(() => attempt(async () => {
    const cred = await signInWithGoogle();
    if (!cred) return false;
    await signIn(await api.signInGoogle(cred.idToken));
    return true;
  }), [attempt, api, signIn]);

  const onSendCode = useCallback(() => {
    if (!EMAIL_SHAPE.test(email.trim())) { setError('Enter your email address.'); return; }
    void attempt(async () => {
      await api.startEmail(email);
      setCode('');
      setStage('code');
      return false;
    });
  }, [attempt, api, email]);

  const onVerify = useCallback(() => {
    if (code.length !== CODE_LENGTH) { setError(`Enter all ${CODE_LENGTH} digits.`); return; }
    void attempt(async () => {
      await signIn(await api.verifyEmail(email, code));
      return true;
    });
  }, [attempt, api, signIn, email, code]);

  const back = useCallback((to: Stage) => { setError(null); setStage(to); }, []);

  return (
    <Screen scroll padding="page" contentStyle={{ justifyContent: 'center', flexGrow: 1 }}>
      <View style={{ gap: theme.space.lg }} testID="sign-in-screen">
        <Brand />

        {stage === 'pick' ? (
          <View style={{ gap: theme.space.sm }}>
            <View style={{ gap: theme.space.xs, marginBottom: theme.space.sm }}>
              <Heading>Sign in to Belay</Heading>
              <Txt tone="dim">Your account links your phone to your computers, so they can find each other from anywhere.</Txt>
            </View>
            {appleAvailable ? (
              <Button
                label="Continue with Apple" testID="sign-in-apple" fullWidth size="lg" loading={busy}
                icon={<IconBrandApple size={20} color={theme.colors.onAccent} />}
                onPress={() => void onApple()}
              />
            ) : null}
            {GOOGLE_SIGN_IN_ENABLED ? (
              <Button
                label="Continue with Google" testID="sign-in-google" fullWidth size="lg" variant="secondary" disabled={busy}
                icon={<IconBrandGoogle size={20} color={theme.colors.text} />}
                onPress={() => void onGoogle()}
              />
            ) : null}
            <Button
              label="Continue with email" testID="sign-in-email" fullWidth size="lg"
              variant={appleAvailable ? 'secondary' : 'primary'} disabled={busy}
              icon={<IconMail size={20} color={appleAvailable ? theme.colors.text : theme.colors.onAccent} />}
              onPress={() => back('email')}
            />
          </View>
        ) : stage === 'email' ? (
          <View style={{ gap: theme.space.md }}>
            <Heading>What is your email?</Heading>
            <Input
              label="Email" testID="sign-in-email-field" value={email} onChangeText={setEmail}
              placeholder="you@example.com" keyboardType="email-address" autoFocus
              returnKeyType="go" onSubmitEditing={onSendCode} editable={!busy}
              helper="We will send a 6-digit code. No password."
            />
            <Button label="Send code" testID="send-code" fullWidth loading={busy} onPress={onSendCode} />
            <Button label="Back" variant="ghost" fullWidth disabled={busy} onPress={() => back('pick')} />
          </View>
        ) : (
          <View style={{ gap: theme.space.md }}>
            <View style={{ gap: theme.space.xs }}>
              <Heading>Enter the code</Heading>
              <Caption>{`Sent to ${email.trim()}. It expires in 10 minutes.`}</Caption>
            </View>
            <CodeInput
              value={code} onChange={(next) => { setCode(next); setError(null); }} onSubmit={onVerify}
              length={CODE_LENGTH} editable={!busy} invalid={error !== null} autoFocus testID="sign-in-code"
              accessibilityLabel="Sign-in code, 6 digits" accessibilityHint="Enter the code from the email Belay sent you"
            />
            <Button label="Sign in" testID="verify-code" fullWidth loading={busy} onPress={onVerify} />
            <Button label="Send a new code" variant="ghost" fullWidth disabled={busy} onPress={onSendCode} />
            <Button label="Use a different email" variant="ghost" fullWidth disabled={busy} onPress={() => back('email')} />
          </View>
        )}

        {error ? <Banner status="bad" title="Could not sign in" message={error} testID="sign-in-error" /> : null}
      </View>
    </Screen>
  );
}

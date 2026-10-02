// The two federated sign-in routes. Each returns what POST /auth/* wants, or
// null when the person cancelled; anything else throws with a usable message.

import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { sha256, toHex, utf8 } from '../devices/hmac';
import { randomBytes } from '../devices/pinning';

export interface AppleCredential {
  readonly identityToken: string;
  /** The raw nonce; its SHA-256 is what Apple put in the token's `nonce` claim. */
  readonly nonce: string;
}

/** iOS only, and only on a native build that includes the module (app.json plugin). */
export async function appleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  return AppleAuthentication.isAvailableAsync().catch(() => false);
}

export async function signInWithApple(): Promise<AppleCredential | null> {
  const nonce = toHex(randomBytes(32));
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: toHex(sha256(utf8(nonce))),
    });
    if (!credential.identityToken) throw new Error('Apple did not return a sign-in token. Try again.');
    return { identityToken: credential.identityToken, nonce };
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'ERR_REQUEST_CANCELED') return null;
    throw e;
  }
}

/**
 * Google: wired to the contract (POST /auth/google {idToken}) but not to a
 * provider yet. expo-auth-session is not a dependency and there are no Google
 * client ids. Set EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID (and the Android/web ids)
 * and implement this with expo-auth-session's Google provider; the button
 * shows only once the id is configured.
 */
export const GOOGLE_SIGN_IN_ENABLED = Boolean(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);

export async function signInWithGoogle(): Promise<{ idToken: string } | null> {
  // TODO(google): expo-auth-session Google provider → response.params.id_token.
  throw new Error('Google sign-in is not set up in this build yet. Use Apple or email.');
}

// Sign-in route. Composition only (src/account/sign-in-screen.tsx is the
// screen): on success go wherever `next` says, else back to the front door.

import React, { useCallback } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { SignInScreen } from '../src/account/sign-in-screen';

export default function SignIn() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const onSignedIn = useCallback(() => {
    // Only our own routes: `next` arrives through a URL on web.
    const dest = typeof next === 'string' && next.startsWith('/') ? next : '/';
    router.replace(dest as never);
  }, [next]);
  return <SignInScreen onSignedIn={onSignedIn} />;
}

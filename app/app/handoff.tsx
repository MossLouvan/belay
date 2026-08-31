// "Open on the computer" — walk up to the machine and find this conversation
// already in a terminal there, instead of running `npm run sessions` and
// pasting. The screen asks the host to open it the moment it appears; the
// interesting states are the honest ones:
//
//  - busy: the phone is still driving this session. The host refused to touch
//    it, and the choice is put here in full — stopping mid-task is the price
//    of the handoff, named before it happens. There is deliberately no "just
//    copy the command" escape in this state: pasting `claude --resume` while
//    the phone's process is alive is exactly the two-clients corruption the
//    refusal exists to prevent.
//  - fallback: no window could open (headless host, AppleScript refused), but
//    the phone side was already released, so the exact command is shown to
//    copy — which is what the user did manually before this screen existed.
//
// Navigate here with:
//   router.push({ pathname: '/handoff', params: { session, title, cwd } })

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  Screen, Row, Heading, Label, Micro, Mono, Txt, Button, IconButton, Rule,
  EmptyState, Skeleton,
} from '../src/ui';
import { useTheme } from '../src/theme';
import { copyText } from '../src/files/clipboard';
import { requestHandoff } from '../src/handoff/handoff-api';
import { busyExplanation, openedNote } from '../src/handoff/handoff-model';
import type { HandoffOutcome } from '../src/handoff/handoff-model';

type Phase =
  | { readonly state: 'asking' }
  | { readonly state: 'error'; readonly message: string }
  | { readonly state: 'done'; readonly outcome: HandoffOutcome };

/** The command block plus its copy button — shared by fallback and success. */
function CommandBlock({ command }: { command: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    setCopied(await copyText(command));
  }, [command]);
  return (
    <View style={{ gap: theme.space.sm, alignItems: 'flex-start' }}>
      <Mono testID="handoff-command" style={{ color: theme.colors.text }}>
        {command}
      </Mono>
      <Button
        testID="handoff-copy"
        label={copied ? 'Copied' : 'Copy command'}
        variant="secondary"
        size="sm"
        onPress={() => void onCopy()}
      />
    </View>
  );
}

export default function Handoff() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ session?: string; title?: string; cwd?: string }>();
  const sessionId = typeof params.session === 'string' ? params.session : '';

  const [phase, setPhase] = useState<Phase>({ state: 'asking' });

  const ask = useCallback(async (stop: boolean) => {
    setPhase({ state: 'asking' });
    try {
      const outcome = await requestHandoff(sessionId, stop);
      setPhase({ state: 'done', outcome });
    } catch (e: unknown) {
      setPhase({ state: 'error', message: e instanceof Error ? e.message : 'something went wrong' });
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) void ask(false);
  }, [sessionId, ask]);

  const margin = theme.layout.margin;

  const header = (
    <View style={{ paddingTop: theme.space.md }}>
      <Row justify="space-between" align="flex-end" gap="sm">
        <Heading>Open on the computer</Heading>
        {router.canGoBack() ? (
          <IconButton accessibilityLabel="Back" variant="plain" onPress={() => router.back()}>
            <Txt variant="title" tone="dim">{'‹'}</Txt>
          </IconButton>
        ) : null}
      </Row>
      {params.title || params.cwd ? (
        <Micro numberOfLines={1} style={{ marginTop: theme.space.xs }}>
          {String(params.title || params.cwd)}
        </Micro>
      ) : null}
      <Rule bleed={margin} style={{ marginTop: theme.space.md }} />
    </View>
  );

  if (!sessionId) {
    return (
      <Screen padding="page">
        {header}
        <EmptyState
          title="No session"
          message="This screen hands a Claude session to the computer's own terminal, and no session was given."
          action={{ label: 'Go back', onPress: () => router.back() }}
        />
      </Screen>
    );
  }

  if (phase.state === 'asking') {
    return (
      <Screen padding="page">
        {header}
        <View style={{ gap: theme.space.sm, marginTop: theme.space.md }}>
          <Label>ASKING THE COMPUTER…</Label>
          <Skeleton width="80%" />
          <Skeleton width="60%" />
        </View>
      </Screen>
    );
  }

  if (phase.state === 'error') {
    // §11.4 anatomy: state name, the observed fact, one way forward.
    return (
      <Screen padding="page">
        {header}
        <View style={{ marginTop: theme.space.lg, gap: theme.space.sm, alignItems: 'flex-start' }}>
          <Label style={{ color: theme.colors.bad }}>CAN’T HAND OFF</Label>
          <Txt variant="body" tone="dim">{phase.message}</Txt>
          <Button label="Try again" onPress={() => void ask(false)} variant="primary" size="sm" />
        </View>
      </Screen>
    );
  }

  const { outcome } = phase;

  if (outcome.kind === 'busy') {
    return (
      <Screen padding="page">
        {header}
        <View style={{ marginTop: theme.space.lg, gap: theme.space.md }}>
          <Label style={{ color: theme.colors.warn }}>
            {outcome.status === 'waiting' ? 'WAITING FOR AN APPROVAL' : 'STILL RUNNING HERE'}
          </Label>
          <Txt variant="body">{busyExplanation(outcome.status)}</Txt>
          <Row gap="sm">
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="secondary" fullWidth onPress={() => router.back()} />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                testID="handoff-stop-open"
                label="Stop here, open there"
                variant="danger"
                fullWidth
                onPress={() => void ask(true)}
              />
            </View>
          </Row>
        </View>
      </Screen>
    );
  }

  if (outcome.kind === 'fallback') {
    return (
      <Screen padding="page">
        {header}
        <View style={{ marginTop: theme.space.lg, gap: theme.space.md, alignItems: 'flex-start' }}>
          <Label style={{ color: theme.colors.warn }}>NO WINDOW OPENED</Label>
          <Txt variant="body" tone="dim">
            {`The computer said: ${outcome.reason}. The phone has let go of this session, so paste this into any terminal there to pick it up:`}
          </Txt>
          <CommandBlock command={outcome.command} />
          <Button label="Done" variant="secondary" size="sm" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen padding="page">
      {header}
      <View style={{ marginTop: theme.space.lg, gap: theme.space.md, alignItems: 'flex-start' }}>
        <Label style={{ color: theme.colors.good }}>{`OPENED IN ${outcome.terminal.toUpperCase()}`}</Label>
        <Txt variant="body">{openedNote(outcome.terminal, outcome.stopped)}</Txt>
        <CommandBlock command={outcome.command} />
        <Button label="Done" variant="primary" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

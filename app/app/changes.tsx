// "What changed" — the review half of supervising a Claude session from the
// phone (docs/PRODUCT-REVIEW.md, A4). Opened with a session id (plus its
// title and folder for the header), or with just the folder for a plain
// terminal session's done notice (#127), it asks the host what Claude actually did
// to the files and leads with the host's plain-English verdict: cautions
// first, in the status colour, then the headline, then the file list, then
// the full line-by-line change for whoever wants the detail.
//
// The order is the point. The reader is deciding whether to trust the work
// from a coffee queue; anything alarming must be the first thing on screen,
// and the reassuring sentence must never render above it.
//
// Navigate here with:
//   router.push({ pathname: '/changes', params: { session, title, cwd } })

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  Screen, Row, Heading, Label, Micro, Txt, Button, IconButton,
  LedgerRow, Rule, Section, Skeleton, EmptyState,
} from '../src/ui';
import { useTheme } from '../src/theme';
import { useConnection } from '../src/connection';
import { hostSettled } from '../src/connection-gate';
import { fetchChanges } from '../src/changes/changes-api';
import type { ProjectChanges } from '../src/changes/changes-api';
import { kindWord, countBadge } from '../src/changes/diff-format';
import { DiffBody } from '../src/changes/diff-body';

type Phase =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly message: string; readonly at: number }
  | { readonly state: 'ready'; readonly data: ProjectChanges; readonly at: number };

const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function Changes() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ session?: string; title?: string; cwd?: string }>();
  const sessionId = typeof params.session === 'string' ? params.session : '';
  // A plain terminal session has no Belay id: its done notice opens by folder.
  const cwd = typeof params.cwd === 'string' ? params.cwd : '';

  const [phase, setPhase] = useState<Phase>({ state: 'loading' });

  const load = useCallback(async () => {
    setPhase({ state: 'loading' });
    try {
      const data = await fetchChanges({ session: sessionId, cwd });
      setPhase({ state: 'ready', data, at: Date.now() });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'something went wrong';
      setPhase({ state: 'error', message, at: Date.now() });
    }
  }, [sessionId, cwd]);

  // On a reload or deep link the saved connection is still racing when this
  // mounts; a load fired then fails "not connected" and would never re-run
  // (#85). Wait for the attempt to settle, and re-check on every reconnect.
  const { ready, phase: connPhase } = useConnection();
  const settled = hostSettled(ready, connPhase);
  useEffect(() => { if (settled) void load(); }, [load, settled, connPhase]);

  // Opened by URL there is no history, so a bare back() is a dead button (#84).
  const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/agent'); };

  const margin = theme.layout.margin;

  const header = (
    <View style={{ paddingTop: theme.space.md }}>
      <Row justify="space-between" align="flex-end" gap="sm">
        <Heading>What changed</Heading>
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
    // Reached without a session — a stale deep link, not a host problem.
    return (
      <Screen padding="page">
        {header}
        <EmptyState
          title="No session"
          message="This screen shows what a Claude session changed, and no session was given."
          action={{ label: 'Go back', onPress: leave }}
        />
      </Screen>
    );
  }

  if (phase.state === 'loading') {
    return (
      <Screen padding="page">
        {header}
        <View style={{ gap: theme.space.sm, marginTop: theme.space.md }}>
          <Skeleton width="90%" />
          <Skeleton width="70%" />
          <Skeleton width="100%" height={120} />
        </View>
      </Screen>
    );
  }

  if (phase.state === 'error') {
    // §11.4 anatomy: state name, the observed fact, one way forward, proof of
    // life. The message is the host's own user-safe wording (or the client's
    // "didn't answer in time").
    return (
      <Screen padding="page">
        {header}
        <View style={{ marginTop: theme.space.lg, gap: theme.space.sm, alignItems: 'flex-start' }}>
          <Label style={{ color: theme.colors.bad }}>CAN’T CHECK</Label>
          <Txt variant="body" tone="dim">{phase.message}</Txt>
          <Button label="Retry" onPress={() => void load()} variant="primary" size="sm" />
          <Micro>LAST TRIED {timeOf(phase.at).toUpperCase()}</Micro>
        </View>
      </Screen>
    );
  }

  const { data, at } = phase;
  const checked = `CHECKED ${timeOf(at).toUpperCase()}`;

  if (!data.repo || data.clean) {
    return (
      <Screen padding="page">
        {header}
        <EmptyState
          title={data.repo ? 'No changes' : 'No history here'}
          message={data.summary.headline}
          action={{ label: 'Check again', onPress: () => void load() }}
        />
        <Micro>{checked}</Micro>
      </Screen>
    );
  }

  return (
    <Screen scroll padding="page">
      {header}
      <View style={{ gap: theme.space.lg, marginTop: theme.space.md }}>
        <Section label="SUMMARY" bleed={margin}>
          <View style={{ gap: theme.space.sm, paddingBottom: theme.space.sm }}>
            {data.summary.cautions.map((caution, index) => (
              <Txt key={index} variant="body" color={theme.colors.warn}>
                {caution}
              </Txt>
            ))}
            <Txt variant="body">{data.summary.headline}</Txt>
            <Micro>{checked}</Micro>
          </View>
        </Section>

        <Section label={`FILES · ${data.files.length}`} bleed={margin}>
          {data.files.map((file, index) => (
            <LedgerRow
              key={file.path}
              label={kindWord(file.kind)}
              value={[file.path, countBadge(file.added, file.removed, file.binary)].filter(Boolean).join('  ')}
              valueTone={file.kind === 'deleted' ? 'bad' : 'default'}
              rule={index < data.files.length - 1}
              bleed={margin}
            />
          ))}
        </Section>

        <Section label="LINE BY LINE" bleed={margin} rule={false}>
          <DiffBody diff={data.diff} truncated={data.diffTruncated} bleed={margin} />
        </Section>

        <Button label="Check again" variant="secondary" onPress={() => void load()} />
      </View>
    </Screen>
  );
}

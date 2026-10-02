// The Agent tab's home: Belay's own sessions, the "On this PC" list of Claude
// Code sessions found on disk to watch or take over, and the project picker
// for a new one.
//
// Structure (Next Terminal sweep): a small stat strip — RUNNING / WAITING /
// SPEND as thin-bordered stat cards — then each list as hairline-divided rows
// inside a flush Card, like the reference's "Latest Sessions" table. Colour is
// rationed: blue only for the active/primary, a small amber dot for a session
// waiting on you, everything else navy and ink. Dots are steady — a hollow
// ring while running, a filled disc otherwise — never a pulse.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { api } from '../api';
import type { AgentProject, AgentSessionMeta, DiscoveredSession } from '../api';
import { useTheme } from '../theme';
import {
  Badge, Banner, Button, Caption, Card, ConnectionStatus, Divider, EmptyState, Input, Label, Row, Rule, Section, Skeleton, TrackLabel, Txt, haptic,
} from '../ui';
import { useConnection } from '../connection';
import { SwitchComputerLink } from '../devices/switch-link';
import { formatAsOf } from '../files-format';
import { getAttention, refreshAttention, refreshDiscovered, refreshHooks, useAgentAttention } from './attention-store';
import { pathPlaceholder } from './new-project';
import { combineLedgers, foldCosts, ledgerLine } from './cost-ledger';
import type { CostLedger } from './cost-ledger';
import { NewProjectSheet } from './new-project-sheet';
import { fleetCounts, fleetRows } from './fleet';
import { FleetBoard, FleetStrip, HooksBanner, PromptNotices } from './fleet-list';

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/** When this changes, some session finished or appeared and its spend moved. */
const ledgerSigOf = (metas: readonly AgentSessionMeta[]): string =>
  metas.map((m) => `${m.id}:${m.status}`).join('|');

interface Availability {
  readonly available: boolean;
  /** Absent on hosts older than the field — then no banner (#128). */
  readonly hooksInstalled?: boolean;
}

// --- session list ------------------------------------------------------------

export function SessionList({
  onOpen,
  onWatch,
}: {
  onOpen: (id: string) => void;
  /** Open a terminal-started session read-only (TranscriptView). */
  onWatch: (session: DiscoveredSession) => void;
}) {
  const theme = useTheme();
  // Sessions come from the shared attention store, which polls while the app
  // is open — the status words and dots here are live, not a snapshot from
  // whenever the tab mounted. Fetching once and letting the badges go stale
  // was this screen's worst lie: it showed "running" over a session that had
  // been waiting on an approval for ten minutes.
  // The discovered list rides the same store and the same push socket, so a
  // session started in a terminal shows here within seconds of its first
  // write — no 30-second wait, no pull.
  // Terminal-session asks (the host's Claude Code hook) ride it too.
  const { sessions, discovered, hooks, fetchedAt, error: pollError } = useAgentAttention();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [picking, setPicking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [ledgers, setLedgers] = useState<Readonly<Record<string, CostLedger>>>({});
  const live = useRef(true);
  const ledgerSig = useRef('');

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Per-session spend, folded on the phone from each session's stored events
  // (the list endpoint carries no costs and the host is left alone). A
  // session whose snapshot won't load keeps its row and simply shows no
  // spend — cost is a nicety, never a reason to lose the list.
  const loadLedgers = useCallback(async (metas: readonly AgentSessionMeta[]) => {
    ledgerSig.current = ledgerSigOf(metas);
    const entries = await Promise.all(
      metas.map(async (m): Promise<readonly [string, CostLedger] | null> => {
        try {
          const snap = await api.agentSnapshot(m.id);
          return [m.id, foldCosts(snap.events)] as const;
        } catch {
          return null;
        }
      }),
    );
    if (!live.current) return;
    setLedgers(Object.fromEntries(entries.filter((e): e is readonly [string, CostLedger] => e !== null)));
  }, []);

  // Refetch when the set of sessions changes or one stops running — that is
  // exactly when a turn has finished and the totals have moved. The signature
  // check keeps the 3-second attention poll from re-downloading snapshots.
  useEffect(() => {
    if (sessions && ledgerSigOf(sessions) !== ledgerSig.current) void loadLedgers(sessions);
  }, [sessions, loadLedgers]);

  const refresh = useCallback(async () => {
    try {
      const [status] = await Promise.all([
        api.agentStatus(),
        // Both lists refresh through the shared store, so this pull also
        // snaps the badge and banner current. Discovery is a nicety there: a
        // host that cannot scan ~/.claude never takes the session list down.
        refreshAttention(),
        refreshDiscovered(),
        refreshHooks(),
      ]);
      if (!live.current) return;
      setAvailability(status);
      setNow(Date.now());
      setError('');
    } catch (e: unknown) {
      if (live.current) setError(messageOf(e, 'could not reach the host'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every store poll re-dates the relative times and countdowns on the rows.
  useEffect(() => {
    if (fetchedAt) setNow(Date.now());
  }, [fetchedAt]);

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    // A deliberate pull re-pulls the money too, even when no status changed —
    // a turn can finish and re-idle between polls without moving the signature.
    await loadLedgers(getAttention().sessions ?? []);
    if (live.current) setRefreshing(false);
  }, [refresh, loadLedgers]);

  const remove = useCallback((id: string) => {
    haptic('warning');
    api.agentDelete(id)
      .then(refresh)
      .catch((e: unknown) => { if (live.current) setError(messageOf(e, 'could not remove the session')); });
  }, [refresh]);

  if (picking) {
    return (
      <ProjectPicker
        onCancel={() => setPicking(false)}
        onCreated={(id) => {
          setPicking(false);
          onOpen(id);
        }}
      />
    );
  }

  const unavailable = availability?.available === false;
  // One list over every source, needs-you first (#124) — and the strip counts
  // the same rows, so the numbers and the list can never disagree.
  const rows = fleetRows(sessions, discovered, hooks);
  const counts = fleetCounts(sessions, discovered, hooks, now);
  const prompts = (hooks?.notices ?? []).filter((n) => n.kind !== 'done');
  const margin = theme.layout.margin;
  // The running total across every session — the strip's SPEND stat.
  const totalLine = ledgerLine(combineLedgers((sessions ?? []).map((s) => ledgers[s.id]).filter((l): l is CostLedger => l !== undefined)));

  return (
    <ScrollView
      testID="agent-list"
      contentContainerStyle={{ paddingHorizontal: margin, paddingTop: theme.space.md, paddingBottom: theme.space.lg }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} tintColor={theme.colors.accent} />}
    >
      <Txt variant="display" heading>Agent</Txt>
      {/* Use ConnectionStatus for consistent non-overlapping layout across all
          tabs. The freshness stamp (formatAsOf) is the visible twin of
          pull-to-refresh: it proves the rows below are live while the
          attention store polls, and dates them honestly when they stop. */}
      <ConnectionStatus
        phase={error || pollError ? 'unreachable' : 'connected'}
        detail={fetchedAt ? formatAsOf(fetchedAt) : undefined}
        trailing={<SwitchComputerLink />}
        style={{ marginTop: theme.space.xxs }}
        testID="agent-status"
      />
      <Rule bleed={margin} style={{ marginTop: theme.space.md, marginBottom: theme.space.lg }} />

      {/* The store swallows its own fetch failures into `pollError`, so a
          failing /agent/sessions must surface here too, not just dim the
          status line (#74). */}
      {error || pollError ? (
        <Banner testID="agent-error" status="bad" title="Could not read the host" message={error || pollError} action={{ label: 'Try again', onPress: () => void refresh() }} style={{ marginBottom: theme.space.md }} />
      ) : null}

      {unavailable ? (
        <Banner
          testID="agent-unavailable"
          status="warn"
          title="Claude Code is not on this PC"
          message="The claude CLI was not found on the computer's PATH. Install Claude Code there, then restart the Belay host."
          style={{ marginBottom: theme.space.md }}
        />
      ) : null}

      <FleetStrip counts={counts} spend={totalLine} />

      {availability?.hooksInstalled === false ? <HooksBanner /> : null}

      {sessions === null && !error && !pollError ? (
        <Card flush>
          {Array.from({ length: 3 }, (_, i) => (
            <View key={i}>
              {i > 0 ? <Divider /> : null}
              <View style={{ paddingHorizontal: theme.space.md, paddingVertical: theme.space.sm, gap: theme.space.xs }}>
                <Skeleton width={`${44 + i * 10}%`} height={15} />
                <Skeleton width={`${58 + i * 8}%`} height={10} />
              </View>
            </View>
          ))}
        </Card>
      ) : (
        <FleetBoard
          rows={rows}
          ledgers={ledgers}
          now={now}
          onOpen={onOpen}
          onWatch={onWatch}
          onRemove={remove}
          newSession={
            <TrackLabel
              testID="agent-new"
              label="+ New session"
              onPress={() => setPicking(true)}
              disabled={unavailable}
              inks={{ restLabel: theme.colors.accent }}
            />
          }
          empty={unavailable ? null : (
            <Card>
              <EmptyState
                testID="agent-empty"
                title="No agents yet"
                message="Start one in a project folder and tell Claude what to build — you approve every action from here. Sessions you start in a terminal on the computer show up here too."
                action={{ label: 'New session', onPress: () => setPicking(true) }}
              />
            </Card>
          )}
        />
      )}

      <PromptNotices notices={prompts} onWatch={onWatch} />
    </ScrollView>
  );
}

// --- project picker ----------------------------------------------------------

export function ProjectPicker({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const theme = useTheme();
  const platform = useConnection().active?.platform;
  const [projects, setProjects] = useState<readonly AgentProject[] | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);

  // A failed scan keeps `projects` null: `[]` would read as a successful
  // empty scan and show "No git repositories were found" under the error (#79).
  const scan = useCallback(() => {
    setError('');
    api.agentProjects()
      .then((r) => { if (live.current) setProjects(r.projects); })
      .catch((e: unknown) => { if (live.current) setError(messageOf(e, 'could not list projects')); });
  }, []);

  useEffect(() => {
    live.current = true;
    scan();
    return () => {
      live.current = false;
    };
  }, [scan]);

  const create = useCallback(async (cwd: string) => {
    const target = cwd.trim();
    if (!target || busy) return;
    setBusy(target);
    setError('');
    try {
      const snap = await api.agentCreate(target);
      if (live.current) onCreated(snap.id);
    } catch (e: unknown) {
      if (live.current) {
        setError(messageOf(e, 'could not start a session there'));
        setBusy(null);
      }
    }
  }, [busy, onCreated]);

  // A freshly made folder becomes the selected project by starting a session
  // in it straight away — that is what "selected" means on this screen. It is
  // also put at the head of the list, so if starting the session fails (the
  // host got as far as mkdir and then hiccuped) the folder is not lost.
  const created = useCallback((p: AgentProject) => {
    setCreating(false);
    setProjects((prev) => [{ ...p, recent: true }, ...(prev ?? []).filter((x) => x.path !== p.path)]);
    void create(p.path);
  }, [create]);

  const margin = theme.layout.margin;

  return (
    <ScrollView
      testID="agent-picker"
      contentContainerStyle={{ paddingHorizontal: margin, paddingTop: theme.space.md, paddingBottom: theme.space.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <Row justify="space-between" align="flex-end" gap="sm">
        <Txt variant="title" heading>New session</Txt>
        <TrackLabel testID="agent-cancel" label="Cancel" onPress={onCancel} />
      </Row>
      <Label style={{ marginTop: theme.space.xxs, marginBottom: 0 }}>Pick where Claude works</Label>
      <Rule bleed={margin} style={{ marginTop: theme.space.md, marginBottom: theme.space.lg }} />

      <NewProjectSheet
        visible={creating}
        projects={projects ?? []}
        onClose={() => setCreating(false)}
        onCreated={created}
      />

      {error ? (
        <Banner
          testID="agent-picker-error"
          status="bad"
          message={error}
          action={projects === null ? { label: 'Try again', onPress: scan } : undefined}
          style={{ marginBottom: theme.space.md }}
        />
      ) : null}

      <Input
        testID="agent-cwd"
        label="Folder on the PC"
        value={manual}
        onChangeText={setManual}
        placeholder={pathPlaceholder(platform, 'project')}
        mono
        returnKeyType="go"
        onSubmitEditing={() => void create(manual)}
        accessibilityLabel="Project folder path"
        trailing={
          <Button
            testID="agent-start"
            label="Start"
            size="sm"
            onPress={() => void create(manual)}
            loading={busy !== null && busy === manual.trim()}
            disabled={!manual.trim()}
          />
        }
      />

      <View style={{ marginTop: theme.space.lg }}>
        {projects === null ? error ? null : (
          <Card flush>
            {Array.from({ length: 4 }, (_, i) => (
              <View key={i}>
                {i > 0 ? <Divider /> : null}
                <View style={{ paddingHorizontal: theme.space.md, paddingVertical: theme.space.sm, gap: theme.space.xs }}>
                  <Skeleton width={`${40 + i * 10}%`} height={15} />
                  <Skeleton width="75%" height={11} />
                </View>
              </View>
            ))}
          </Card>
        ) : projects.length > 0 ? (
          <Section
            label="Projects found"
            rule={false}
            trailing={
              <TrackLabel
                testID="agent-create-project"
                label="+ New project"
                onPress={() => setCreating(true)}
                inks={{ restLabel: theme.colors.accent }}
              />
            }
          >
            <Card flush>
              {projects.map((p, i) => (
                <View key={p.path}>
                  {i > 0 ? <Divider /> : null}
                  <Pressable
                    testID={`agent-proj-${p.name}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Start a session in ${p.name}`}
                    disabled={busy !== null}
                    onPress={() => {
                      haptic('light');
                      void create(p.path);
                    }}
                    style={({ pressed }) => ({
                      minHeight: theme.layout.rowHeight,
                      justifyContent: 'center',
                      gap: 2,
                      paddingHorizontal: theme.space.md,
                      paddingVertical: theme.space.xs,
                      opacity: pressed || busy === p.path ? theme.motion.pressOpacity : 1,
                    })}
                  >
                    <Row justify="space-between" gap="sm">
                      <Txt variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>{p.name}</Txt>
                      {p.recent ? <Badge label="recent" status="accent" /> : null}
                    </Row>
                    <Txt variant="monoSmall" tone="faint" numberOfLines={1}>{p.path}</Txt>
                  </Pressable>
                </View>
              ))}
            </Card>
          </Section>
        ) : (
          <View style={{ gap: theme.space.sm }}>
            <Caption>No git repositories were found under the PC's home or Documents folder. Type a path above, or start fresh.</Caption>
            <Button testID="agent-create-project" label="+ New project" variant="secondary" onPress={() => setCreating(true)} />
          </View>
        )}
      </View>
    </ScrollView>
  );
}

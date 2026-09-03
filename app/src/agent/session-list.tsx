// The Agent tab's home: Belay's own sessions, the "On this PC" list of Claude
// Code sessions found on disk to resume, and the project picker for a new one.
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
import type { AgentProject, AgentSessionMeta, AgentStatus, DiscoveredSession } from '../api';
import { useTheme } from '../theme';
import {
  Badge, Banner, Button, Caption, Card, Divider, Dot, EmptyState, IconButton, Input, Label, Micro, Row, Rule, Section, Skeleton, TrackLabel, Txt, haptic,
} from '../ui';
import { SwitchComputerLink } from '../devices/switch-link';
import { formatAsOf } from '../files-format';
import { ago, groupDiscovered, statusLabel } from './model';
import { askSummary, countdown } from './attention';
import { getAttention, refreshAttention, useAgentAttention } from './attention-store';
import { combineLedgers, foldCosts, ledgerLine } from './cost-ledger';
import type { CostLedger } from './cost-ledger';
import { NewProjectSheet } from './new-project-sheet';

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/** When this changes, some session finished or appeared and its spend moved. */
const ledgerSigOf = (metas: readonly AgentSessionMeta[]): string =>
  metas.map((m) => `${m.id}:${m.status}`).join('|');

interface Availability {
  readonly available: boolean;
}

// --- session list ------------------------------------------------------------

export function SessionList({ onOpen }: { onOpen: (id: string) => void }) {
  const theme = useTheme();
  // Sessions come from the shared attention store, which polls while the app
  // is open — the status words and dots here are live, not a snapshot from
  // whenever the tab mounted. Fetching once and letting the badges go stale
  // was this screen's worst lie: it showed "running" over a session that had
  // been waiting on an approval for ten minutes.
  const { sessions, fetchedAt, error: pollError } = useAgentAttention();
  const [discovered, setDiscovered] = useState<readonly DiscoveredSession[]>([]);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
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
      const [status, found] = await Promise.all([
        api.agentStatus(),
        // Discovery is a nicety: a host that cannot scan ~/.claude must not
        // take the session list down with it.
        api.agentDiscovered().catch(() => ({ sessions: [] as DiscoveredSession[] })),
        // The session list itself refreshes through the shared store, so this
        // pull also snaps the badge and banner current.
        refreshAttention(),
      ]);
      if (!live.current) return;
      setAvailability(status);
      setDiscovered(found.sessions);
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

  // Resume a session Claude Code already has on disk: attach it to Belay
  // (with the approval flow) and open it.
  const attach = useCallback(async (d: DiscoveredSession) => {
    if (attaching) return;
    setAttaching(d.claudeSessionId);
    try {
      const snap = await api.agentAttach(d.claudeSessionId, d.cwd, d.preview || undefined);
      if (live.current) onOpen(snap.id);
    } catch (e: unknown) {
      if (live.current) setError(messageOf(e, 'could not resume that session'));
    } finally {
      if (live.current) setAttaching(null);
    }
  }, [attaching, onOpen]);

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
  const groups = groupDiscovered(discovered);
  const margin = theme.layout.margin;
  const running = sessions?.filter((s) => s.status === 'running').length ?? 0;
  const waiting = sessions?.filter((s) => s.status === 'waiting').length ?? 0;
  // The running total across every session — the strip's SPEND stat.
  const totalLine = ledgerLine(combineLedgers((sessions ?? []).map((s) => ledgers[s.id]).filter((l): l is CostLedger => l !== undefined)));

  return (
    <ScrollView
      testID="agent-list"
      contentContainerStyle={{ paddingHorizontal: margin, paddingTop: theme.space.md, paddingBottom: theme.space.lg }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} tintColor={theme.colors.accent} />}
    >
      <Txt variant="title" heading>Agent</Txt>
      <Row justify="space-between" gap="sm" style={{ marginTop: theme.space.xxs }}>
        <Row gap="xs" style={{ flexShrink: 1 }}>
          <Dot status={error || pollError ? 'bad' : 'good'} size={7} />
          {/* The freshness stamp is the visible twin of pull-to-refresh (audit
              3.3): it proves the rows below are live — the attention store polls
              while this screen is up — and dates them honestly when they stop
              being so. */}
          <Label style={{ marginBottom: 0 }} numberOfLines={1}>
            {(error || pollError ? 'Host not answering' : 'Host connected') + (fetchedAt ? ` · ${formatAsOf(fetchedAt)}` : '')}
          </Label>
        </Row>
        {/* Every other tab's status line ends with the way out to My
            Computers; the tab that drives Claude must say which machine
            it is driving, and let you change it. */}
        <SwitchComputerLink />
      </Row>
      <Rule bleed={margin} style={{ marginTop: theme.space.md, marginBottom: theme.space.lg }} />

      {error ? (
        <Banner testID="agent-error" status="bad" title="Could not read the host" message={error} action={{ label: 'Try again', onPress: () => void refresh() }} style={{ marginBottom: theme.space.md }} />
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

      {sessions !== null && sessions.length > 0 ? (
        // The stat strip: the fleet at a glance, in the reference's stat-card
        // idiom. A blue ring only while something is actually running; a small
        // amber disc only while something waits on you.
        <Row gap="sm" align="stretch" style={{ marginBottom: theme.space.lg }}>
          <Card padding="sm" title="Running" testID="agent-stat-running" style={{ flex: 1 }}>
            <Row gap="xs">
              {running > 0 ? <Dot status="accent" ring size={7} /> : null}
              <Txt variant="subheading">{String(running)}</Txt>
            </Row>
          </Card>
          <Card padding="sm" title="Waiting" testID="agent-stat-waiting" style={{ flex: 1 }}>
            <Row gap="xs">
              {waiting > 0 ? <Dot status="warn" size={7} /> : null}
              <Txt variant="subheading">{String(waiting)}</Txt>
            </Row>
          </Card>
          <Card padding="sm" title="Spend" testID="agent-spend-total" style={{ flex: 1.6 }}>
            {/* The summed ledger, in the mono ledger voice. */}
            <Txt variant="monoSmall" tone={totalLine ? 'dim' : 'faint'} numberOfLines={1} style={{ paddingVertical: 2 }}>
              {totalLine || '—'}
            </Txt>
          </Card>
        </Row>
      ) : null}

      <Section
        label="Sessions"
        rule={false}
        trailing={
          <TrackLabel
            testID="agent-new"
            label="+ New session"
            onPress={() => setPicking(true)}
            disabled={unavailable}
            inks={{ restLabel: theme.colors.accent }}
          />
        }
      >
        {sessions === null && !error ? (
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
        ) : null}

        {sessions?.length === 0 && !unavailable ? (
          <Card>
            <EmptyState
              testID="agent-empty"
              title="No sessions yet"
              message="Start one in a project folder and tell Claude what to build — you approve every action from here."
              action={{ label: 'New session', onPress: () => setPicking(true) }}
            />
          </Card>
        ) : null}

        {sessions !== null && sessions.length > 0 ? (
          <Card flush testID="agent-sessions">
            {sessions.map((s, i) => (
              <View key={s.id}>
                {i > 0 ? <Divider /> : null}
                <SessionRow session={s} ledger={ledgers[s.id]} now={now} onOpen={onOpen} onRemove={remove} />
              </View>
            ))}
          </Card>
        ) : null}
      </Section>

      {groups.length > 0 ? (
        <Section label="On this PC" rule={false} style={{ marginTop: theme.space.xl }}>
          <Caption style={{ marginBottom: theme.space.sm }}>
            Past Claude Code sessions on the computer — tap to resume with full context.
          </Caption>
          <Card flush>
            {groups.map((g, gi) => (
              <View key={g.cwd}>
                {gi > 0 ? <Divider /> : null}
                <Row gap="xs" style={{ paddingHorizontal: theme.space.md, paddingTop: theme.space.sm, paddingBottom: theme.space.xxs }}>
                  <Label style={{ marginBottom: 0 }}>{g.name}</Label>
                  <Txt variant="monoSmall" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{g.cwd}</Txt>
                </Row>
                {g.sessions.map((d) => (
                  <Pressable
                    key={d.claudeSessionId}
                    testID={`agent-resume-${d.claudeSessionId}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Resume ${d.preview || 'untitled session'}`}
                    disabled={attaching !== null}
                    onPress={() => void attach(d)}
                    style={({ pressed }) => ({
                      minHeight: theme.layout.minTouch,
                      justifyContent: 'center',
                      paddingHorizontal: theme.space.md,
                      paddingVertical: theme.space.xs,
                      opacity: pressed || attaching === d.claudeSessionId ? theme.motion.pressOpacity : 1,
                    })}
                  >
                    <Row justify="space-between" gap="sm">
                      <Txt variant="body" numberOfLines={1} style={{ flex: 1 }}>
                        {d.preview || 'untitled session'}
                      </Txt>
                      <Micro>{ago(d.mtime, now)}</Micro>
                    </Row>
                  </Pressable>
                ))}
                <View style={{ height: theme.space.xs }} />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}
    </ScrollView>
  );
}

/**
 * The row's status mark (REVAMP-SPEC §3.5): a hollow blue ring only while the
 * turn is running (blue = active, and only then), a small amber disc while it
 * waits on you, muted otherwise. Steady shapes — no pulse.
 */
const rowDot = (s: AgentStatus): { status: 'accent' | 'warn' | 'bad' | 'neutral'; ring: boolean } =>
  s === 'running'
    ? { status: 'accent', ring: true }
    : { status: s === 'waiting' ? 'warn' : s === 'error' ? 'bad' : 'neutral', ring: false };

/**
 * One session, one table row: dot + title with the trailing status word, then
 * the mono footnote (cwd left, spend right), then — only when it is asking —
 * the amber "needs you" line with the auto-deny countdown. The remove control
 * rides trailing; × is one of the universal five.
 */
function SessionRow({
  session: s,
  ledger,
  now,
  onOpen,
  onRemove,
}: {
  session: AgentSessionMeta;
  ledger: CostLedger | undefined;
  now: number;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const theme = useTheme();
  const dot = rowDot(s.status);
  const spend = ledger ? ledgerLine(ledger) : '';
  const idle = s.status === 'idle';
  return (
    <Row testID={`agent-session-${s.id}`} gap="xs" align="flex-start" style={{ paddingLeft: theme.space.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${s.title}, ${statusLabel(s.status)}`}
        onPress={() => {
          haptic('light');
          onOpen(s.id);
        }}
        style={({ pressed }) => ({
          flex: 1,
          gap: theme.space.xxs,
          paddingVertical: theme.space.sm,
          minHeight: theme.layout.rowHeight,
          justifyContent: 'center',
          opacity: pressed ? theme.motion.pressOpacity : 1,
        })}
      >
        <Row gap="xs">
          <Dot status={dot.status} ring={dot.ring} size={7} />
          <Txt variant="subheading" numberOfLines={1} style={{ flex: 1 }}>{s.title}</Txt>
          {/* One trailing fact: what it is doing, or — when idle — when it last did. */}
          <Micro tone={idle ? 'faint' : s.status === 'waiting' ? 'warn' : s.status === 'error' ? 'bad' : 'accent'}>
            {idle ? ago(s.lastUsed, now) : statusLabel(s.status)}
          </Micro>
        </Row>
        <Row justify="space-between" gap="sm">
          <Txt variant="monoSmall" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{s.cwd}</Txt>
          {/* What this session has cost — value-right, like every ledger figure. */}
          {spend ? <Txt variant="monoSmall" tone="faint" numberOfLines={1}>{spend}</Txt> : null}
        </Row>
        {s.pending ? (
          // What it wants and how long before the host gives up — so a list
          // of several sessions leaves no doubt about which one is asking.
          <Row justify="space-between" gap="sm">
            <Txt variant="monoSmall" tone="warn" numberOfLines={1} style={{ flexShrink: 1 }}>
              {askSummary(s.pending.tool, s.pending.detail)}
            </Txt>
            {s.pending.expiresAt ? (
              <Micro tone="dim">{`auto-denies in ${countdown(s.pending.expiresAt, now)}`}</Micro>
            ) : null}
          </Row>
        ) : null}
      </Pressable>
      <IconButton
        testID={`agent-del-${s.id}`}
        accessibilityLabel={`Remove ${s.title}`}
        accessibilityHint="Forgets this session in Belay; the transcript stays on the PC"
        variant="plain"
        hapticTone={null}
        onPress={() => onRemove(s.id)}
      >
        <Txt variant="subheading" tone="faint">×</Txt>
      </IconButton>
    </Row>
  );
}

// --- project picker ----------------------------------------------------------

export function ProjectPicker({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const theme = useTheme();
  const [projects, setProjects] = useState<readonly AgentProject[] | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    api.agentProjects()
      .then((r) => { if (live.current) setProjects(r.projects); })
      .catch((e: unknown) => { if (live.current) { setProjects([]); setError(messageOf(e, 'could not list projects')); } });
    return () => {
      live.current = false;
    };
  }, []);

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

      {error ? <Banner testID="agent-picker-error" status="bad" message={error} style={{ marginBottom: theme.space.md }} /> : null}

      <Input
        testID="agent-cwd"
        label="Folder on the PC"
        value={manual}
        onChangeText={setManual}
        placeholder={'C:\\Users\\you\\project or ~/project'}
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
        {projects === null ? (
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

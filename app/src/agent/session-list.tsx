// The Agent tab's home: Tether's own sessions, the "On this PC" list of Claude
// Code sessions found on disk to resume, and the project picker for a new one.
//
// Ledger anatomy (docs/DESIGN.md §7.3): the sessions are three-line rows with
// a status-dot column so the list scans as a table, hairline-separated, with
// the section's actions as label buttons on the marker line. Loading renders
// the same rows as skeleton bars at the text positions, so nothing reflows
// when data lands.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { api } from '../api';
import type { AgentProject, AgentSessionMeta, DiscoveredSession } from '../api';
import { useTheme } from '../theme';
import {
  Badge, Banner, Button, Caption, Dot, EmptyState, IconButton, Input, Label, Micro, Row, Rule, Section, Skeleton, TrackLabel, Txt, haptic,
} from '../ui';
import { SwitchComputerLink } from '../devices/switch-link';
import { formatAsOf } from '../files-format';
import { ago, groupDiscovered, statusLabel, statusTone } from './model';
import { askSummary, countdown } from './attention';
import { refreshAttention, useAgentAttention } from './attention-store';
import { NewProjectSheet } from './new-project-sheet';

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

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
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

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
    if (live.current) setRefreshing(false);
  }, [refresh]);

  // Resume a session Claude Code already has on disk: attach it to Tether
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
          message="The claude CLI was not found on the computer's PATH. Install Claude Code there, then restart the Tether host."
          style={{ marginBottom: theme.space.md }}
        />
      ) : null}

      <Section
        label="Sessions"
        bleed={margin}
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
        <Rule bleed={margin} />

        {sessions === null && !error ? (
          <View>
            {Array.from({ length: 3 }, (_, i) => (
              <View key={i} style={{ paddingVertical: theme.space.sm, gap: theme.space.xs }}>
                <Skeleton width={`${34 + i * 8}%`} height={11} />
                <Skeleton width={`${58 + i * 10}%`} height={15} />
                <Skeleton width="30%" height={10} />
              </View>
            ))}
          </View>
        ) : null}

        {sessions?.length === 0 && !unavailable ? (
          <EmptyState
            testID="agent-empty"
            title="No sessions yet"
            message="Start one in a project folder and tell Claude what to build — you approve every action from here."
            action={{ label: 'New session', onPress: () => setPicking(true) }}
          />
        ) : null}

        {sessions?.map((s) => (
          <SessionRow key={s.id} session={s} now={now} onOpen={onOpen} onRemove={remove} />
        ))}
      </Section>

      {groups.length > 0 ? (
        <Section label="On this PC" bleed={margin} rule={false} style={{ marginTop: theme.space.xl }}>
          <Caption style={{ marginBottom: theme.space.xs }}>
            Past Claude Code sessions found on the computer — tap to resume with full context. If one is still open in a terminal there, close it first.
          </Caption>
          <Rule bleed={margin} />
          {groups.map((g) => (
            <View key={g.cwd}>
              <Row gap="xs" style={{ minHeight: theme.space.xl, marginTop: theme.space.xs }}>
                <Label style={{ marginBottom: 0 }}>{g.name}</Label>
                <Txt variant="monoSmall" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{g.cwd}</Txt>
              </Row>
              {g.sessions.map((d) => (
                <View key={d.claudeSessionId}>
                  <Pressable
                    testID={`agent-resume-${d.claudeSessionId}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Resume ${d.preview || 'untitled session'}`}
                    disabled={attaching !== null}
                    onPress={() => void attach(d)}
                    style={({ pressed }) => ({
                      minHeight: theme.layout.minTouch,
                      justifyContent: 'center',
                      gap: 2,
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
                  <Rule bleed={margin} />
                </View>
              ))}
            </View>
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

/**
 * One session, three lines: status word and project on the marker line, the
 * task in prose, then the mono footnote. The remove control rides trailing —
 * × is one of the universal five and this is its conventional position.
 */
function SessionRow({
  session: s,
  now,
  onOpen,
  onRemove,
}: {
  session: AgentSessionMeta;
  now: number;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const theme = useTheme();
  const tone = statusTone(s.status);
  return (
    <View testID={`agent-session-${s.id}`}>
      <Row gap="sm" align="flex-start">
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
            opacity: pressed ? theme.motion.pressOpacity : 1,
          })}
        >
          <Row justify="space-between" gap="sm">
            <Row gap="xs">
              <Dot status={s.status === 'idle' ? 'neutral' : tone} pulse={s.status === 'running'} size={7} />
              <Txt variant="label" tone={s.status === 'idle' ? 'dim' : tone}>{statusLabel(s.status)}</Txt>
            </Row>
            <Micro tone="dim">{ago(s.lastUsed, now)}</Micro>
          </Row>
          <Txt variant="subheading" numberOfLines={1}>{s.title}</Txt>
          <Txt variant="monoSmall" tone="faint" numberOfLines={1}>{s.cwd}</Txt>
          {s.pending ? (
            // What it wants and how long before the host gives up — so a list
            // of several sessions leaves no doubt about which one is asking.
            <Row justify="space-between" gap="sm">
              <Txt variant="monoSmall" tone="accent" numberOfLines={1} style={{ flexShrink: 1 }}>
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
          accessibilityHint="Forgets this session in Tether; the transcript stays on the PC"
          variant="plain"
          hapticTone={null}
          onPress={() => onRemove(s.id)}
        >
          <Txt variant="subheading" tone="faint">×</Txt>
        </IconButton>
      </Row>
      <Rule bleed={theme.layout.margin} />
    </View>
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
          <View>
            {Array.from({ length: 4 }, (_, i) => (
              <View key={i} style={{ paddingVertical: theme.space.sm, gap: theme.space.xs }}>
                <Skeleton width={`${40 + i * 10}%`} height={15} />
                <Skeleton width="75%" height={11} />
              </View>
            ))}
          </View>
        ) : projects.length > 0 ? (
          <Section
            label="Projects found"
            bleed={margin}
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
            <Rule bleed={margin} />
            {projects.map((p) => (
              <View key={p.path}>
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
                <Rule bleed={margin} />
              </View>
            ))}
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

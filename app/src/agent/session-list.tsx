// The Agent tab's home: Tether's own sessions, the "On this PC" list of Claude
// Code sessions found on disk to resume, and the project picker for a new one.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { api } from '../api';
import type { AgentProject, AgentSessionMeta, DiscoveredSession } from '../api';
import { useTheme } from '../theme';
import {
  Badge, Banner, Button, Caption, Card, Column, Dot, EmptyState, IconButton, Input, Label, Row, Skeleton, Txt, haptic,
} from '../ui';
import { ago, groupDiscovered, projectName, statusLabel, statusTone } from './model';
import { NewProjectSheet } from './new-project-sheet';

const messageOf = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

interface Availability {
  readonly available: boolean;
  readonly transcribe: boolean;
}

// --- session list ------------------------------------------------------------

export function SessionList({ onOpen }: { onOpen: (id: string) => void }) {
  const theme = useTheme();
  const [sessions, setSessions] = useState<readonly AgentSessionMeta[] | null>(null);
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
      const [status, list, found] = await Promise.all([
        api.agentStatus(),
        api.agentSessions(),
        // Discovery is a nicety: a host that cannot scan ~/.claude must not
        // take the session list down with it.
        api.agentDiscovered().catch(() => ({ sessions: [] as DiscoveredSession[] })),
      ]);
      if (!live.current) return;
      setAvailability(status);
      setSessions(list.sessions);
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

  return (
    <ScrollView
      testID="agent-list"
      contentContainerStyle={{ padding: theme.space.md, paddingTop: 0, gap: theme.space.sm }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} tintColor={theme.colors.accent} />}
    >
      <Row justify="space-between" gap="sm">
        <Txt variant="subheading" heading>Agent</Txt>
        <Row gap="xs">
          <IconButton testID="agent-refresh" accessibilityLabel="Refresh sessions" onPress={() => void refresh()} size={38}>
            <Text allowFontScaling={false} style={{ color: theme.colors.text, fontSize: 16, fontWeight: '800' }}>⟳</Text>
          </IconButton>
          <Button testID="agent-new" label="+ New session" size="sm" onPress={() => setPicking(true)} disabled={unavailable} />
        </Row>
      </Row>

      {error ? (
        <Banner testID="agent-error" status="bad" title="Could not read the host" message={error} action={{ label: 'Try again', onPress: () => void refresh() }} />
      ) : null}

      {unavailable ? (
        <Banner
          testID="agent-unavailable"
          status="warn"
          title="Claude Code is not on this PC"
          message="The claude CLI was not found on the computer's PATH. Install Claude Code there, then restart the Tether host."
        />
      ) : null}

      {sessions === null && !error ? (
        <Column gap="sm">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i}>
              <Skeleton width={`${50 + i * 12}%`} height={15} />
              <Skeleton width="70%" height={11} style={{ marginTop: 8 }} />
            </Card>
          ))}
        </Column>
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
        <SessionCard key={s.id} session={s} now={now} onOpen={onOpen} onRemove={remove} />
      ))}

      {groups.length > 0 ? (
        <Column gap="xs" style={{ marginTop: theme.space.sm }}>
          <Label>On this PC</Label>
          <Caption>
            Past Claude Code sessions found on the computer — tap to resume with full context. If one is still open in a terminal there, close it first.
          </Caption>
          {groups.map((g) => (
            <View key={g.cwd} style={{ gap: theme.space.xs, marginTop: theme.space.xs }}>
              <Txt variant="caption" tone="dim" numberOfLines={1} style={{ fontWeight: '700' }}>
                {g.name}
                <Txt variant="caption" tone="faint">{`  ${g.cwd}`}</Txt>
              </Txt>
              {g.sessions.map((d) => (
                <Pressable
                  key={d.claudeSessionId}
                  testID={`agent-resume-${d.claudeSessionId}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Resume ${d.preview || 'untitled session'}`}
                  disabled={attaching !== null}
                  onPress={() => void attach(d)}
                  style={({ pressed }) => ({ opacity: pressed || attaching === d.claudeSessionId ? 0.6 : 1 })}
                >
                  <Card padding="sm" raised>
                    <Row justify="space-between" gap="sm">
                      <Txt variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                        {d.preview || 'untitled session'}
                      </Txt>
                      <Caption>{ago(d.mtime, now)}</Caption>
                    </Row>
                  </Card>
                </Pressable>
              ))}
            </View>
          ))}
        </Column>
      ) : null}
    </ScrollView>
  );
}

function SessionCard({
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
  return (
    <Card padding="sm" testID={`agent-session-${s.id}`}>
      <Row gap="sm" align="flex-start">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${s.title}, ${statusLabel(s.status)}`}
          onPress={() => {
            haptic('light');
            onOpen(s.id);
          }}
          style={({ pressed }) => ({ flex: 1, gap: 4, opacity: pressed ? 0.7 : 1 })}
        >
          <Row gap="xs">
            <Dot status={statusTone(s.status)} pulse={s.status === 'running'} />
            <Txt variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>{s.title}</Txt>
          </Row>
          <Txt variant="monoSmall" tone="dim" numberOfLines={1}>{s.cwd}</Txt>
          <Row gap="xs">
            <Badge label={statusLabel(s.status)} status={s.status === 'idle' ? 'neutral' : statusTone(s.status)} />
            <Caption>{ago(s.lastUsed, now)}</Caption>
          </Row>
        </Pressable>
        <IconButton
          testID={`agent-del-${s.id}`}
          accessibilityLabel={`Remove ${s.title}`}
          accessibilityHint="Forgets this session in Tether; the transcript stays on the PC"
          variant="plain"
          size={36}
          hapticTone={null}
          onPress={() => onRemove(s.id)}
        >
          <Text allowFontScaling={false} style={{ color: theme.colors.textFaint, fontSize: 18, fontWeight: '800' }}>×</Text>
        </IconButton>
      </Row>
    </Card>
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

  return (
    <ScrollView
      testID="agent-picker"
      contentContainerStyle={{ padding: theme.space.md, paddingTop: 0, gap: theme.space.sm }}
      keyboardShouldPersistTaps="handled"
    >
      <Row justify="space-between" gap="sm">
        <Txt variant="subheading" heading>Pick a project</Txt>
        <Row gap="xs">
          <Button testID="agent-create-project" label="+ New project" size="sm" onPress={() => setCreating(true)} />
          <Button testID="agent-cancel" label="Cancel" size="sm" variant="ghost" onPress={onCancel} />
        </Row>
      </Row>

      <NewProjectSheet
        visible={creating}
        projects={projects ?? []}
        onClose={() => setCreating(false)}
        onCreated={created}
      />

      {error ? <Banner testID="agent-picker-error" status="bad" message={error} /> : null}

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

      {projects === null ? (
        <Column gap="sm">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i} padding="sm">
              <Skeleton width={`${40 + i * 10}%`} height={15} />
              <Skeleton width="75%" height={11} style={{ marginTop: 8 }} />
            </Card>
          ))}
        </Column>
      ) : projects.length > 0 ? (
        <Column gap="xs">
          <Label>Projects found</Label>
          {projects.map((p) => (
            <Pressable
              key={p.path}
              testID={`agent-proj-${p.name}`}
              accessibilityRole="button"
              accessibilityLabel={`Start a session in ${p.name}`}
              disabled={busy !== null}
              onPress={() => {
                haptic('light');
                void create(p.path);
              }}
              style={({ pressed }) => ({ opacity: pressed || busy === p.path ? 0.6 : 1 })}
            >
              <Card padding="sm">
                <Row justify="space-between" gap="sm">
                  <Txt variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>{p.name}</Txt>
                  {p.recent ? <Badge label="recent" status="accent" /> : null}
                </Row>
                <Txt variant="monoSmall" tone="dim" numberOfLines={1}>{p.path}</Txt>
              </Card>
            </Pressable>
          ))}
        </Column>
      ) : (
        <Caption>No git repositories were found under the PC's home or Documents folder. Type a path above, or tap "+ New project" to start fresh.</Caption>
      )}
    </ScrollView>
  );
}

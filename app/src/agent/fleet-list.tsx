// The control room (#124, #129): the always-on fleet strip, then ONE list of
// every agent the host knows — Belay's own sessions, terminal sessions that
// asked through the hook, sessions found on disk — needs-you first. A phone
// shows it as one column; from DESK_MIN_WIDTH up it splits into two, the
// asks on the left at phone width with compact Deny/Allow, everything else on
// the right, so a tablet by the keyboard shows the whole fleet without a
// scroll. The rows are fleet.ts's; this file only draws them.

import React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import type { AgentSessionMeta, AgentStatus, DiscoveredSession, HookNotice } from '../api';
import { useTheme } from '../theme';
import { Banner, Card, Divider, Dot, IconButton, Label, Micro, Row, Section, Txt, haptic } from '../ui';
import { copyText } from '../files/clipboard';
import { ago, projectName, statusLabel } from './model';
import { isLive, kindLabel, ptyStateLabel, sessionKind } from './session-kind';
import { askSummary, countdown } from './attention';
import { decideHook, dismissHookNotice } from './attention-store';
import { discoveredFromHook, noticeLine } from './hook-model';
import { HookAskCard } from './hook-ask-card';
import { ledgerLine } from './cost-ledger';
import type { CostLedger } from './cost-ledger';
import type { FleetCounts, FleetRow } from './fleet';

/** From here up the tab is a desk dashboard: two columns (#129). */
export const DESK_MIN_WIDTH = 768;

/** The real install step — docs/AGENT.md, server/package.json `hooks:install`. */
export const HOOKS_INSTALL_COMMAND = 'cd server && npm run hooks:install';

// --- strip -------------------------------------------------------------------

/** `2 running · 1 waiting · 3 done today · $0.31` — on every connection. */
export function FleetStrip({ counts, spend }: { counts: FleetCounts; spend: string }) {
  const theme = useTheme();
  const stat = (title: string, value: number, dot: React.ReactNode, testID: string) => (
    <Card padding="sm" title={title} testID={testID} style={{ flex: 1 }}>
      <Row gap="xs">
        {value > 0 ? dot : null}
        <Txt variant="subheading">{String(value)}</Txt>
      </Row>
    </Card>
  );
  return (
    <Row gap="sm" align="stretch" testID="agent-fleet-strip" style={{ marginBottom: theme.space.lg }}>
      {stat('Running', counts.running, <Dot status="accent" ring size={7} />, 'agent-stat-running')}
      {stat('Waiting', counts.waiting, <Dot status="warn" size={7} />, 'agent-stat-waiting')}
      {stat('Done today', counts.doneToday, null, 'agent-stat-done')}
      {spend ? (
        <Card padding="sm" title="Spend" testID="agent-spend-total" style={{ flex: 1.4 }}>
          <Txt variant="monoSmall" tone="dim" numberOfLines={1} style={{ paddingVertical: 2 }}>{spend}</Txt>
        </Card>
      ) : null}
    </Row>
  );
}

/** #128: terminal sessions cannot ask the phone until the hooks are in. */
export function HooksBanner() {
  const theme = useTheme();
  return (
    <Banner
      testID="agent-hooks-missing"
      status="warn"
      title="Terminal sessions can't ask you here yet"
      message={`Install the Claude Code hooks on the computer, once: ${HOOKS_INSTALL_COMMAND}`}
      action={{ label: 'Copy', onPress: () => { void copyText(HOOKS_INSTALL_COMMAND).then((ok) => haptic(ok ? 'success' : 'warning')); } }}
      style={{ marginBottom: theme.space.md }}
    />
  );
}

// --- board -------------------------------------------------------------------

export interface FleetBoardProps {
  readonly rows: readonly FleetRow[];
  readonly ledgers: Readonly<Record<string, CostLedger>>;
  readonly now: number;
  readonly onOpen: (id: string) => void;
  readonly onWatch: (session: DiscoveredSession) => void;
  readonly onRemove: (id: string) => void;
  /** "+ New session" — the list column's trailing action. */
  readonly newSession: React.ReactNode;
  /** Shown in place of the list when there are no rows. */
  readonly empty: React.ReactNode;
}

export function FleetBoard({ rows, ledgers, now, onOpen, onWatch, onRemove, newSession, empty }: FleetBoardProps) {
  const theme = useTheme();
  const router = useRouter();
  const desk = useWindowDimensions().width >= DESK_MIN_WIDTH;
  const needs = rows.filter((r) => r.state === 'waiting');
  const rest = rows.filter((r) => r.state !== 'waiting');

  // A finished turn with a change count opens what changed; the Changes
  // route is per Belay session, so a plain terminal session opens its
  // transcript until the host can diff by folder.
  const openNotice = (n: HookNotice) => {
    haptic('light');
    if (n.belaySessionId) {
      router.push({ pathname: '/changes', params: { session: n.belaySessionId, title: projectName(n.cwd), cwd: n.cwd } });
    } else onWatch(discoveredFromHook(n));
  };

  const plainRow = (r: FleetRow) =>
    r.session ? (
      <SessionRow session={r.session} ledger={ledgers[r.key]} now={now} onOpen={onOpen} onRemove={onRemove} />
    ) : (
      <AgentRow row={r} now={now} onWatch={onWatch} onNotice={openNotice} />
    );

  const needsColumn = needs.length > 0 ? (
    <Section label="Needs you" rule={false} testID="agent-hook-asks" style={{ marginBottom: theme.space.lg }}>
      <View style={{ gap: theme.space.md }}>
        {needs.map((r) =>
          r.ask ? (
            <HookAskCard
              key={r.key}
              item={r.ask}
              now={now}
              stackedCount={r.moreAsks}
              compact={desk}
              onAnswer={(allow, choice) => { if (r.ask) void decideHook(r.ask.id, allow, choice); }}
              onOpen={() => (r.session ? onOpen(r.session.id) : r.ask && onWatch(discoveredFromHook(r.ask)))}
            />
          ) : (
            <Card key={r.key} flush>{plainRow(r)}</Card>
          ),
        )}
      </View>
    </Section>
  ) : null;

  const listColumn = (
    <Section label="Agents" rule={false} trailing={newSession}>
      {rest.length === 0 && needs.length === 0 ? empty : rest.length > 0 ? (
        <Card flush testID="agent-sessions">
          {rest.map((r, i) => (
            <View key={r.key}>
              {i > 0 ? <Divider /> : null}
              {plainRow(r)}
            </View>
          ))}
        </Card>
      ) : null}
    </Section>
  );

  if (!desk) return <View>{needsColumn}{listColumn}</View>;
  return (
    <Row gap="lg" align="flex-start" testID="agent-desk">
      <View style={{ flex: 1 }}>
        {needsColumn ?? (
          <Section label="Needs you" rule={false}>
            <Card><Txt variant="body" tone="faint">Nothing is waiting on you.</Txt></Card>
          </Section>
        )}
      </View>
      <View style={{ flex: 1 }}>{listColumn}</View>
    </Row>
  );
}

/**
 * A terminal-started session (disk) or a finished turn nothing else lists:
 * project name first (#120), the path faint and truncated from the left,
 * then what it is doing — LIVE, done with what changed, or when it last wrote.
 */
function AgentRow({ row: r, now, onWatch, onNotice }: {
  row: FleetRow;
  now: number;
  onWatch: (session: DiscoveredSession) => void;
  onNotice: (n: HookNotice) => void;
}) {
  const theme = useTheme();
  const n = r.notice;
  const line = n ? noticeLine(n) : null;
  const d = r.discovered;
  const open = () => {
    if (n) onNotice(n);
    else if (d) { haptic('light'); onWatch(d); }
  };
  return (
    <Row testID={`agent-row-${r.key}`} gap="xs" style={{ paddingLeft: theme.space.md }}>
      <Pressable
        testID={n ? `agent-notice-${n.id}` : `agent-resume-${r.key}`}
        accessibilityRole="button"
        accessibilityLabel={`${r.title}, ${line?.label ?? (d?.live ? 'live' : 'idle')} — open`}
        onPress={open}
        style={({ pressed }) => ({
          flex: 1, gap: theme.space.xxs, paddingVertical: theme.space.sm, minHeight: theme.layout.rowHeight,
          justifyContent: 'center', paddingRight: n ? 0 : theme.space.md, opacity: pressed ? theme.motion.pressOpacity : 1,
        })}
      >
        <Row gap="xs">
          <Dot status={r.state === 'running' ? 'accent' : r.state === 'done' ? 'good' : 'neutral'} ring={r.state === 'running'} size={7} />
          <Txt variant="subheading" numberOfLines={1} style={{ flexShrink: 0, maxWidth: '55%' }}>{r.title}</Txt>
          <Micro tone="faint">terminal</Micro>
          <View style={{ flex: 1 }} />
          {line ? (
            <Micro testID={`agent-done-${r.key}`} tone="good">{line.label}</Micro>
          ) : d?.live ? (
            <Micro testID={`agent-live-${r.key}`} tone="accent">● LIVE</Micro>
          ) : (
            <Micro tone="faint">{ago(r.at, now)}</Micro>
          )}
        </Row>
        <Txt variant="monoSmall" tone="faint" numberOfLines={1} ellipsizeMode="head">{r.cwd}</Txt>
        {line?.text || d?.preview ? (
          <Txt variant="body" tone="dim" numberOfLines={1}>{line?.text || d?.preview}</Txt>
        ) : null}
      </Pressable>
      {n ? (
        <IconButton
          testID={`agent-notice-dismiss-${n.id}`}
          accessibilityLabel={`Dismiss ${r.title} ${line?.label ?? ''}`}
          variant="plain"
          hapticTone={null}
          onPress={() => { void dismissHookNotice(n.id); }}
        >
          <Txt variant="subheading" tone="faint">×</Txt>
        </IconButton>
      ) : null}
    </Row>
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
 * The same mark for a pty session, which has a second kind of "running": its
 * process. A live terminal nobody is mid-turn on was drawn exactly like a
 * killed one, so the list could not tell work in progress from a corpse.
 */
const ptyRowDot = (s: AgentSessionMeta): { status: 'accent' | 'warn' | 'bad' | 'neutral'; ring: boolean } =>
  s.status === 'waiting' || s.status === 'error' || !isLive(s)
    ? rowDot(s.status)
    : { status: 'accent', ring: true };

/**
 * One Belay session, one table row: dot + title with the trailing status word,
 * then the mono footnote (cwd left, spend right), then — only when it is
 * asking — the amber "needs you" line with the auto-deny countdown. The remove
 * control rides trailing; × is one of the universal five.
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
  const kind = sessionKind(s);
  const dot = kind === 'pty' ? ptyRowDot(s) : rowDot(s.status);
  const spend = ledger ? ledgerLine(ledger) : '';
  // A pty row's trailing fact is whether the terminal is alive, not when it
  // was last touched: "stopped" and "live · 2 attached" are the two things
  // worth knowing before tapping it.
  const ptyState = ptyStateLabel(s);
  const idle = s.status === 'idle' && !ptyState;
  return (
    <Row testID={`agent-session-${s.id}`} gap="xs" align="flex-start" style={{ paddingLeft: theme.space.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${s.title}, ${kindLabel(kind)} session, ${ptyState ?? statusLabel(s.status)}`}
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
          <Txt variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>{s.title}</Txt>
          {/* Which of the two a row is matters before it is tapped: one opens a
              terminal you can type into, the other a feed you approve from. */}
          <Micro testID={`agent-kind-${s.id}`} tone="faint">{kindLabel(kind)}</Micro>
          <View style={{ flex: 1 }} />
          {ptyState && s.status === 'idle' ? (
            <Micro tone="faint">{ago(s.lastUsed, now)}</Micro>
          ) : null}
          <Micro
            testID={`agent-state-${s.id}`}
            tone={ptyState
              ? (isLive(s) ? 'accent' : 'faint')
              : idle ? 'faint' : s.status === 'waiting' ? 'warn' : s.status === 'error' ? 'bad' : 'accent'}
          >
            {ptyState && s.status === 'idle' ? ptyState : idle ? ago(s.lastUsed, now) : statusLabel(s.status)}
          </Micro>
        </Row>
        <Row justify="space-between" gap="sm">
          <Txt variant="monoSmall" tone="faint" numberOfLines={1} ellipsizeMode="head" style={{ flexShrink: 1 }}>{s.cwd}</Txt>
          {spend ? <Txt variant="monoSmall" tone="faint" numberOfLines={1}>{spend}</Txt> : null}
        </Row>
        {s.pending ? (
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

/** Terminal-prompt notices: a prompt held at the keyboard, not a fleet row. */
export function PromptNotices({ notices, onWatch }: { notices: readonly HookNotice[]; onWatch: (s: DiscoveredSession) => void }) {
  const theme = useTheme();
  if (notices.length === 0) return null;
  return (
    <Section label="Waiting at the terminal" rule={false} style={{ marginTop: theme.space.xl }} testID="agent-hook-notices">
      <Card flush>
        {notices.map((n, i) => {
          const line = noticeLine(n);
          return (
            <View key={n.id}>
              {i > 0 ? <Divider /> : null}
              <Row gap="sm" style={{ paddingHorizontal: theme.space.md, paddingVertical: theme.space.xs }}>
                <Pressable
                  testID={`agent-notice-${n.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${projectName(n.cwd)} ${line.label} — open the transcript`}
                  onPress={() => { haptic('light'); onWatch(discoveredFromHook(n)); }}
                  style={({ pressed }) => ({ flex: 1, gap: 2, minHeight: theme.layout.minTouch, justifyContent: 'center', opacity: pressed ? theme.motion.pressOpacity : 1 })}
                >
                  <Row gap="xs">
                    <Label style={{ marginBottom: 0 }}>{projectName(n.cwd)}</Label>
                    <Micro tone="warn">{line.label}</Micro>
                  </Row>
                  {line.text ? <Txt variant="body" tone="dim" numberOfLines={2}>{line.text}</Txt> : null}
                </Pressable>
                <IconButton
                  testID={`agent-notice-dismiss-${n.id}`}
                  accessibilityLabel={`Dismiss ${projectName(n.cwd)} ${line.label}`}
                  variant="plain"
                  hapticTone={null}
                  onPress={() => { void dismissHookNotice(n.id); }}
                >
                  <Txt variant="subheading" tone="faint">×</Txt>
                </IconButton>
              </Row>
            </View>
          );
        })}
      </Card>
    </Section>
  );
}

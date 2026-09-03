// System. Live host stats — CPU, memory, disk, power, uptime — with a short
// rolling history, a selectable poll rate, and honest behaviour when the host
// stops answering. Also the place where this device forgets the computer.
//
// Reference form (Next Terminal sweep): the meters are bordered navy stat
// cards in a responsive 2-up grid — small uppercase label, quiet trailing
// glyph, big numeral, thin blue gauge — and every list is hairline-divided
// rows inside a flush card. Header stays title + one status line; a labelled
// Retry appears only when polling has actually failed.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { SwitchComputerLink } from '../../src/devices/switch-link';
import { api } from '../../src/api';
import type { SystemStats } from '../../src/api';
import { useTheme } from '../../src/theme';
import {
  Banner,
  Button,
  Caption,
  Card,
  Column,
  Divider,
  Dot,
  Label,
  Row,
  Rule,
  SegmentedControl,
  Sheet,
  Txt,
} from '../../src/ui';
import { StatCard } from '../../src/system/stat-card';
import { BatteryCard, HostCard, statusLine } from '../../src/system/sections';
import { CardRow } from '../../src/system/card-row';
import { ChipGlyph, DiskGlyph, MemGlyph } from '../../src/system/glyphs';
import { DevicesSection } from '../../src/system/paired-devices';
import { parseDevices } from '../../src/system/devices-model';
import type { PairedDevice } from '../../src/system/devices-model';
import { EMPTY_SERIES, pushSeries } from '../../src/system/history';
import type { Series } from '../../src/system/history';
import { fmtBytes } from '../../src/system/format';
import { ThemeToggle } from '../../src/settings/theme-toggle';

type Rate = 'fast' | 'normal' | 'slow' | 'paused';

const RATE_MS: Readonly<Record<Rate, number | null>> = {
  fast: 1000,
  normal: 2000,
  slow: 5000,
  paused: null,
};

const RATE_OPTIONS = [
  { value: 'fast' as const, label: '1s' },
  { value: 'normal' as const, label: '2s' },
  { value: 'slow' as const, label: '5s' },
  { value: 'paused' as const, label: 'Paused' },
];

/** Ceiling for the retry backoff once the host stops answering. */
const MAX_BACKOFF_MS = 15000;
const MAX_FAILURE_STEPS = 4;
/** How often the "updated Ns ago" line re-renders. */
const CLOCK_MS = 1000;

/** Two cards per row wherever the screen fits them, one below on narrow. */
const STAT_CARD_STYLE = { flexGrow: 1, flexBasis: '46%' } as const;

const message = (e: unknown): string =>
  e instanceof Error ? e.message : 'Could not read system stats from the host.';

export default function SystemTab() {
  const { connection, active, forget } = useConnection();
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const [stats, setStats] = useState<SystemStats | null>(null);
  const [series, setSeries] = useState<Series>(EMPTY_SERIES);
  const [devices, setDevices] = useState<readonly PairedDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rate, setRate] = useState<Rate>('normal');
  const [clock, setClock] = useState(() => Date.now());
  const [confirmForget, setConfirmForget] = useState(false);

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const next = await api.system();
      if (!live.current) return true;
      setStats(next);
      setSeries((prev) => pushSeries(prev, next.cpuPercent, next.memPercent));
      setLastOkAt(Date.now());
      setError(null);
      return true;
    } catch (e: unknown) {
      if (live.current) setError(message(e));
      return false;
    }
  }, []);

  const loadDevices = useCallback(async (): Promise<void> => {
    try {
      const payload: unknown = await api.devices();
      if (live.current) setDevices(parseDevices(payload));
    } catch {
      // Non-essential: the stats above are the point of this screen, and a
      // failure here is already reported by the stats poll.
      if (live.current) setDevices([]);
    }
  }, []);

  // Self-scheduling poll. Backs off while the host is unreachable so a machine
  // that has gone to sleep is not hammered once a second.
  useEffect(() => {
    if (!connection) return;
    const interval = RATE_MS[rate];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const tick = async (): Promise<void> => {
      const ok = await load();
      if (cancelled) return;
      failures = ok ? 0 : Math.min(failures + 1, MAX_FAILURE_STEPS);
      if (interval === null) return;
      const delay = ok ? interval : Math.min(interval * 2 ** failures, MAX_BACKOFF_MS);
      timer = setTimeout(() => void tick(), delay);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connection, rate, load]);

  useEffect(() => {
    if (connection) void loadDevices();
  }, [connection, loadDevices]);

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), loadDevices()]);
    if (live.current) setRefreshing(false);
  }, [load, loadDevices]);

  // Forgets only the computer this screen is showing — `disconnect()` in the
  // connection context wipes every saved computer, which is a "start over"
  // action this button must never be. Confirmed first, like Forget on the
  // devices screen, because undoing it means walking back to the machine for
  // a new code.
  const onConfirmForget = useCallback(async () => {
    if (!active) return;
    setConfirmForget(false);
    await forget(active.id);
    router.replace('/');
  }, [active, forget]);

  // The phone just revoked its own token on the host. The saved computer is
  // now a credential that can never work again, so keeping it would leave a
  // zombie that retries forever — forget it and leave, same as Forget below.
  const onSelfRevoked = useCallback(async () => {
    if (active) await forget(active.id);
    router.replace('/');
  }, [active, forget]);

  const stale = Boolean(error);
  const title = stats?.hostname || connection?.hostName || 'Host';
  const margin = theme.layout.margin;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{
        paddingHorizontal: margin,
        paddingTop: insets.top + theme.space.md,
        paddingBottom: insets.bottom + theme.space.xxl,
        gap: theme.space.md,
        width: '100%',
        maxWidth: theme.layout.contentMaxWidth,
        alignSelf: 'center',
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} tintColor={theme.colors.accent} onRefresh={onRefresh} />
      }
    >
      {/* Header anatomy shared by every tab: title, label status line, rule. */}
      <View>
        <Txt variant="title" heading numberOfLines={1}>
          {title}
        </Txt>
        <Row justify="space-between" gap="sm" style={{ marginTop: theme.space.xxs }}>
          <Row gap="xs" style={{ flexShrink: 1 }}>
            <Dot
              status={stale ? 'bad' : 'accent'}
              pulse={!stale}
              label={stale ? 'Host unreachable' : 'Live'}
            />
            <Txt variant="label" tone="dim" numberOfLines={1}>
              {statusLine(stale, lastOkAt, clock)}
            </Txt>
          </Row>
          <SwitchComputerLink />
        </Row>
        <Rule bleed={margin} style={{ marginTop: theme.space.md }} />
      </View>

      {error ? (
        <Banner
          testID="system-error"
          status="warn"
          title="Lost contact with the host"
          message={`${error} Belay keeps retrying, and the numbers below are the last ones it received.`}
          action={{ label: 'Retry', onPress: onRefresh }}
        />
      ) : null}

      {/* The stat grid — the reference dashboard's tile row, 2-up on a phone. */}
      <Row wrap gap="sm" align="stretch">
        <StatCard
          label="CPU"
          percent={stats ? stats.cpuPercent : null}
          detail={stats ? `${stats.cpuCount} cores` : undefined}
          history={series.cpu}
          glyph={<ChipGlyph />}
          style={STAT_CARD_STYLE}
          testID="stat-cpu"
        />
        <StatCard
          label="Memory"
          percent={stats ? stats.memPercent : null}
          detail={stats ? `${fmtBytes(stats.memUsed)} / ${fmtBytes(stats.memTotal)}` : undefined}
          history={series.mem}
          glyph={<MemGlyph />}
          style={STAT_CARD_STYLE}
          testID="stat-memory"
        />
        <StatCard
          label="Disk"
          percent={stats ? stats.diskPercent : null}
          // A host that cannot query its own drive reports zeros. Rendering
          // that as "0% used, 0 B free" would read as a real, alarming
          // measurement.
          unavailable={Boolean(stats && stats.diskTotal <= 0)}
          detail={
            stats
              ? stats.diskTotal > 0
                ? `${fmtBytes(stats.diskFree)} free`
                : 'Not reported by this host'
              : undefined
          }
          glyph={<DiskGlyph />}
          style={STAT_CARD_STYLE}
          testID="stat-disk"
        />
        {stats?.battery ? <BatteryCard battery={stats.battery} style={STAT_CARD_STYLE} /> : null}
      </Row>

      <HostCard stats={stats} />

      <DevicesSection
        devices={devices}
        now={clock}
        ownToken={connection?.token}
        onChanged={() => void loadDevices()}
        onSelfRevoked={() => void onSelfRevoked()}
      />

      <Card title="Preferences">
        <Column gap="sm">
          <View style={{ gap: theme.space.xs }}>
            <Label>Update rate</Label>
            <SegmentedControl
              options={RATE_OPTIONS}
              value={rate}
              onChange={setRate}
              accessibilityLabel="Update rate"
              testID="poll-rate"
            />
          </View>
          <Divider />
          <View style={{ gap: theme.space.xs }}>
            <Label>Appearance</Label>
            <ThemeToggle testID="theme-toggle" />
          </View>
        </Column>
      </Card>

      <Card flush title="Connection" testID="connection-card">
        <CardRow label="Address" value={connection?.host ?? '—'} valueTone="dim" divider={false} />
        <View style={{ paddingHorizontal: theme.space.md, paddingBottom: theme.space.md }}>
          <Button
            testID="disconnect"
            label="Forget this computer"
            variant="danger"
            onPress={() => setConfirmForget(true)}
            fullWidth
          />
          <Caption style={{ marginTop: theme.space.sm }}>
            Forgets the saved token on this phone. The computer keeps running; pair again any time with a new code.
          </Caption>
        </View>
      </Card>

      <Sheet
        visible={confirmForget}
        onClose={() => setConfirmForget(false)}
        title={active ? `Forget ${active.label}?` : 'Forget this computer?'}
      >
        <Column gap="md">
          <Txt>
            This phone will be un-paired from it. Your other computers are not affected,
            and you can add it again with a new pairing code.
          </Txt>
          <Row gap="sm">
            <View style={{ flex: 1 }}>
              <Button label="Cancel" variant="secondary" fullWidth onPress={() => setConfirmForget(false)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Forget" variant="danger" fullWidth onPress={() => void onConfirmForget()} />
            </View>
          </Row>
        </Column>
      </Sheet>
    </ScrollView>
  );
}

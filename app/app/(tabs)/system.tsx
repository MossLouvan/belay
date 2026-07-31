// System. Live host stats — CPU, memory, disk, power, uptime — with a short
// rolling history, a selectable poll rate, and honest behaviour when the host
// stops answering. Also the place where this device forgets the computer.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { api, SystemStats } from '../../src/api';
import { useTheme } from '../../src/theme';
import { Badge, Banner, Button, Caption, Card, Column, Dot, IconButton, Label, Row, SegmentedControl, Txt } from '../../src/ui';
import { StatCard } from '../../src/system/stat-card';
import { BatteryCard, DevicesCard, HostCard, PairedDevice, parseDevices } from '../../src/system/cards';
import { EMPTY_SERIES, pushSeries, Series } from '../../src/system/history';
import { fmtAgo, fmtBytes, hasFriendlyOsName, osLabel } from '../../src/system/format';
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

const message = (e: unknown): string =>
  e instanceof Error ? e.message : 'Could not read system stats from the host.';

export default function SystemTab() {
  const { connection, disconnect } = useConnection();
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

  const onDisconnect = useCallback(async () => {
    await disconnect();
    router.replace('/');
  }, [disconnect]);

  const stale = Boolean(error);
  const title = stats?.hostname || connection?.hostName || 'Host';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{
        padding: theme.space.md,
        paddingTop: insets.top + theme.space.sm,
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
      <Row justify="space-between" align="flex-start" gap="sm">
        <Column style={{ flex: 1 }} gap="xs">
          <Txt variant="title" heading numberOfLines={1}>
            {title}
          </Txt>
          <Row gap="xs">
            <Dot status={stale ? 'bad' : 'good'} pulse={!stale} label={stale ? 'Host unreachable' : 'Live'} />
            <Caption>
              {stale
                ? lastOkAt
                  ? `No response · updated ${fmtAgo(clock - lastOkAt)}`
                  : 'No response from host'
                : lastOkAt
                  ? `Updated ${fmtAgo(clock - lastOkAt)}`
                  : 'Connecting…'}
            </Caption>
          </Row>
        </Column>
        <IconButton accessibilityLabel="Refresh stats" onPress={onRefresh} testID="refresh">
          <Txt variant="subheading" tone="dim">
            ↻
          </Txt>
        </IconButton>
      </Row>

      {stats && hasFriendlyOsName(stats) ? <Badge label={osLabel(stats)} status="accent" /> : null}

      {error ? (
        <Banner
          testID="system-error"
          status="warn"
          title="Lost contact with the host"
          message={`${error} Tether keeps retrying, and the numbers below are the last ones it received.`}
          action={{ label: 'Retry now', onPress: onRefresh }}
        />
      ) : null}

      <StatCard
        title="CPU"
        percent={stats ? stats.cpuPercent : null}
        detail={stats ? `${stats.cpuModel} · ${stats.cpuCount} cores` : undefined}
        history={series.cpu}
        testID="stat-cpu"
      />
      <StatCard
        title="Memory"
        percent={stats ? stats.memPercent : null}
        detail={stats ? `${fmtBytes(stats.memUsed)} of ${fmtBytes(stats.memTotal)} in use` : undefined}
        history={series.mem}
        testID="stat-memory"
      />
      <StatCard
        title="Disk"
        percent={stats ? stats.diskPercent : null}
        // A host that cannot query its own drive reports zeros. Rendering that
        // as "0% used, 0 B free" would read as a real, alarming measurement.
        unavailable={Boolean(stats && stats.diskTotal <= 0)}
        detail={
          stats
            ? stats.diskTotal > 0
              ? `${fmtBytes(stats.diskFree)} free of ${fmtBytes(stats.diskTotal)}`
              : 'This host does not report drive usage'
            : undefined
        }
        testID="stat-disk"
      />

      {stats?.battery ? <BatteryCard battery={stats.battery} /> : null}

      <HostCard stats={stats} />

      <Card padding="sm">
        <View style={{ paddingHorizontal: theme.space.xs, paddingTop: theme.space.xs }}>
          <Label>Update rate</Label>
        </View>
        <SegmentedControl
          options={RATE_OPTIONS}
          value={rate}
          onChange={setRate}
          accessibilityLabel="Update rate"
          testID="poll-rate"
        />
        <View style={{ paddingHorizontal: theme.space.xs, paddingTop: theme.space.sm }}>
          <Label>Appearance</Label>
        </View>
        <ThemeToggle testID="theme-toggle" />
      </Card>

      <DevicesCard devices={devices} now={clock} />

      <Card>
        <Label>Connection</Label>
        <Txt variant="monoSmall" tone="dim" numberOfLines={1} style={{ marginBottom: theme.space.md }}>
          {connection?.host ?? '—'}
        </Txt>
        <Button testID="disconnect" label="Disconnect this device" variant="danger" onPress={onDisconnect} fullWidth />
        <Caption style={{ marginTop: theme.space.sm }}>
          Forgets the saved token on this phone. The computer keeps running; pair again any time with a new code.
        </Caption>
      </Card>
    </ScrollView>
  );
}

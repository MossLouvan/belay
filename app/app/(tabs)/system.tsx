// System. Live host stats — CPU, memory, disk, uptime — polled once a second,
// plus the disconnect action that clears the stored token and returns to pairing.

import React, { useEffect, useState, useRef } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { api, SystemStats } from '../../src/api';
import { Card, Button, Label, Meter, Row } from '../../src/ui';
import { colors, radius, space } from '../../src/theme';

function fmtBytes(n: number): string {
  if (!n) return '0';
  const gb = n / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function SystemTab() {
  const { connection, disconnect } = useConnection();
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<any>(null);

  const load = async () => {
    try { setStats(await api.system()); setError(''); }
    catch (e: any) { setError(e.message); }
  };

  useEffect(() => {
    if (!connection) return;
    load();
    timer.current = setInterval(load, 1000);
    return () => clearInterval(timer.current);
  }, [connection]);

  const onDisconnect = async () => {
    clearInterval(timer.current);
    await disconnect();
    router.replace('/');
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space.md, paddingTop: insets.top + space.sm, paddingBottom: insets.bottom + space.xl }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
    >
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 22, marginBottom: space.md }}>
        {stats?.hostname || connection?.hostName || 'System'}
      </Text>

      {!!error && (
        <Card style={{ marginBottom: space.md, borderColor: '#5c2a30', backgroundColor: '#2a161a' }}>
          <Text style={{ color: colors.bad }}>{error}</Text>
        </Card>
      )}

      <View style={{ gap: space.md }}>
        <StatCard label="CPU" percent={stats?.cpuPercent ?? 0} detail={stats ? `${stats.cpuModel} · ${stats.cpuCount} cores` : ''} value={stats ? `${stats.cpuPercent}%` : '—'} />
        <StatCard label="Memory" percent={stats?.memPercent ?? 0} detail={stats ? `${fmtBytes(stats.memUsed)} of ${fmtBytes(stats.memTotal)}` : ''} value={stats ? `${stats.memPercent}%` : '—'} />
        <StatCard label="Disk (system)" percent={stats?.diskPercent ?? 0} detail={stats ? `${fmtBytes(stats.diskFree)} free of ${fmtBytes(stats.diskTotal)}` : ''} value={stats ? `${stats.diskPercent}%` : '—'} />

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Label>Uptime</Label>
              <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>{stats ? fmtUptime(stats.uptimeSec) : '—'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Label>OS</Label>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>{stats ? `${stats.platform} ${stats.release}` : '—'}</Text>
            </View>
          </Row>
        </Card>

        <Card>
          <Label>Connection</Label>
          <Text style={{ color: colors.textDim, fontSize: 13, marginBottom: space.md }} numberOfLines={1}>
            {connection?.host}
          </Text>
          <Button testID="disconnect" label="Disconnect this device" variant="danger" onPress={onDisconnect} />
        </Card>
      </View>
    </ScrollView>
  );
}

function StatCard({ label, value, percent, detail }: { label: string; value: string; percent: number; detail: string }) {
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
        <Label>{label}</Label>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 18 }}>{value}</Text>
      </Row>
      <Meter percent={percent} />
      {!!detail && <Text style={{ color: colors.textFaint, fontSize: 12, marginTop: space.sm }}>{detail}</Text>}
    </Card>
  );
}

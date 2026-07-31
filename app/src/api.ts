// Thin client for the Tether host agent. Holds the host URL + token in memory,
// persists them, and exposes typed helpers for every REST route plus WebSocket
// URL builders for the screen and terminal streams.

import AsyncStorage from '@react-native-async-storage/async-storage';

const HOST_KEY = 'tether.host';
const TOKEN_KEY = 'tether.token';
const NAME_KEY = 'tether.hostname';

export interface Connection {
  host: string; // e.g. http://100.101.102.103:8787
  token: string;
  hostName: string;
}

let conn: Connection | null = null;

export function getConnection(): Connection | null {
  return conn;
}

export async function loadConnection(): Promise<Connection | null> {
  const [host, token, hostName] = await Promise.all([
    AsyncStorage.getItem(HOST_KEY),
    AsyncStorage.getItem(TOKEN_KEY),
    AsyncStorage.getItem(NAME_KEY),
  ]);
  if (host && token) {
    conn = { host, token, hostName: hostName || 'PC' };
    return conn;
  }
  return null;
}

async function saveConnection(c: Connection): Promise<void> {
  conn = c;
  await Promise.all([
    AsyncStorage.setItem(HOST_KEY, c.host),
    AsyncStorage.setItem(TOKEN_KEY, c.token),
    AsyncStorage.setItem(NAME_KEY, c.hostName),
  ]);
}

export async function clearConnection(): Promise<void> {
  conn = null;
  await Promise.all([
    AsyncStorage.removeItem(HOST_KEY),
    AsyncStorage.removeItem(TOKEN_KEY),
    AsyncStorage.removeItem(NAME_KEY),
  ]);
}

// Normalize whatever the user typed into a base URL: add http:// if missing and
// default the port so "100.64.0.1" and "pc.local" both just work.
export function normalizeHost(input: string): string {
  let h = input.trim();
  if (!h) return h;
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  const url = new URL(h);
  if (!url.port && url.protocol === 'http:') url.port = '8787';
  return url.origin;
}

export async function checkHost(host: string): Promise<{ ok: boolean; name?: string; native?: boolean; paired?: boolean; error?: string }> {
  try {
    const res = await fetch(host + '/health', { method: 'GET' });
    if (!res.ok) return { ok: false, error: `host returned ${res.status}` };
    const j = await res.json();
    return { ok: true, name: j.name, native: j.native, paired: j.paired };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'could not reach host' };
  }
}

export async function pair(host: string, code: string, deviceName: string): Promise<Connection> {
  const res = await fetch(host + '/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || 'pairing failed');
  const c: Connection = { host, token: j.token, hostName: j.name || 'PC' };
  await saveConnection(c);
  return c;
}

function authHeaders(): Record<string, string> {
  return conn ? { Authorization: `Bearer ${conn.token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  if (!conn) throw new Error('not connected');
  const res = await fetch(conn.host + path, { headers: authHeaders() });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `request failed (${res.status})`);
  return j as T;
}

async function post<T>(path: string, body: object): Promise<T> {
  if (!conn) throw new Error('not connected');
  const res = await fetch(conn.host + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as any).error || `request failed (${res.status})`);
  return j as T;
}

// ---- typed API surface ----

export interface BatteryInfo { percent: number; charging: boolean; source: string; }

export interface SystemStats {
  hostname: string; platform: string; release: string;
  cpuCount: number; cpuModel: string; cpuPercent: number;
  memTotal: number; memUsed: number; memPercent: number;
  diskTotal: number; diskFree: number; diskPercent: number;
  uptimeSec: number; serverTime: number;
  // Added by the macOS host agent; absent on older/Windows hosts, so both the
  // friendly OS name and battery must be treated as optional at every use site.
  osName?: string;
  osVersion?: string;
  battery?: BatteryInfo | null;
}

export interface Rect { X: number; Y: number; W: number; H: number; }

/** Which capture/input permissions the host has. macOS only — undefined elsewhere. */
export interface HostPermissions { screenRecording: boolean; accessibility: boolean; }

export interface ScreenInfo {
  primary: Rect;
  virtual: Rect;
  scale?: number;
  displays?: number;
  platform?: string;
  permissions?: HostPermissions;
}

export interface FileEntry { name: string; path: string; dir: boolean; size: number; mtime: number; }

export const api = {
  system: () => get<SystemStats>('/system'),
  fileRoots: () => get<{ roots: { name: string; path: string }[] }>('/files/roots'),
  listDir: (path: string) => get<{ path: string; entries: FileEntry[] }>(`/files/list?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => get<{ path: string; name: string; content: string; truncated: boolean; size: number }>(`/files/read?path=${encodeURIComponent(path)}`),
  screenInfo: () => get<ScreenInfo>('/screen/info'),
  click: (x: number, y: number, button = 'left', double = false) => post('/input/click', { x, y, button, double }),
  move: (x: number, y: number) => post('/input/move', { x, y }),
  scroll: (dy: number, dx = 0) => post('/input/scroll', { dy, dx }),
  drag: (x1: number, y1: number, x2: number, y2: number) => post('/input/drag', { x1, y1, x2, y2 }),
  typeText: (text: string) => post('/input/text', { text }),
  key: (key: string, mods: string[] = []) => post('/input/key', { key, mods }),
  devices: () => get<{ devices: any[] }>('/devices'),
};

// WebSocket URLs use ws:// derived from the http host and carry the token as a
// query param, since browsers can't set WebSocket auth headers.
export function wsUrl(path: string, params: Record<string, string | number> = {}): string {
  if (!conn) throw new Error('not connected');
  const u = new URL(conn.host);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = path;
  u.searchParams.set('token', conn.token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

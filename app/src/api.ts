// Thin client for the Belay host agent. Holds the host URL + token in memory,
// persists them, and exposes typed helpers for every REST route plus WebSocket
// URL builders for the screen and terminal streams.

export interface Connection {
  host: string; // e.g. http://100.101.102.103:8787
  token: string;
  hostName: string;
}

/**
 * The resolved connection every request goes through.
 *
 * Which computer this points at, and which of that computer's addresses, is
 * decided by the device store and the address racer — see src/devices. This
 * module only holds the answer.
 */
let conn: Connection | null = null;

export function getConnection(): Connection | null {
  return conn;
}

/** Point the client at a resolved computer + address. */
export function setConnection(c: Connection | null): void {
  conn = c;
}

export function clearConnection(): void {
  conn = null;
}

/**
 * Ceiling on any single request.
 *
 * iOS's default is 60 seconds, which is indistinguishable from a hang: a
 * blackholed address left the Files tab showing skeletons for a minute, and
 * stalled the System tab's poll loop without ever rejecting — so the "lost
 * contact" banner never appeared and the status dot stayed green over numbers
 * that were minutes old.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** A request the host never answered. Distinct from a host that said no. */
export class TimeoutError extends Error {
  constructor(public readonly path: string) {
    super('the computer did not answer in time');
    this.name = 'TimeoutError';
  }
}

/**
 * The host rejected our token.
 *
 * Worth its own type because the fix is completely different from every other
 * failure: the computer is fine and reachable, this phone has simply been
 * un-paired from it. Treating that as a generic network error leaves a zombie
 * connection that retries forever and can never succeed.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super('this phone is no longer paired with that computer');
    this.name = 'UnauthorizedError';
  }
}

/**
 * Run a fetch under a deadline, aborting rather than abandoning it.
 *
 * Abandoning leaves the request live and free to resolve later over a newer
 * one; aborting actually cancels it. An external signal is honoured too, so a
 * caller that is racing several requests can cancel the losers.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  path: string,
  external?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  external?.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: unknown) {
    // An abort here is either our deadline or the caller's cancellation; both
    // present to the user as "no answer".
    if (e instanceof Error && e.name === 'AbortError') throw new TimeoutError(path);
    throw e;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
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

/** An address the host says it can also be reached on. */
export interface AdvertisedAddress { kind: string; url: string; }

export interface HostCheck {
  ok: boolean;
  name?: string;
  native?: boolean;
  paired?: boolean;
  error?: string;
  /** Stable machine id. Absent from hosts older than the multi-computer work. */
  id?: string;
  label?: string;
  platform?: string;
  addresses?: AdvertisedAddress[];
  reachableFromAnywhere?: boolean;
  /**
   * 'tailnet' when the host has verified this phone is on its own Tailscale
   * account and will pair with no code; 'code' (or absent, on older hosts)
   * when the 6-digit code is required.
   */
  pairing?: 'tailnet' | 'code';
}

/**
 * Probe a host's /health. Pass a signal to actually cancel the request —
 * racing a timeout only abandons the fetch, which leaves it free to resolve
 * later and clobber a newer check.
 */
export async function checkHost(host: string, signal?: AbortSignal): Promise<HostCheck> {
  try {
    const res = await fetchWithTimeout(host + '/health', { method: 'GET' }, '/health', signal);
    if (!res.ok) return { ok: false, error: `host returned ${res.status}` };
    const j = await res.json();
    return {
      ok: true,
      name: j.name,
      native: j.native,
      paired: j.paired,
      id: typeof j.id === 'string' ? j.id : undefined,
      label: typeof j.label === 'string' ? j.label : undefined,
      platform: typeof j.platform === 'string' ? j.platform : undefined,
      addresses: Array.isArray(j.addresses) ? j.addresses : undefined,
      reachableFromAnywhere: j.reachableFromAnywhere === true,
      pairing: j.pairing === 'tailnet' ? 'tailnet' : 'code',
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not reach host' };
  }
}

/** A Belay host the connected computer found on its own tailnet. */
export interface DiscoveredHost {
  id: string;
  label: string;
  platform: string;
  /** The peer's name on the tailnet, e.g. "DESKTOP-BB4FRER". */
  tailnetName: string;
  /** The address the reporting host reached it on. */
  url: string;
  addresses: AdvertisedAddress[];
}

/**
 * What /discover/hosts saw. Three distinct empty shapes on purpose — each has
 * a different fix, so they must never collapse into one "nothing found".
 */
export interface DiscoverHostsReply {
  tailscale: boolean;
  /** When tailscale is false: what actually failed on the computer. */
  detail?: string;
  /** The owner's other online tailnet devices, however many ran Belay. */
  peers: number;
  hosts: DiscoveredHost[];
}

export interface PairResult {
  readonly host: string;
  readonly token: string;
  readonly hostName: string;
}

/**
 * Trade a pairing code for a token.
 *
 * Deliberately does not persist anything: the caller owns where a computer is
 * stored, because storing it needs the host identity that /health reports, not
 * just the URL that happened to work.
 */
export async function pair(host: string, code: string, deviceName: string): Promise<PairResult> {
  const res = await fetchWithTimeout(
    host + '/pair',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    },
    '/pair',
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || 'pairing failed');
  return { host, token: j.token, hostName: j.name || 'PC' };
}

function authHeaders(): Record<string, string> {
  return conn ? { Authorization: `Bearer ${conn.token}` } : {};
}

/** Turn a non-OK response into the most specific error we can offer the UI. */
async function failureFor(res: Response, path: string): Promise<Error> {
  if (res.status === 401) return new UnauthorizedError();
  const j = await res.json().catch(() => ({}));
  return new Error((j as { error?: string }).error || `request failed (${res.status})`);
}

async function get<T>(path: string): Promise<T> {
  if (!conn) throw new Error('not connected');
  const res = await fetchWithTimeout(conn.host + path, { headers: authHeaders() }, path);
  if (!res.ok) throw await failureFor(res, path);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: object): Promise<T> {
  if (!conn) throw new Error('not connected');
  const res = await fetchWithTimeout(
    conn.host + path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    },
    path,
  );
  if (!res.ok) throw await failureFor(res, path);
  return (await res.json().catch(() => ({}))) as T;
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

/** One monitor as the host reports it: its rect within the virtual desktop. */
export interface HostScreen extends Rect {
  /** Stable index the host expects back as `screen` on capture and input. */
  index: number;
  primary: boolean;
  /**
   * Synthesized by a display driver, with no panel attached — a screen a
   * remote client can take over without stealing it from whoever is at the
   * host. Classified host-side (server/src/displays.ts); absent on older hosts.
   */
  virtualDisplay?: boolean;
  /** Short human name, e.g. "DELL U2720Q" or "Parsec Virtual Display Adapter". */
  label?: string;
}

export interface ScreenInfo {
  primary: Rect;
  virtual: Rect;
  /** Every monitor. Absent on hosts older than the multi-monitor fix. */
  screens?: HostScreen[];
  scale?: number;
  displays?: number;
  platform?: string;
  permissions?: HostPermissions;
}

export interface FileEntry { name: string; path: string; dir: boolean; size: number; mtime: number; }

/**
 * A device paired with the host.
 *
 * The host sends a `tokenPrefix`, never a whole token — enough to identify a
 * device for revocation, not enough to authenticate as one.
 */
export interface PairedDevice { tokenPrefix: string; name: string; createdAt: number; lastSeen: number; }

// ---- agent (Claude Code on the host) ----

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error';

/** One line of the session feed. Mirrors `AgentEvent` in server/src/agent-events.ts. */
export interface AgentEvent {
  t: number;
  kind: 'user' | 'text' | 'tool' | 'tool-result' | 'result' | 'info' | 'error';
  text?: string;
  tool?: string;
  detail?: string;
  ok?: boolean;
  costUsd?: number;
  durationMs?: number;
  /** Pairs a tool call with its result: the CLI's tool_use id rides on both. */
  callId?: string;
  /** Full output length before the host truncated it, so the feed can say what it cut. */
  chars?: number;
}

/** How dangerous the host judged an ask. Absent on hosts from before risk tiers. */
export type ApprovalRisk = 'read' | 'edit' | 'run' | 'danger';

/**
 * One "always allow …" option the host offers on an ask. The label is the
 * whole contract — the phone renders it verbatim and sends the id back, and
 * the host mints the grant from the pending ask itself, never from anything
 * the wire could widen.
 */
export interface ApprovalScopeChoice { id: string; label: string; }

/** What the approval card renders instead of raw JSON, when the host can say. */
export type ApprovalPreview =
  | { kind: 'edit'; path: string; oldText: string; newText: string; capped: boolean; replaceAll: boolean }
  | { kind: 'write'; path: string; content: string; capped: boolean; exists: boolean; existingLines?: number }
  | { kind: 'command'; command: string };

/** A standing scoped permission the session holds. Label is the scope, readably. */
export interface ApprovalGrant { id: string; tool: string; label: string; createdAt: number; }

/** A prompt parked until the current turn ends. */
export interface QueuedPrompt { id: string; text: string; }

/** A permission ask Claude is blocked on until the phone answers. */
export interface PendingApproval {
  id: string; tool: string; detail: string; input: string;
  /** Epoch ms when the ask auto-denies on the host; absent when it waits forever. */
  expiresAt?: number;
  /** Everything below is absent on hosts older than scoped approvals. */
  risk?: ApprovalRisk;
  choices?: ApprovalScopeChoice[];
  preview?: ApprovalPreview;
}

/**
 * The ask as it rides on a session-list row: enough to show and answer it from
 * anywhere in the app, without the full tool input the session view carries.
 */
export interface PendingApprovalSummary { id: string; tool: string; detail: string; expiresAt?: number; }

export interface AgentSessionMeta {
  id: string; title: string; cwd: string; status: AgentStatus; lastUsed: number; createdAt: number;
  /** Present (or null) on new hosts; absent entirely on hosts from before it shipped. */
  pending?: PendingApprovalSummary | null;
}

export interface AgentSnapshot extends AgentSessionMeta {
  events: AgentEvent[];
  pending: PendingApproval | null;
  /** Absent on hosts older than the prompt queue / scoped approvals. */
  queued?: QueuedPrompt | null;
  grants?: ApprovalGrant[];
}

export interface AgentProject { path: string; name: string; recent: boolean; }

/** A Claude Code session found on the PC's disk that Belay hasn't wrapped yet. */
export interface DiscoveredSession {
  claudeSessionId: string;
  cwd: string;
  mtime: number;
  preview: string;
}

export const api = {
  system: () => get<SystemStats>('/system'),
  fileRoots: () => get<{ roots: { name: string; path: string }[] }>('/files/roots'),
  listDir: (path: string) => get<{ path: string; entries: FileEntry[] }>(`/files/list?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => get<{ path: string; name: string; content: string; truncated: boolean; size: number }>(`/files/read?path=${encodeURIComponent(path)}`),
  /**
   * The request a native viewer (WKWebView, an <Image> with headers) makes
   * for a file's bytes. The credential travels in the Authorization header,
   * never the URL — a URL is written to proxy and access logs, and this repo
   * has already had to fix a token-in-URL leak once (see wsUrl below).
   */
  rawFileRequest: (path: string): { uri: string; headers: Record<string, string> } => {
    if (!conn) throw new Error('not connected');
    return { uri: `${conn.host}/files/raw?path=${encodeURIComponent(path)}`, headers: authHeaders() };
  },
  screenInfo: () => get<ScreenInfo>('/screen/info'),
  // `screen` is the monitor the coordinates are normalized against (an index
  // from ScreenInfo.screens). Left undefined it is dropped by JSON.stringify,
  // so old hosts see the exact requests they always did (primary monitor).
  click: (x: number, y: number, button = 'left', double = false, screen?: number, mods?: string[]) =>
    post('/input/click', { x, y, button, double, screen, mods }),
  move: (x: number, y: number, screen?: number) => post('/input/move', { x, y, screen }),
  scroll: (dy: number, dx = 0) => post('/input/scroll', { dy, dx }),
  drag: (x1: number, y1: number, x2: number, y2: number, screen?: number) =>
    post('/input/drag', { x1, y1, x2, y2, screen }),
  typeText: (text: string) => post('/input/text', { text }),
  // Clipboard sync: pull the PC's clipboard text, or push the phone's onto it.
  // The host caps both directions at 100k UTF-16 units and answers `truncated`
  // when a pull was cut; over-cap pushes come back as a 413 with the reason.
  clipboardGet: () => get<{ text: string; truncated?: boolean }>('/clipboard'),
  clipboardSet: (text: string) => post<{ ok: boolean; length: number }>('/clipboard', { text }),
  key: (key: string, mods: string[] = []) => post('/input/key', { key, mods }),
  devices: () => get<{ devices: PairedDevice[] }>('/devices'),
  /** Re-read this computer's addresses, so a changed IP is learned. */
  addresses: () => get<{ addresses: AdvertisedAddress[]; reachableFromAnywhere: boolean }>('/addresses'),
  /** Ask the connected computer which other Belay hosts share its tailnet. */
  discoverHosts: () => get<DiscoverHostsReply>('/discover/hosts'),
  /** Rename this computer on the host, so every phone sees the new name. */
  setLabel: (label: string) => post<{ ok: boolean; label: string }>('/label', { label }),
  /**
   * Revoke a paired device. The host only ever sends a truncated token, so the
   * ellipsis it appends has to come back off before the prefix can match. An
   * empty prefix is refused here as well as on the host, because a prefix that
   * matches everything would unpair every device at once.
   */
  revokeDevice: (tokenPrefix: string) => {
    const prefix = tokenPrefix.replace(/[…\s]+$/u, '');
    if (!prefix) throw new Error('a device prefix is required to revoke');
    return post<{ ok: boolean }>('/devices/revoke', { prefix });
  },

  // Agent: Claude Code sessions on the host. Every route is bearer-authed like
  // the rest; the live feed goes over `/ws/agent` (see `wsUrl`).
  agentStatus: () => get<{ available: boolean }>('/agent/status'),
  agentProjects: () => get<{ projects: AgentProject[] }>('/agent/projects'),
  /** Create a folder for a new project on the PC. `parent` may be `~`-relative. */
  agentCreateProject: (name: string, parent: string) =>
    post<{ project: AgentProject }>('/agent/projects', { name, parent }),
  agentSessions: () => get<{ sessions: AgentSessionMeta[] }>('/agent/sessions'),
  agentCreate: (cwd: string, title?: string) => post<AgentSnapshot>('/agent/sessions', { cwd, title }),
  agentSnapshot: (id: string) => get<AgentSnapshot>(`/agent/sessions/${encodeURIComponent(id)}`),
  agentPrompt: (id: string, text: string) => post<{ ok: boolean }>(`/agent/sessions/${encodeURIComponent(id)}/prompt`, { text }),
  agentStop: (id: string) => post<{ ok: boolean }>(`/agent/sessions/${encodeURIComponent(id)}/stop`, {}),
  agentApprove: (id: string, approvalId: string, allow: boolean, always = false) =>
    post<{ ok: boolean }>(`/agent/sessions/${encodeURIComponent(id)}/approve`, { approvalId, allow, always }),
  /** Approve with a scope choice the host offered; `choice` is one of the ask's choice ids. */
  agentApproveScoped: (id: string, approvalId: string, allow: boolean, choice?: string) =>
    post<{ ok: boolean }>(`/agent/sessions/${encodeURIComponent(id)}/approve-scoped`, { approvalId, allow, choice }),
  agentGrants: (id: string) => get<{ grants: ApprovalGrant[] }>(`/agent/sessions/${encodeURIComponent(id)}/grants`),
  agentRevokeGrant: (id: string, grantId: string) =>
    post<{ ok: boolean }>(`/agent/sessions/${encodeURIComponent(id)}/grants/revoke`, { grantId }),
  agentCancelQueued: (id: string) => post<{ ok: boolean }>(`/agent/sessions/${encodeURIComponent(id)}/queue/cancel`, {}),
  /** Interrupt-with-message: halts the running turn (or denies the pending ask) so `text` steers now. */
  agentInterrupt: (id: string, text: string) =>
    post<{ ok: boolean; outcome?: string }>(`/agent/sessions/${encodeURIComponent(id)}/interrupt`, { text }),
  agentDiscovered: () => get<{ sessions: DiscoveredSession[] }>('/agent/discovered'),
  agentAttach: (claudeSessionId: string, cwd: string, title?: string) =>
    post<AgentSnapshot>('/agent/attach', { claudeSessionId, cwd, title }),
  agentDelete: (id: string) => del<{ ok: boolean }>(`/agent/sessions/${encodeURIComponent(id)}`),

  // Phone photos → a Claude session. Stage each image with `uploadImageBase64`
  // (below — it needs the long deadline), then commit or drop the batch here.
  imagesSend: (sessionId: string, note?: string) =>
    post<{ ok: boolean; relDir?: string; files?: number }>('/images/send', {
      sessionId,
      ...(note?.trim() ? { note: note.trim() } : {}),
    }),
  imagesDiscard: () => post<{ images: number }>('/images/discard', {}),
};

/**
 * Stage one phone photo on the host. The body is base64 text under its own
 * content type — not JSON, whose parser the host caps at 2 MB, and not raw
 * binary, which React Native's fetch cannot carry reliably. A photo is a far
 * bigger transfer than any JSON route, so it gets the raw-fetch deadline
 * rather than the 10-second REST one.
 */
export async function uploadImageBase64(base64: string, signal?: AbortSignal): Promise<void> {
  if (!conn) throw new Error('not connected');
  const path = '/images/add';
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => controller.abort(), RAW_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(conn.host + path, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/base64' },
      body: base64,
      signal: controller.signal,
    });
    if (!res.ok) throw await failureFor(res, path);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') throw new TimeoutError(path);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function del<T>(path: string): Promise<T> {
  if (!conn) throw new Error('not connected');
  const res = await fetchWithTimeout(conn.host + path, { method: 'DELETE', headers: authHeaders() }, path);
  if (!res.ok) throw await failureFor(res, path);
  return (await res.json().catch(() => ({}))) as T;
}

/**
 * Fetch a previewable file's bytes and return them as a data: URI.
 *
 * A data URI is the one form every consumer renders without a second
 * authenticated request: RN's <Image> on iOS, an <img> under react-native-web,
 * and a WebView shell for SVG. Sizes are bounded — the host refuses anything
 * over its /files/raw ceilings before a byte is sent — so holding one file
 * base64-encoded in memory is fine for a viewer.
 *
 * The blob → FileReader route is deliberate: RN has no Buffer, and chunking
 * an ArrayBuffer through btoa by hand is exactly the kind of code that breaks
 * on a surrogate boundary. FileReader.readAsDataURL exists on both native and
 * web and does the encoding in one step.
 */
/**
 * A whole image or PDF is a far bigger transfer than any JSON route, so the
 * 10-second REST deadline would abort legitimate downloads on cellular. The
 * host has already capped the byte count, so a minute bounds the wait without
 * cutting off a slow link mid-file.
 */
export const RAW_FETCH_TIMEOUT_MS = 60_000;

export async function fetchDataUri(path: string, signal?: AbortSignal): Promise<string> {
  if (!conn) throw new Error('not connected');
  const route = `/files/raw?path=${encodeURIComponent(path)}`;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);
  const timer = setTimeout(() => controller.abort(), RAW_FETCH_TIMEOUT_MS);
  let blob: Blob;
  try {
    const res = await fetch(conn.host + route, { headers: authHeaders(), signal: controller.signal });
    if (!res.ok) throw await failureFor(res, route);
    blob = await res.blob();
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') throw new TimeoutError(route);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result));
    reader.onerror = () => rejectPromise(new Error('the file could not be decoded'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Build a WebSocket URL authenticated with a single-use ticket.
 *
 * A WebSocket handshake cannot carry headers, so something has to go in the
 * URL. Previously that was the bearer token, which grants complete control of
 * the machine and ends up written to any proxy or access log that records a
 * request line. A ticket is safe to put there instead: it is single-use and
 * expires in seconds, so a captured URL is worthless.
 *
 * Falls back to the token when the host is too old to offer /ws-ticket, so an
 * updated app still works against a host that has not been updated yet.
 */
export async function wsUrl(
  path: string,
  params: Record<string, string | number> = {},
): Promise<string> {
  if (!conn) throw new Error('not connected');
  const u = new URL(conn.host);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = path;

  try {
    const { ticket } = await post<{ ticket: string }>('/ws-ticket', {});
    u.searchParams.set('ticket', ticket);
  } catch (e: unknown) {
    // An unauthorized here is real and must surface — the phone has been
    // un-paired, and retrying with the token would fail the same way.
    if (e instanceof UnauthorizedError) throw e;
    u.searchParams.set('token', conn.token);
  }

  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

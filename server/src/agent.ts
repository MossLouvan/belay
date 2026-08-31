// Claude Code sessions the phone can drive. Each session wraps a `claude`
// process in bidirectional stream-json mode, running in a chosen project
// folder. Every permission ask (file edits, bash commands...) is routed to the
// phone through a small MCP sidecar (approval-mcp.cjs) that calls back into
// this server and blocks until the user taps Allow or Deny — nothing runs on
// the machine without an explicit answer, matching "ask me for everything".

import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isInsideRoots, isDenied } from './files.js';
import { notify } from './notify.js';
import type { NotifyEvent } from './notify.js';
import { getHostId, getLabel } from './state.js';
import { parseClaudeLine, toolDetail } from './agent-events.js';
import type { AgentEvent } from './agent-events.js';
import { loadClaudeHistory } from './transcript.js';

// The stream-json ↔ feed-event translation lives in agent-events.ts (shared
// with the transcript history loader); re-exported so existing importers and
// tests keep one door.
export { parseClaudeLine, toolDetail, RESULT_CAP } from './agent-events.js';
export type { AgentEvent } from './agent-events.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVAL_MCP = join(HERE, '..', 'approval-mcp.cjs');
const META_FILE = join(process.cwd(), 'tether-agent.json');
const LOG_DIR = join(process.cwd(), 'agent-logs');

// How long an approval waits for the phone before it is denied. The original
// five minutes failed exactly the person this product is for: someone whose
// phone is in a pocket. Half an hour is the default now, it is configurable,
// and 0 means wait forever — the ask just sits until someone answers or the
// session is stopped. Expiry is also no longer silent: see expireApproval.
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
// The stand-in bound when the timeout is "forever": the CLI's MCP tool timeout
// and the sidecar's HTTP timeout both need *some* number, and a week outlives
// any plausible wait without leaving a truly immortal blocked request.
const FOREVER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * TETHER_APPROVAL_TIMEOUT_MS, sanitised. Exported for tests. Garbage falls
 * back to the default rather than to zero, because a typo silently disabling
 * the timeout is the opposite of what a typo should do; anything positive is
 * floored at one minute, because a sub-minute window recreates the original
 * bug with a sharper edge.
 */
export function approvalTimeoutMs(raw: string | undefined = process.env.TETHER_APPROVAL_TIMEOUT_MS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_APPROVAL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  if (n === 0) return 0; // wait forever
  return Math.max(60 * 1000, Math.floor(n));
}

const APPROVAL_TIMEOUT_MS = approvalTimeoutMs();
const IDLE_KILL_MS = 30 * 60 * 1000;         // idle processes die; --resume revives
const EVENT_CAP = 400;                        // in-memory transcript cap per session

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface PendingApproval {
  id: string;
  tool: string;
  detail: string;
  input: string; // pretty JSON, trimmed, for the expanded view on the phone
  /** Epoch ms when the ask auto-denies; absent when configured to wait forever. */
  expiresAt?: number;
}

interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  claudeSessionId?: string;
  createdAt: number;
  lastUsed: number;
}

interface Session extends SessionMeta {
  status: AgentStatus;
  events: AgentEvent[];
  proc?: ChildProcess;
  procKey?: string;    // secret the MCP sidecar authenticates with
  buffer: string;      // partial stdout line
  pending?: PendingApproval & { resolve: (allow: boolean, message?: string) => void; timer?: NodeJS.Timeout };
  autoAllow: Set<string>; // tool names the user chose "always allow" for, this session only
  idleTimer?: NodeJS.Timeout;
  subscribers: Set<(msg: object) => void>;
}

interface Persisted { sessions: SessionMeta[]; recentProjects: string[]; }

let persisted: Persisted = { sessions: [], recentProjects: [] };
const sessions = new Map<string, Session>();

export function loadAgentState(): void {
  if (existsSync(META_FILE)) {
    try {
      persisted = JSON.parse(readFileSync(META_FILE, 'utf8'));
      if (!Array.isArray(persisted.sessions)) persisted.sessions = [];
      if (!Array.isArray(persisted.recentProjects)) persisted.recentProjects = [];
    } catch { persisted = { sessions: [], recentProjects: [] }; }
  }
  for (const meta of persisted.sessions) {
    sessions.set(meta.id, {
      ...meta, status: 'idle', events: loadEventTail(meta.id), buffer: '',
      autoAllow: new Set(), subscribers: new Set(),
    });
  }
}

function saveMeta(): void {
  persisted.sessions = [...sessions.values()].map(({ id, title, cwd, claudeSessionId, createdAt, lastUsed }) =>
    ({ id, title, cwd, claudeSessionId, createdAt, lastUsed }));
  writeFileSync(META_FILE, JSON.stringify(persisted, null, 2), 'utf8');
}

function logEvent(id: string, ev: AgentEvent): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${id}.jsonl`), JSON.stringify(ev) + '\n', 'utf8');
  } catch { /* transcript logging is best-effort */ }
}

function loadEventTail(id: string, n = 200): AgentEvent[] {
  try {
    const raw = readFileSync(join(LOG_DIR, `${id}.jsonl`), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---- claude executable ----------------------------------------------------

let claudePath: string | null | undefined; // undefined = not looked up yet

export function findClaude(): string | null {
  if (claudePath !== undefined) return claudePath;
  const probe = process.platform === 'win32' ? ['where.exe', ['claude']] as const : ['which', ['claude']] as const;
  try {
    const out = execFileSync(probe[0], probe[1] as unknown as string[], { encoding: 'utf8' });
    claudePath = out.split(/\r?\n/).find((l) => l.trim()) || null;
    if (claudePath) claudePath = claudePath.trim();
  } catch { claudePath = null; }
  return claudePath;
}

// The full claude invocation for a session, as a pure function so tests can
// assert resume behavior without spawning anything.
export function buildClaudeArgs(mcpConfigPath: string, claudeSessionId?: string): string[] {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfigPath,
    '--permission-prompt-tool', 'mcp__tether-approve__request_permission',
    '-p',
  ];
  if (claudeSessionId) args.push('--resume', claudeSessionId);
  return args;
}

// .cmd/.ps1 shims need a shell on Windows; a real .exe (native installer) not.
function spawnClaude(args: string[], cwd: string, extraEnv: Record<string, string>): ChildProcess {
  const cmd = findClaude();
  if (!cmd) throw new Error('claude CLI not found on PATH — install Claude Code on this machine first');
  const env = { ...process.env, ...extraEnv };
  if (process.platform === 'win32' && !cmd.toLowerCase().endsWith('.exe')) {
    // cmd.exe is the interpreter here, so every argument is quoted — not just
    // the ones with spaces — and cmd metacharacters are neutralised. The only
    // user-influenced args (cwd, session id) are also validated upstream.
    const quoted = [cmd, ...args].map((a) => `"${a.replace(/"/g, '\\"').replace(/[&|<>^%!]/g, '')}"`).join(' ');
    return spawn(quoted, { shell: true, cwd, env, windowsHide: true });
  }
  return spawn(cmd, args, { cwd, env, windowsHide: true });
}

// ---- session lifecycle ----------------------------------------------------

function broadcast(s: Session, msg: object): void {
  for (const send of s.subscribers) { try { send(msg); } catch { /* subscriber gone */ } }
}

function setStatus(s: Session, status: AgentStatus): void {
  if (s.status === status) return;
  s.status = status;
  broadcast(s, { type: 'status', status });
}

function pushEvent(s: Session, ev: AgentEvent): void {
  s.events.push(ev);
  if (s.events.length > EVENT_CAP) s.events.splice(0, s.events.length - EVENT_CAP);
  logEvent(s.id, ev);
  broadcast(s, { type: 'event', event: ev });
}

// The one seam between sessions and the push webhook (notify.ts): stamp the
// event with which computer and which session, then hand off. notify() is
// synchronous, void, and swallows everything, so a session path calling ping
// can be no slower and no less reliable than one that does not — the
// getLabel/getHostId reads are guarded here for the same reason.
function ping(s: Session, ev: Omit<NotifyEvent, 'host' | 'hostId' | 'session'>): void {
  try {
    notify({ ...ev, host: getLabel(), hostId: getHostId(), session: { id: s.id, title: s.title } } as NotifyEvent);
  } catch { /* a notification must never hurt a session */ }
}

function armIdleKill(s: Session): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.status === 'idle' && s.proc) { s.proc.kill(); s.proc = undefined; }
  }, IDLE_KILL_MS);
  s.idleTimer.unref?.();
}

function ensureProcess(s: Session): void {
  if (s.proc && s.proc.exitCode === null && !s.proc.killed) return;

  s.procKey = randomBytes(24).toString('hex');
  const mcpConfig = {
    mcpServers: {
      'tether-approve': {
        command: process.execPath,
        args: [APPROVAL_MCP],
        env: {
          TETHER_APPROVE_URL: `http://127.0.0.1:${process.env.TETHER_PORT || 8787}/agent/approval-request`,
          TETHER_APPROVE_KEY: s.procKey,
          TETHER_APPROVE_SESSION: s.id,
          // The sidecar holds its HTTP request open while the ask waits, so it
          // must outlast this server's own window — including a "forever" one.
          TETHER_APPROVE_TIMEOUT_MS: String((APPROVAL_TIMEOUT_MS || FOREVER_MS) + 30000),
        },
      },
    },
  };
  const cfgPath = join(tmpdir(), `tether-mcp-${s.id}.json`);
  writeFileSync(cfgPath, JSON.stringify(mcpConfig), 'utf8');

  const args = buildClaudeArgs(cfgPath, s.claudeSessionId);

  // Generous MCP timeouts so an approval can sit unanswered while the phone is
  // in a pocket; the host itself denies after APPROVAL_TIMEOUT_MS (or never,
  // when configured to wait), so these only need to sit safely beyond that.
  const proc = spawnClaude(args, s.cwd, {
    MCP_TIMEOUT: '60000',
    MCP_TOOL_TIMEOUT: String((APPROVAL_TIMEOUT_MS || FOREVER_MS) + 60000),
  });
  s.proc = proc;
  s.buffer = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    s.buffer += chunk.toString();
    let nl;
    while ((nl = s.buffer.indexOf('\n')) >= 0) {
      const line = s.buffer.slice(0, nl).trim();
      s.buffer = s.buffer.slice(nl + 1);
      if (!line) continue;
      const parsed = parseClaudeLine(line);
      if (parsed.sessionId && parsed.sessionId !== s.claudeSessionId) {
        s.claudeSessionId = parsed.sessionId;
        saveMeta();
      }
      for (const ev of parsed.events) pushEvent(s, ev);
      if (parsed.done) {
        setStatus(s, 'idle'); armIdleKill(s);
        const r = parsed.events.find((e) => e.kind === 'result');
        ping(s, { kind: 'done', ok: r?.ok, costUsd: r?.costUsd, durationMs: r?.durationMs });
      }
    }
  });
  let stderrTail = '';
  proc.stderr?.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-2000); });
  proc.on('exit', (code) => {
    if (s.proc !== proc) return;
    s.proc = undefined;
    if (s.pending) answerApproval(s.id, s.pending.id, false, 'session process exited');
    if (s.status === 'running' || s.status === 'waiting') {
      pushEvent(s, { t: Date.now(), kind: 'error', text: `claude exited (${code})${stderrTail ? ': ' + stderrTail.slice(-300) : ''}` });
      setStatus(s, 'error');
      // The stderr tail stays out of the ping: it can quote paths and
      // commands, and the redaction default promises metadata only.
      ping(s, { kind: 'error', text: `the Claude process exited (${code})` });
    }
  });
}

// ---- public API used by index.ts ------------------------------------------

export function listSessions() {
  // The pending summary rides on every row so the phone can show — and answer —
  // an approval from anywhere, without opening a socket per session. The full
  // tool input stays out: it can be 2KB per row, and answering only needs the
  // id; the session view has the whole thing for anyone who wants to read it.
  return [...sessions.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map((s) => ({
      id: s.id, title: s.title, cwd: s.cwd, status: s.status, lastUsed: s.lastUsed, createdAt: s.createdAt,
      pending: s.pending
        ? { id: s.pending.id, tool: s.pending.tool, detail: s.pending.detail, expiresAt: s.pending.expiresAt }
        : null,
    }));
}

/**
 * Turn the phone's "where should Claude work" string into a real directory
 * inside the allowed roots. `~` expands to the host user's home; the path must
 * exist and be a folder.
 *
 * Confined the same way projects.ts confines its mkdir parent, and for a
 * harder reason: a session cwd is an *execution* primitive. Claude runs there,
 * reads whatever the folder holds, and one approved `Read` in the wrong
 * directory (the server's own state dir, say, which holds paired-device
 * tokens) is exfiltration. The check runs on the realpath, not the lexical
 * one, so neither `..` nor a planted symlink can smuggle the session outside —
 * and the *resolved* path is what gets stored and handed to spawn(), so the
 * path that was checked is the path that runs. Deny-listed locations report
 * the same "outside" message as genuinely outside ones, matching projects.ts:
 * confirming which sensitive paths exist is information a probe should not get.
 */
export function resolveSessionCwd(cwd: string): string {
  const expanded = cwd.replace(/^~(?=$|[\\/])/, homedir());
  if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
    throw new Error(`not a folder: ${expanded}`);
  }
  let real: string;
  try { real = realpathSync.native(expanded); }
  catch { throw new Error(`not a folder: ${expanded}`); }
  if (!isInsideRoots(real) || isDenied(real)) {
    throw new Error('that folder is outside the allowed folders');
  }
  return real;
}

function newSession(cwd: string, title?: string, claudeSessionId?: string): Session {
  const resolved = resolveSessionCwd(cwd);
  const id = randomBytes(8).toString('hex');
  const s: Session = {
    id, cwd: resolved, claudeSessionId,
    title: title || resolved.split(/[\\/]/).filter(Boolean).pop() || 'session',
    createdAt: Date.now(), lastUsed: Date.now(),
    status: 'idle', events: [], buffer: '', autoAllow: new Set(), subscribers: new Set(),
  };
  sessions.set(id, s);
  rememberProject(resolved);
  saveMeta();
  return s;
}

export function createSession(cwd: string, title?: string) {
  return getSnapshot(newSession(cwd, title).id)!;
}

// Adopt a session Claude Code already has on disk (started from a terminal or
// anywhere else): the next prompt spawns `claude --resume <id>` with the
// phone-approval MCP attached, so context carries over and the approval flow
// applies from the first action.
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function attachSession(cwd: string, claudeSessionId: string, title?: string) {
  if (!claudeSessionId) throw new Error('missing claudeSessionId');
  // The id becomes a `claude --resume` argument: accept only a real UUID.
  if (!SESSION_ID.test(claudeSessionId)) throw new Error('claudeSessionId is not a session uuid');
  for (const s of sessions.values()) {
    if (s.claudeSessionId === claudeSessionId) return getSnapshot(s.id)!; // already attached
  }
  const s = newSession(cwd, title, claudeSessionId);
  // Restore the tail of the Claude-side transcript so the resumed session
  // opens showing the conversation being resumed, not a blank feed. Pushed
  // through pushEvent so the history also lands in Tether's own log and
  // survives host restarts. Best-effort: a missing or unreadable transcript
  // degrades to the old behaviour, and the info line says which happened
  // instead of letting an empty feed pass for a fresh session.
  const history = loadClaudeHistory(claudeSessionId);
  for (const ev of history) pushEvent(s, ev);
  pushEvent(s, {
    t: Date.now(), kind: 'info',
    text: history.length
      ? 'resumed session — earlier conversation restored from this computer'
      : 'resumed session — no readable transcript on this computer, but Claude still has the context',
  });
  return getSnapshot(s.id)!;
}

// Claude session ids Tether already wraps — the discovery list excludes these.
export function attachedClaudeIds(): Set<string> {
  const out = new Set<string>();
  for (const s of sessions.values()) if (s.claudeSessionId) out.add(s.claudeSessionId);
  return out;
}

export function getSnapshot(id: string) {
  const s = sessions.get(id);
  if (!s) return null;
  return {
    id: s.id, title: s.title, cwd: s.cwd, status: s.status,
    createdAt: s.createdAt, lastUsed: s.lastUsed,
    events: s.events,
    pending: s.pending
      ? { id: s.pending.id, tool: s.pending.tool, detail: s.pending.detail, input: s.pending.input, expiresAt: s.pending.expiresAt }
      : null,
  };
}

export function deleteSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.proc?.kill();
  if (s.pending) clearTimeout(s.pending.timer);
  sessions.delete(id);
  saveMeta();
  return true;
}

export function sendPrompt(id: string, text: string): void {
  const s = sessions.get(id);
  if (!s) throw new Error('no such session');
  if (s.status === 'running' || s.status === 'waiting') throw new Error('session is busy — wait or stop it first');
  ensureProcess(s);
  s.lastUsed = Date.now();
  saveMeta();
  pushEvent(s, { t: Date.now(), kind: 'user', text });
  setStatus(s, 'running');
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
  s.proc!.stdin!.write(JSON.stringify(msg) + '\n');
}

export function stopSession(id: string): void {
  const s = sessions.get(id);
  if (!s) throw new Error('no such session');
  if (s.pending) answerApproval(id, s.pending.id, false, 'stopped from phone');
  if (s.proc) { s.proc.kill(); s.proc = undefined; }
  if (s.status !== 'idle') {
    pushEvent(s, { t: Date.now(), kind: 'info', text: 'stopped' });
    setStatus(s, 'idle');
  }
}

export function subscribe(id: string, send: (msg: object) => void): (() => void) | null {
  const s = sessions.get(id);
  if (!s) return null;
  s.subscribers.add(send);
  return () => s.subscribers.delete(send);
}

// Called by the loopback route the MCP sidecar POSTs to. Resolves when the
// user answers on the phone, or fails closed on timeout.
export function requestApproval(
  sessionId: string, procKey: string, toolName: string, input: any,
): Promise<{ allow: boolean; message?: string }> {
  const s = sessions.get(sessionId);
  if (!s || !s.procKey || procKey !== s.procKey) {
    return Promise.resolve({ allow: false, message: 'unknown session' });
  }
  if (s.autoAllow.has(toolName)) {
    return Promise.resolve({ allow: true });
  }
  if (s.pending) {
    // claude asks one at a time; a second concurrent ask means something is
    // off — fail closed rather than queue.
    return Promise.resolve({ allow: false, message: 'another approval is already pending' });
  }
  return new Promise((resolve) => {
    const id = randomBytes(6).toString('hex');
    const pretty = JSON.stringify(input ?? {}, null, 2);
    const pending = {
      id, tool: toolName,
      detail: toolDetail(toolName, input),
      input: pretty.length > 2000 ? pretty.slice(0, 2000) + '…' : pretty,
      expiresAt: APPROVAL_TIMEOUT_MS ? Date.now() + APPROVAL_TIMEOUT_MS : undefined,
      resolve: (allow: boolean, message?: string) => resolve({ allow, message }),
      timer: APPROVAL_TIMEOUT_MS ? setTimeout(() => expireApproval(sessionId, id), APPROVAL_TIMEOUT_MS) : undefined,
    };
    s.pending = pending;
    setStatus(s, 'waiting');
    broadcast(s, {
      type: 'permission',
      request: { id, tool: pending.tool, detail: pending.detail, input: pending.input, expiresAt: pending.expiresAt },
    });
    // After the ask is fully raised and waiting, so a webhook — however
    // broken — can only ever be in addition to the approval, never in its way.
    ping(s, { kind: 'approval', tool: pending.tool, detail: pending.detail, expiresAt: pending.expiresAt });
  });
}

/**
 * The ask ran out of clock with nobody there. Distinct from answerApproval on
 * purpose: a deny the user tapped and a deny nobody chose must not read the
 * same afterwards. The feed gets a loud `error` line that survives in the
 * transcript — a session that died unanswered says so instead of just
 * stopping — and Claude is told the silence was absence, not refusal, so it
 * wraps up cleanly. Nothing here is terminal: the Claude session persists on
 * disk, so prompting again re-attempts the work and re-asks fresh. A true
 * held-open re-ask is not possible through MCP — once the tool call resolves
 * (or the CLI's own tool timeout fires) that conversational turn is spent —
 * so "expired, visibly, and one prompt away from resuming" is the honest
 * version, and TETHER_APPROVAL_TIMEOUT_MS=0 exists for anyone who would
 * rather the ask simply wait forever.
 */
function expireApproval(sessionId: string, approvalId: string): void {
  const s = sessions.get(sessionId);
  if (!s || !s.pending || s.pending.id !== approvalId) return;
  const pending = s.pending;
  s.pending = undefined;
  const mins = Math.max(1, Math.round(APPROVAL_TIMEOUT_MS / 60000));
  pushEvent(s, {
    t: Date.now(), kind: 'error',
    text: `nobody answered — ${pending.tool}${pending.detail ? ' (' + pending.detail.slice(0, 80) + ')' : ''} was denied after ${mins} min with no one there. Send a prompt to have Claude pick the work back up.`,
  });
  broadcast(s, { type: 'permission-clear' });
  setStatus(s, 'running');
  ping(s, { kind: 'expired', tool: pending.tool, detail: pending.detail, waitedMin: mins });
  pending.resolve(false, `No one answered the approval on the phone within ${mins} minutes. This is absence, not refusal — stop what you are doing cleanly and summarise what remains, so the user can resume and ask you to retry.`);
}

export function answerApproval(sessionId: string, approvalId: string, allow: boolean, message?: string, always?: boolean): boolean {
  const s = sessions.get(sessionId);
  if (!s || !s.pending || s.pending.id !== approvalId) return false;
  const pending = s.pending;
  clearTimeout(pending.timer);
  s.pending = undefined;
  if (allow && always) s.autoAllow.add(pending.tool);
  pushEvent(s, {
    t: Date.now(), kind: 'info',
    text: `${allow ? 'allowed' : 'denied'} ${pending.tool}${pending.detail ? ': ' + pending.detail.slice(0, 80) : ''}`,
  });
  broadcast(s, { type: 'permission-clear' });
  setStatus(s, 'running');
  pending.resolve(allow, message || (allow ? undefined : 'The user denied this action from their phone.'));
  return true;
}

// ---- project discovery -----------------------------------------------------

function rememberProject(path: string): void {
  persisted.recentProjects = [path, ...persisted.recentProjects.filter((p) => p !== path)].slice(0, 12);
}

// A freshly created project has no .git yet, so the repo scan below would not
// find it; recording it as a recent is what makes it appear in the picker the
// moment it exists. Persisted immediately — creation happens outside any
// session, so no later saveMeta is coming.
export function rememberProjectPath(path: string): void {
  rememberProject(path);
  saveMeta();
}

// Recents first, then one level of ~/Documents and ~ scanned for git repos.
export function listProjects(): { path: string; name: string; recent: boolean }[] {
  const seen = new Set<string>();
  const out: { path: string; name: string; recent: boolean }[] = [];
  const push = (path: string, recent: boolean) => {
    if (seen.has(path.toLowerCase())) return;
    seen.add(path.toLowerCase());
    out.push({ path, name: path.split(/[\\/]/).filter(Boolean).pop() || path, recent });
  };
  for (const p of persisted.recentProjects) if (existsSync(p)) push(p, true);
  for (const root of [join(homedir(), 'Documents'), homedir()]) {
    try {
      for (const name of readdirSync(root)) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        const full = join(root, name);
        try {
          if (statSync(full).isDirectory() && existsSync(join(full, '.git'))) push(full, false);
        } catch { /* unreadable entry */ }
      }
    } catch { /* root missing */ }
  }
  return out.slice(0, 30);
}

export function agentAvailable(): boolean {
  return findClaude() !== null;
}

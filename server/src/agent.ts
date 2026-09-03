// Claude Code sessions the phone can drive. Each session wraps a `claude`
// process in bidirectional stream-json mode, running in a chosen project
// folder. Every permission ask (file edits, bash commands...) is routed to the
// phone through a small MCP sidecar (approval-mcp.cjs) that calls back into
// this server and blocks until the user taps Allow or Deny — nothing runs on
// the machine without an explicit answer, matching "ask me for everything".

import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isInsideRoots, isDenied } from './files.js';
import { notify } from './notify.js';
import type { NotifyEvent } from './notify.js';
import { getHostId, getLabel } from './state.js';
import { parseClaudeLine } from './agent-events.js';
import type { AgentEvent } from './agent-events.js';
import { loadClaudeHistory } from './transcript.js';
import {
  approvalsWaitingWire, flowAnswer, flowCancelQueued, flowDenyAll, flowDropQueued,
  flowExpire, flowInterrupt, flowPrompt, flowRequestApproval, flowTurnDone,
  flowRevokeGrant, grantSummary, pendingWire,
} from './agent-flow.js';
import type { FlowIO, PendingState, QueuedPrompt } from './agent-flow.js';
import type { ApprovalGrant } from './approval-scopes.js';
import { productEnv } from './env.js';

// The stream-json ↔ feed-event translation lives in agent-events.ts (shared
// with the transcript history loader); re-exported so existing importers and
// tests keep one door.
export { parseClaudeLine, toolDetail, RESULT_CAP } from './agent-events.js';
export type { AgentEvent } from './agent-events.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVAL_MCP = join(HERE, '..', 'approval-mcp.cjs');
const META_FILE = join(process.cwd(), 'belay-agent.json');
// The pre-rename metadata file. Read only when the new one does not exist —
// otherwise every session the owner can resume from the phone would vanish
// from the list on the first boot after the rename. Never written, never
// deleted: a still-running old host may be using it.
const LEGACY_META_FILE = join(process.cwd(), 'tether-agent.json');
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
 * BELAY_APPROVAL_TIMEOUT_MS, sanitised. Exported for tests. Garbage falls
 * back to the default rather than to zero, because a typo silently disabling
 * the timeout is the opposite of what a typo should do; anything positive is
 * floored at one minute, because a sub-minute window recreates the original
 * bug with a sharper edge.
 */
export function approvalTimeoutMs(raw: string | undefined = productEnv('APPROVAL_TIMEOUT_MS')): number {
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
  mcpConfigPath?: string; // 0600 temp file holding that secret; unlinked on exit
  buffer: string;      // partial stdout line
  pending?: PendingState;
  // Asks that arrived while `pending` waited — Claude's parallel tool use
  // makes that routine. FIFO, each on its own fail-closed clock; agent-flow.ts
  // owns the lifecycle.
  approvalQueue: readonly PendingState[];
  queued?: QueuedPrompt;
  // Scoped standing permissions, this session only — see approval-scopes.ts.
  // Deliberately not persisted: trust granted to a live session dies with it,
  // and the old whole-tool autoAllow Set it replaces was in-memory too, so
  // there is no stored state for a wider grant to hide in.
  grants: readonly ApprovalGrant[];
  idleTimer?: NodeJS.Timeout;
  subscribers: Set<(msg: object) => void>;
}

interface Persisted { sessions: SessionMeta[]; recentProjects: string[]; }

let persisted: Persisted = { sessions: [], recentProjects: [] };
const sessions = new Map<string, Session>();

export function loadAgentState(): void {
  const source = existsSync(META_FILE) ? META_FILE
    : (existsSync(LEGACY_META_FILE) ? LEGACY_META_FILE : null);
  if (source !== null) {
    try {
      persisted = JSON.parse(readFileSync(source, 'utf8'));
      if (!Array.isArray(persisted.sessions)) persisted.sessions = [];
      if (!Array.isArray(persisted.recentProjects)) persisted.recentProjects = [];
    } catch { persisted = { sessions: [], recentProjects: [] }; }
  }
  for (const meta of persisted.sessions) {
    sessions.set(meta.id, {
      ...meta, status: 'idle', events: loadEventTail(meta.id), buffer: '',
      approvalQueue: [], grants: [], subscribers: new Set(),
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
    '--permission-prompt-tool', 'mcp__belay-approve__request_permission',
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

// The seam the state machine in agent-flow.ts acts through: it decides what
// happens, this binding decides how it lands on this session's process,
// subscribers and webhook. Built per call — it closes over nothing but `s`.
function flowIO(s: Session): FlowIO {
  return {
    push: (ev) => pushEvent(s, ev),
    send: (msg) => broadcast(s, msg),
    setStatus: (status) => setStatus(s, status),
    deliver: (text) => {
      ensureProcess(s);
      s.lastUsed = Date.now();
      saveMeta();
      const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
      s.proc!.stdin!.write(JSON.stringify(msg) + '\n');
    },
    interruptTurn: () => {
      // stream-json's control channel; an older CLI that does not know it
      // simply finishes the turn, and the queued message fires then instead.
      if (!s.proc || s.proc.exitCode !== null) return;
      try {
        s.proc.stdin!.write(JSON.stringify({
          type: 'control_request',
          request_id: randomBytes(6).toString('hex'),
          request: { subtype: 'interrupt' },
        }) + '\n');
      } catch { /* a failed halt just means the queue waits for the natural end */ }
    },
    ping: (ev) => ping(s, ev as Omit<NotifyEvent, 'host' | 'hostId' | 'session'>),
  };
}

function ensureProcess(s: Session): void {
  if (s.proc && s.proc.exitCode === null && !s.proc.killed) return;

  s.procKey = randomBytes(24).toString('hex');
  const mcpConfig = {
    mcpServers: {
      'belay-approve': {
        command: process.execPath,
        args: [APPROVAL_MCP],
        env: {
          BELAY_APPROVE_URL: `http://127.0.0.1:${productEnv('PORT') || 8787}/agent/approval-request`,
          BELAY_APPROVE_KEY: s.procKey,
          BELAY_APPROVE_SESSION: s.id,
          // The sidecar holds its HTTP request open while the ask waits, so it
          // must outlast this server's own window — including a "forever" one.
          BELAY_APPROVE_TIMEOUT_MS: String((APPROVAL_TIMEOUT_MS || FOREVER_MS) + 30000),
        },
      },
    },
  };
  const cfgPath = join(tmpdir(), `belay-mcp-${s.id}.json`);
  // 0600, not the default 0644: this file carries the approval key that is the
  // only authenticator on the loopback /agent/approval-request, so no other
  // local user may read it. Unlink any stale copy first so the mode is applied
  // to a fresh inode rather than left at a previous run's permissions.
  try { unlinkSync(cfgPath); } catch { /* absent is fine */ }
  writeFileSync(cfgPath, JSON.stringify(mcpConfig), { encoding: 'utf8', mode: 0o600 });
  s.mcpConfigPath = cfgPath;

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
        // flowTurnDone fires a queued prompt if one waits; only a genuinely
        // idle session arms the kill timer. The done ping fires either way —
        // the turn the user was waiting on did finish.
        if (!flowTurnDone(s, flowIO(s))) armIdleKill(s);
        const r = parsed.events.find((e) => e.kind === 'result');
        ping(s, { kind: 'done', ok: r?.ok, costUsd: r?.costUsd, durationMs: r?.durationMs });
      }
    }
  });
  let stderrTail = '';
  proc.stderr?.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-2000); });
  proc.on('exit', (code) => {
    if (s.mcpConfigPath) { try { unlinkSync(s.mcpConfigPath); } catch { /* already gone */ } s.mcpConfigPath = undefined; }
    if (s.proc !== proc) return;
    s.proc = undefined;
    // Every waiting ask — the card and the stack behind it — fails closed.
    flowDenyAll(s, flowIO(s), 'session process exited');
    // A queued prompt must not fire into whatever process comes next — the
    // context it was written against died with this one.
    flowDropQueued(s, flowIO(s), 'the session process exited');
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
        ? {
            id: s.pending.id, tool: s.pending.tool, detail: s.pending.detail, expiresAt: s.pending.expiresAt,
            // How many more asks stand behind this one, so list surfaces can
            // say "…and 2 more" without carrying every queued input.
            waiting: s.approvalQueue.length,
          }
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
    status: 'idle', events: [], buffer: '', approvalQueue: [], grants: [], subscribers: new Set(),
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
  // through pushEvent so the history also lands in Belay's own log and
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

// Claude session ids Belay already wraps — the discovery list excludes these.
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
    pending: s.pending ? pendingWire(s.pending) : null,
    // The stack behind the card, so a fresh socket's hello starts honest.
    approvalsWaiting: approvalsWaitingWire(s),
    queued: s.queued ?? null,
    grants: s.grants.map(grantSummary),
  };
}

export function deleteSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.proc?.kill();
  if (s.pending) clearTimeout(s.pending.timer);
  for (const p of s.approvalQueue) clearTimeout(p.timer);
  sessions.delete(id);
  saveMeta();
  return true;
}

/**
 * A prompt lands immediately on an idle session; a busy one queues it (one
 * slot, latest wins, broadcast so the phone can show and cancel it) instead
 * of throwing "busy" — the refusal that used to leave Stop as the only lever.
 */
export function sendPrompt(id: string, text: string): 'sent' | 'queued' {
  const s = sessions.get(id);
  if (!s) throw new Error('no such session');
  if (!text.trim()) throw new Error('a prompt needs some text');
  return flowPrompt(s, flowIO(s), text);
}

/** Interrupt-with-message — see flowInterrupt for the three shapes it takes. */
export function interruptSession(id: string, text: string): 'sent' | 'steered' | 'interrupted' {
  const s = sessions.get(id);
  if (!s) throw new Error('no such session');
  if (!text.trim()) throw new Error('an interrupt needs the message to steer with');
  return flowInterrupt(s, flowIO(s), text);
}

export function cancelQueuedPrompt(id: string): boolean {
  const s = sessions.get(id);
  if (!s) throw new Error('no such session');
  return flowCancelQueued(s, flowIO(s));
}

export function stopSession(id: string): void {
  const s = sessions.get(id);
  if (!s) throw new Error('no such session');
  flowDenyAll(s, flowIO(s), 'stopped from phone');
  flowDropQueued(s, flowIO(s), 'stopped from phone');
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

// Called by the loopback route the MCP sidecar POSTs to. Resolves when a
// standing grant covers the ask (leaving a visible feed line, never
// silently), when the user answers on the phone, or fails closed on timeout.
// The lifecycle itself — including why expiry is a distinct, loudly-worded
// path — lives in agent-flow.ts.
export function requestApproval(
  sessionId: string, procKey: string, toolName: string, input: any,
): Promise<{ allow: boolean; message?: string }> {
  const s = sessions.get(sessionId);
  if (!s || !s.procKey || procKey !== s.procKey) {
    return Promise.resolve({ allow: false, message: 'unknown session' });
  }
  return flowRequestApproval(
    s, flowIO(s), toolName, input, APPROVAL_TIMEOUT_MS,
    (approvalId) => {
      const live = sessions.get(sessionId);
      if (live) flowExpire(live, flowIO(live), approvalId, APPROVAL_TIMEOUT_MS);
    },
  );
}

/**
 * The old answer wire, kept signature-stable for index.ts and old apps. The
 * bare `always` boolean used to whitelist the whole tool; it now narrows to
 * the narrowest scope the card offered — see flowAnswer.
 */
export function answerApproval(sessionId: string, approvalId: string, allow: boolean, message?: string, always?: boolean): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  return flowAnswer(s, flowIO(s), approvalId, allow, { message, legacyAlways: always });
}

/** The scoped answer: `choiceId` names one of the choices the card offered. */
export function answerApprovalScoped(sessionId: string, approvalId: string, allow: boolean, choiceId?: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  return flowAnswer(s, flowIO(s), approvalId, allow, { choiceId });
}

export function listGrants(id: string) {
  const s = sessions.get(id);
  if (!s) return null;
  return s.grants.map(grantSummary);
}

export function revokeGrant(id: string, grantId: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  return flowRevokeGrant(s, flowIO(s), grantId);
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

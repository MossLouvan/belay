// Claude Code sessions the phone can drive. Each session wraps a `claude`
// process in bidirectional stream-json mode, running in a chosen project
// folder. Every permission ask (file edits, bash commands...) is routed to the
// phone through a small MCP sidecar (approval-mcp.cjs) that calls back into
// this server and blocks until the user taps Allow or Deny — nothing runs on
// the machine without an explicit answer, matching "ask me for everything".

import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVAL_MCP = join(HERE, '..', 'approval-mcp.cjs');
const META_FILE = join(process.cwd(), 'tether-agent.json');
const LOG_DIR = join(process.cwd(), 'agent-logs');

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;   // unanswered asks fail closed
const IDLE_KILL_MS = 30 * 60 * 1000;         // idle processes die; --resume revives
const EVENT_CAP = 400;                        // in-memory transcript cap per session

// One-line summary of a tool call, for the phone's activity feed and the
// approval prompt. Falls back to the first string field of the input.
export function toolDetail(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    name === 'Bash' ? input.command
    : name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit' ? input.file_path
    : name === 'Glob' || name === 'Grep' ? input.pattern
    : name === 'WebFetch' ? input.url
    : name === 'WebSearch' ? input.query
    : name === 'Task' ? input.description
    : Object.values(input).find((v) => typeof v === 'string');
  const s = typeof pick === 'string' ? pick : '';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

// What the phone renders. Kept deliberately flat and small.
export interface AgentEvent {
  t: number;
  kind: 'user' | 'text' | 'tool' | 'result' | 'info' | 'error';
  text?: string;
  tool?: string;
  detail?: string;
  ok?: boolean;
  costUsd?: number;
  durationMs?: number;
}

// Translate one stream-json line from the claude CLI into phone events.
// Unknown/noise types (tool results, thinking, partials) map to [].
export function parseClaudeLine(line: string): { events: AgentEvent[]; sessionId?: string; done?: boolean } {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return { events: [] }; }
  const now = Date.now();

  if (msg.type === 'system' && msg.subtype === 'init') {
    return { events: [], sessionId: msg.session_id };
  }
  if (msg.type === 'assistant') {
    const events: AgentEvent[] = [];
    for (const block of msg.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) {
        events.push({ t: now, kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        events.push({ t: now, kind: 'tool', tool: block.name, detail: toolDetail(block.name, block.input) });
      }
    }
    return { events };
  }
  if (msg.type === 'result') {
    return {
      events: [{
        t: now, kind: 'result', ok: !msg.is_error,
        text: msg.is_error ? String(msg.result || msg.error || 'failed').slice(0, 500) : undefined,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
      }],
      done: true,
    };
  }
  return { events: [] };
}

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface PendingApproval {
  id: string;
  tool: string;
  detail: string;
  input: string; // pretty JSON, trimmed, for the expanded view on the phone
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
  pending?: PendingApproval & { resolve: (allow: boolean, message?: string) => void; timer: NodeJS.Timeout };
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
        },
      },
    },
  };
  const cfgPath = join(tmpdir(), `tether-mcp-${s.id}.json`);
  writeFileSync(cfgPath, JSON.stringify(mcpConfig), 'utf8');

  const args = buildClaudeArgs(cfgPath, s.claudeSessionId);

  // Generous MCP timeouts so an approval can sit unanswered while the phone is
  // in a pocket; the sidecar itself fails closed after APPROVAL_TIMEOUT_MS.
  const proc = spawnClaude(args, s.cwd, {
    MCP_TIMEOUT: '60000',
    MCP_TOOL_TIMEOUT: String(APPROVAL_TIMEOUT_MS + 30000),
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
      if (parsed.done) { setStatus(s, 'idle'); armIdleKill(s); }
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
    }
  });
}

// ---- public API used by index.ts ------------------------------------------

export function listSessions() {
  return [...sessions.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, status: s.status, lastUsed: s.lastUsed, createdAt: s.createdAt }));
}

function newSession(cwd: string, title?: string, claudeSessionId?: string): Session {
  const resolved = cwd.replace(/^~(?=$|[\\/])/, homedir());
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`not a folder: ${resolved}`);
  }
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
  pushEvent(s, { t: Date.now(), kind: 'info', text: 'resumed session — context restored on the PC' });
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
    pending: s.pending ? { id: s.pending.id, tool: s.pending.tool, detail: s.pending.detail, input: s.pending.input } : null,
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
      resolve: (allow: boolean, message?: string) => resolve({ allow, message }),
      timer: setTimeout(() => answerApproval(sessionId, id, false, 'no answer from phone (timed out)'), APPROVAL_TIMEOUT_MS),
    };
    s.pending = pending;
    setStatus(s, 'waiting');
    broadcast(s, { type: 'permission', request: { id, tool: pending.tool, detail: pending.detail, input: pending.input } });
  });
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

// Hand a phone-driven Claude session to the computer's own keyboard: open a
// terminal window there, already running `claude --resume <id>` in the right
// project. The one-tap version of `npm run sessions` plus copy-paste.
//
// The dangerous edge is not the terminal — it is the session. A Claude Code
// session is one transcript file, and two clients resuming it at once (the
// phone's stream-json child and a fresh terminal) interleave writes and fork
// the history in a way neither side can see. So the handoff *always* releases
// Tether's side first: the idle child is killed (resume revives it later, as
// it already does after the idle reaper), and a session that is mid-task is
// never touched without the phone explicitly saying "stop it" — the route
// answers 409 and the app asks the user. There is no code path that leaves
// both clients attached.
//
// When this machine cannot open a window at all — headless, unknown platform,
// AppleScript refused — the response still carries the exact command to paste,
// because that is what the user does manually today. Falling back to it is a
// downgrade, not a failure.

import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Request, Response } from 'express';
import { getSnapshot, stopSession } from './agent.js';

/**
 * Where agent.ts persists session metadata. Read-only here: agent.ts owns the
 * file and does not export the sessions map or the claude id, so the handoff
 * reads what it durably wrote — saveMeta() runs the moment a claude session id
 * appears or changes, so the file is never behind the fact we need.
 */
const META_FILE = join(process.cwd(), 'tether-agent.json');

/** Same shape agent.ts enforces before ever passing an id to --resume. */
const SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/**
 * The claude session id recorded for a Tether session, if any. A session that
 * has never run a prompt has nothing to resume — the handoff then opens plain
 * `claude` in the project, which is honest: the terminal starts where the
 * phone would have.
 */
export function readClaudeSessionId(tetherSessionId: string, metaFile: string = META_FILE): string | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(metaFile, 'utf8'));
    const sessions = (raw as { sessions?: unknown })?.sessions;
    if (!Array.isArray(sessions)) return undefined;
    const meta = sessions.find((s: unknown) =>
      typeof s === 'object' && s !== null && (s as { id?: unknown }).id === tetherSessionId);
    const id = (meta as { claudeSessionId?: unknown } | undefined)?.claudeSessionId;
    return isClaudeSessionId(id) ? id : undefined;
  } catch {
    return undefined; // no meta file yet — same as "no history yet"
  }
}

// ---- the command ----------------------------------------------------------
//
// The one interpolated string in this feature, and it is unavoidable: what a
// terminal ultimately runs *is* a shell line. Everything user-influenced in it
// is either strictly quoted (the project path) or validated against the uuid
// grammar before it can appear (the session id) — and the same string doubles
// as the copyable fallback, so the pasted command and the launched one never
// disagree.

/** POSIX single-quoting: safe for any byte except that `'` needs the dance. */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The resume line for this platform, exactly as a human would type it.
 * On Windows `"` is stripped from the path rather than escaped because NTFS
 * forbids it in paths anyway — anything containing one is already not a real
 * directory, and cmd's quote parsing must never see it.
 */
export function resumeCommand(cwd: string, claudeSessionId: string | undefined, platform: NodeJS.Platform): string {
  const resume = claudeSessionId && isClaudeSessionId(claudeSessionId) ? ` --resume ${claudeSessionId}` : '';
  if (platform === 'win32') {
    return `cd /d "${cwd.replace(/"/g, '')}" && claude${resume}`;
  }
  return `cd ${posixQuote(cwd)} && claude${resume}`;
}

/** claude's argv when the terminal app takes tokens rather than a shell line. */
export function claudeArgv(claudeSessionId: string | undefined): string[] {
  return claudeSessionId && isClaudeSessionId(claudeSessionId)
    ? ['claude', '--resume', claudeSessionId]
    : ['claude'];
}

// ---- which terminal -------------------------------------------------------

export type TerminalApp = 'iTerm' | 'Terminal' | 'Windows Terminal' | 'cmd';

export interface TerminalProbe {
  readonly exists: (path: string) => boolean;
  /** Resolves a program on PATH, or null. Only consulted on Windows. */
  readonly which: (name: string) => string | null;
}

function defaultWhich(name: string): string | null {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8' });
    return out.split(/\r?\n/).find((l) => l.trim())?.trim() || null;
  } catch {
    return null;
  }
}

export const DEFAULT_PROBE: TerminalProbe = { exists: existsSync, which: defaultWhich };

/**
 * The terminal this machine can actually open, checked rather than assumed:
 * iTerm when it is installed (people who have it live in it, and a stray
 * Terminal window on an iTerm machine reads as a malfunction), Terminal
 * otherwise — it ships with macOS, so on darwin there is always an answer.
 * On Windows, Windows Terminal when present, else the always-present cmd.
 * Anything else (a headless Linux box, say) has no answer and returns null.
 */
export function detectTerminal(platform: NodeJS.Platform, probe: TerminalProbe = DEFAULT_PROBE): TerminalApp | null {
  if (platform === 'darwin') {
    const iterm = probe.exists('/Applications/iTerm.app')
      || probe.exists(join(homedir(), 'Applications', 'iTerm.app'));
    return iterm ? 'iTerm' : 'Terminal';
  }
  if (platform === 'win32') {
    return probe.which('wt.exe') ? 'Windows Terminal' : 'cmd';
  }
  return null;
}

// ---- how to launch it -----------------------------------------------------
//
// Every launch is execFile with a fixed argv — no shell between us and the
// terminal app. The shell line rides *inside* that argv as data: AppleScript
// receives it through `on run argv` (never spliced into the script source),
// and the Windows plans pass claude's tokens individually, with the project
// directory carried as `-d`/spawn-cwd rather than quoted into anything.

const TERMINAL_SCRIPT = [
  'on run argv',
  '  tell application "Terminal"',
  '    activate',
  '    do script (item 1 of argv)',
  '  end tell',
  'end run',
].join('\n');

const ITERM_SCRIPT = [
  'on run argv',
  '  tell application "iTerm"',
  '    activate',
  '    set newWindow to (create window with default profile)',
  '    tell current session of newWindow to write text (item 1 of argv)',
  '  end tell',
  'end run',
].join('\n');

export interface LaunchPlan {
  readonly file: string;
  readonly args: readonly string[];
  /** Set instead of putting the path in args, where the launcher allows it. */
  readonly cwd?: string;
}

export function launchPlan(
  terminal: TerminalApp,
  cwd: string,
  claudeSessionId: string | undefined,
): LaunchPlan {
  switch (terminal) {
    case 'iTerm':
      return { file: 'osascript', args: ['-e', ITERM_SCRIPT, resumeCommand(cwd, claudeSessionId, 'darwin')] };
    case 'Terminal':
      return { file: 'osascript', args: ['-e', TERMINAL_SCRIPT, resumeCommand(cwd, claudeSessionId, 'darwin')] };
    case 'Windows Terminal':
      return { file: 'wt.exe', args: ['-d', cwd, 'cmd', '/k', ...claudeArgv(claudeSessionId)] };
    case 'cmd':
      // `start` needs a window title before a quoted path can follow; the
      // project directory travels as spawn cwd so it is never parsed by cmd.
      return { file: 'cmd.exe', args: ['/c', 'start', 'Claude Code', 'cmd', '/k', ...claudeArgv(claudeSessionId)], cwd };
  }
}

/** Long enough for a cold app launch; short enough that the phone's request survives. */
const LAUNCH_TIMEOUT_MS = 8000;

export type Exec = (file: string, args: readonly string[], options: { cwd?: string; timeout: number }) => Promise<void>;

const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args as string[], { cwd: options.cwd, timeout: options.timeout, windowsHide: false },
      (err) => (err ? reject(err) : resolve()));
  });

// ---- the route handler ----------------------------------------------------

export interface HandoffDeps {
  readonly getSnapshot: typeof getSnapshot;
  readonly stopSession: typeof stopSession;
  readonly readClaudeSessionId: (tetherSessionId: string) => string | undefined;
  readonly detect: () => TerminalApp | null;
  readonly exec: Exec;
  readonly platform: NodeJS.Platform;
}

const DEFAULT_DEPS: HandoffDeps = {
  getSnapshot,
  stopSession,
  readClaudeSessionId,
  detect: () => detectTerminal(process.platform),
  exec: defaultExec,
  platform: process.platform,
};

/**
 * POST /agent/sessions/:id/handoff  { stop?: boolean }
 *
 * Outcomes, all of which carry `command` so the app can always show the
 * paste-it-yourself line:
 *  - 404                          — no such session
 *  - 409 { busy, status, command }— running/waiting and the caller did not
 *                                   send stop:true; nothing was touched
 *  - 200 { opened: true, terminal, stopped }
 *  - 200 { opened: false, reason }— no terminal here, or the launch failed;
 *                                   the Tether side was still released, so
 *                                   pasting the command is safe immediately
 */
export function createHandoffHandler(deps: HandoffDeps = DEFAULT_DEPS) {
  return async (req: Request, res: Response): Promise<void> => {
    const snap = deps.getSnapshot(req.params.id);
    if (!snap) { res.status(404).json({ error: 'no such session' }); return; }

    const claudeId = deps.readClaudeSessionId(snap.id);
    const command = resumeCommand(snap.cwd, claudeId, deps.platform);
    const busy = snap.status === 'running' || snap.status === 'waiting';

    if (busy && req.body?.stop !== true) {
      res.status(409).json({ busy: true, status: snap.status, command });
      return;
    }

    // Release the phone's claude child before any terminal exists. At idle
    // this only reaps a process --resume would respawn anyway; mid-task it is
    // the stop the caller just consented to.
    try { deps.stopSession(snap.id); }
    catch (e: unknown) {
      console.error(`[handoff] could not stop session ${snap.id}: ${e instanceof Error ? e.message : String(e)}`);
      res.status(500).json({ error: 'could not release the session on this computer', command });
      return;
    }

    const terminal = deps.detect();
    if (!terminal) {
      res.json({ ok: true, opened: false, command, reason: 'no terminal app on this computer' });
      return;
    }

    const plan = launchPlan(terminal, snap.cwd, claudeId);
    try {
      await deps.exec(plan.file, plan.args, { cwd: plan.cwd, timeout: LAUNCH_TIMEOUT_MS });
      res.json({ ok: true, opened: true, terminal, command, stopped: busy });
    } catch (e: unknown) {
      // Detail stays in the host log; the phone gets the human version plus
      // the command, which works regardless of why the window did not.
      console.error(`[handoff] ${terminal} launch failed: ${e instanceof Error ? e.message : String(e)}`);
      res.json({ ok: true, opened: false, command, reason: `${terminal} did not open` });
    }
  };
}

export const handleHandoff = createHandoffHandler();

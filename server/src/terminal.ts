// Terminal sessions for the app. Prefers node-pty (a real pty — ConPTY on
// Windows, a Unix pty on macOS/Linux — with proper interactivity) when it is
// installed; otherwise falls back to a piped shell, which still runs commands
// and streams output but without full TTY semantics. Either way the app talks
// to it over a WebSocket.

import { spawn as spawnProc, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { homedir } from 'node:os';

import { productEnv } from './env.js';

export interface TermSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  /** Stop/resume the flow of onData, for backpressure on a slow client. Safe to
   *  call repeatedly; a no-op where the underlying source cannot pause. */
  pause(): void;
  resume(): void;
  kill(): void;
  mode: 'pty' | 'pipe';
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const WINDOWS_POWERSHELL = 'powershell.exe';
const WINDOWS_POWERSHELL_ARGS: readonly string[] = ['-NoLogo', '-NoProfile'];

// macOS has shipped zsh as the default login shell since Catalina; /bin/sh is
// the last-resort shell that exists on every POSIX system.
const DARWIN_DEFAULT_SHELL = '/bin/zsh';
const POSIX_LAST_RESORT_SHELL = '/bin/sh';
// A login shell picks up the user's real PATH (path_helper, /etc/zprofile,
// ~/.zprofile) — without it, Homebrew binaries are missing from the terminal.
const POSIX_SHELL_ARGS: readonly string[] = ['-l'];

// A pty with no TERM breaks anything that uses termcap — vim, htop, less.
const PTY_TERM_NAME_POSIX = 'xterm-256color';
const PTY_TERM_NAME_WINDOWS = 'xterm-color';

export interface ShellSpec {
  readonly file: string;
  readonly args: readonly string[];
}

// Loaded lazily so a missing optional dependency never crashes startup.
let ptyModule: any = null;
let ptyChecked = false;

async function loadPty(): Promise<any> {
  if (ptyChecked) return ptyModule;
  ptyChecked = true;
  try {
    ptyModule = await import('node-pty');
  } catch {
    // node-pty is an optionalDependency; absence is expected, not an error.
    ptyModule = null;
  }
  return ptyModule;
}

/** A shell path from the environment is only trusted if it is absolute and real. */
function usableShellPath(candidate: string | undefined): string | null {
  if (!candidate) return null;
  if (!isAbsolute(candidate)) return null;
  if (!existsSync(candidate)) return null;
  return candidate;
}

function posixShellFile(env: NodeJS.ProcessEnv, plat: NodeJS.Platform): string {
  // BELAY_SHELL is the explicit override; $SHELL is the user's login shell.
  const explicit = usableShellPath(productEnv('SHELL', env as Record<string, string | undefined>));
  if (explicit) return explicit;
  const login = usableShellPath(env.SHELL);
  if (login) return login;
  if (plat === 'darwin' && existsSync(DARWIN_DEFAULT_SHELL)) return DARWIN_DEFAULT_SHELL;
  return POSIX_LAST_RESORT_SHELL;
}

/**
 * The shell to spawn on this platform.
 *
 * Windows keeps its original behaviour exactly: PowerShell unless
 * BELAY_SHELL=cmd, in which case ComSpec.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = process.platform,
): ShellSpec {
  if (plat === 'win32') {
    const file = env.ComSpec && productEnv('SHELL', env as Record<string, string | undefined>) === 'cmd' ? env.ComSpec : WINDOWS_POWERSHELL;
    const args = file.toLowerCase().includes('powershell') ? WINDOWS_POWERSHELL_ARGS : [];
    return { file, args };
  }
  return { file: posixShellFile(env, plat), args: POSIX_SHELL_ARGS };
}

/**
 * Environment for the shell. Returns a new object — the caller's env is never
 * mutated. On POSIX we guarantee a sane TERM/locale; Windows is left untouched
 * so ConPTY behaves exactly as it did before.
 */
export function shellEnv(
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (plat === 'win32') return { ...env };
  return {
    ...env,
    TERM: env.TERM || PTY_TERM_NAME_POSIX,
    COLORTERM: env.COLORTERM || 'truecolor',
    LANG: env.LANG || 'en_US.UTF-8',
  };
}

/**
 * The directory a new session starts in: the user's home, else the cwd.
 *
 * Windows keeps its original behaviour byte for byte: `%USERPROFILE%` if set,
 * otherwise the process cwd. That is deliberately *not* `os.homedir()`, which
 * resolves via GetUserProfileDirectoryW / HOMEDRIVE+HOMEPATH with its own
 * precedence and can diverge from an explicitly-overridden USERPROFILE (service
 * and sandbox contexts, or a launcher that sets it on purpose).
 *
 * POSIX uses homedir() and checks the directory actually exists.
 */
export function shellCwd(
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = process.platform,
  home: () => string = homedir,
): string {
  if (plat === 'win32') return env.USERPROFILE || process.cwd();
  try {
    const dir = home();
    if (dir && existsSync(dir)) return dir;
  } catch {
    // homedir() can throw if the user record is unreadable; fall through.
  }
  return process.cwd();
}

interface SpawnContext {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

function createPtySession(pty: any, ctx: SpawnContext): TermSession {
  const term = pty.spawn(ctx.file, [...ctx.args], {
    name: process.platform === 'win32' ? PTY_TERM_NAME_WINDOWS : PTY_TERM_NAME_POSIX,
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: ctx.cwd,
    env: ctx.env as Record<string, string>,
  });
  return {
    mode: 'pty',
    write: (d) => term.write(d),
    resize: (c, r) => {
      try { term.resize(c || DEFAULT_COLS, r || DEFAULT_ROWS); } catch { /* window closed */ }
    },
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(() => cb()),
    pause: () => { try { term.pause(); } catch { /* not supported */ } },
    resume: () => { try { term.resume(); } catch { /* not supported */ } },
    kill: () => { try { term.kill(); } catch { /* already gone */ } },
  };
}

/**
 * Translate the Enter key for a shell reading from a pipe.
 *
 * Terminals send a carriage return for Enter, and a pty's line discipline turns
 * that into a newline before the shell ever sees it. A pipe has no line
 * discipline, so a bare CR is not a line terminator and the shell waits forever
 * for a command it will never consider finished. Since the piped fallback is
 * standing in for a terminal, it does the translation the terminal would.
 */
export function pipeInput(data: string): string {
  return data.replace(/\r\n?/g, '\n');
}

export async function createTerminal(cols: number, rows: number): Promise<TermSession> {
  const pty = await loadPty();
  const { file, args } = resolveShell();
  const ctx: SpawnContext = {
    file,
    args,
    env: shellEnv(),
    cwd: shellCwd(),
    cols: cols || DEFAULT_COLS,
    rows: rows || DEFAULT_ROWS,
  };

  if (pty) {
    try {
      return createPtySession(pty, ctx);
    } catch (error: unknown) {
      // node-pty can be installed but unusable — most often on macOS when its
      // postinstall never ran, leaving prebuilds/*/spawn-helper without the
      // execute bit ("posix_spawnp failed"). Degrade to the piped shell rather
      // than failing the whole terminal session, but say why.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[terminal] node-pty spawn failed (${message}); falling back to a piped shell`);
    }
  }

  // Fallback: pipe a shell. No TTY, but line-oriented interaction works.
  const { env, cwd } = ctx;
  const child: ChildProcess = spawnProc(file, [...args], {
    cwd,
    env,
    windowsHide: true, // no-op on POSIX
  });
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  child.stdout?.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString())));
  child.stderr?.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString())));
  child.on('exit', () => exitCbs.forEach((cb) => cb()));
  // A shell that cannot be spawned at all must surface to the user, not vanish.
  child.on('error', (err) => {
    console.error(`[terminal] failed to spawn ${file}: ${err.message}`);
    const message = `\r\n[belay] could not start shell "${file}": ${err.message}\r\n`;
    dataCbs.forEach((cb) => cb(message));
    exitCbs.forEach((cb) => cb());
  });

  return {
    mode: 'pipe',
    write: (d) => { try { child.stdin?.write(pipeInput(d)); } catch { /* closed */ } },
    resize: () => { /* not supported for piped shells */ },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    pause: () => { try { child.stdout?.pause(); } catch { /* closed */ } },
    resume: () => { try { child.stdout?.resume(); } catch { /* closed */ } },
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

// Terminal sessions for the app. Prefers node-pty (a real ConPTY with proper
// interactivity) when it is installed; otherwise falls back to a piped
// PowerShell process, which still runs commands and streams output but without
// full TTY semantics. Either way the app talks to it over a WebSocket.

import { spawn as spawnProc, ChildProcess } from 'node:child_process';

export interface TermSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
  mode: 'pty' | 'pipe';
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
    ptyModule = null;
  }
  return ptyModule;
}

const SHELL = process.env.ComSpec && process.env.TETHER_SHELL === 'cmd'
  ? process.env.ComSpec
  : 'powershell.exe';

const SHELL_ARGS = SHELL.toLowerCase().includes('powershell')
  ? ['-NoLogo', '-NoProfile']
  : [];

export async function createTerminal(cols: number, rows: number): Promise<TermSession> {
  const pty = await loadPty();

  if (pty) {
    const term = pty.spawn(SHELL, SHELL_ARGS, {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: process.env.USERPROFILE || process.cwd(),
      env: process.env as Record<string, string>,
    });
    return {
      mode: 'pty',
      write: (d) => term.write(d),
      resize: (c, r) => { try { term.resize(c || 80, r || 24); } catch { /* window closed */ } },
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(() => cb()),
      kill: () => { try { term.kill(); } catch { /* already gone */ } },
    };
  }

  // Fallback: pipe a shell. No TTY, but line-oriented interaction works.
  const child: ChildProcess = spawnProc(SHELL, SHELL_ARGS, {
    cwd: process.env.USERPROFILE || process.cwd(),
    env: process.env,
    windowsHide: true,
  });
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: (() => void)[] = [];
  child.stdout?.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString())));
  child.stderr?.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString())));
  child.on('exit', () => exitCbs.forEach((cb) => cb()));

  return {
    mode: 'pipe',
    write: (d) => { try { child.stdin?.write(d); } catch { /* closed */ } },
    resize: () => { /* not supported for piped shells */ },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

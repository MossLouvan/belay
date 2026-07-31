// Owns the compiled native helper subprocess and exposes a promise-based API
// for capture and input. One request per line in, one reply per line out,
// matched by an incrementing id. Serialized through a single process so frames
// and input never interleave on the wire.
//
// The helper is platform-specific but the wire protocol is not: Windows runs
// native/TetherHost.exe (C#), macOS runs native/TetherHostMac (Swift), and both
// speak the identical JSON command set. Everything below this comment is
// platform-agnostic.

import { spawn, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, Interface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(__dirname, '..', 'native');

/** How long a single native call may take before it is abandoned. */
const CALL_TIMEOUT_MS = 8000;

interface HelperTarget {
  /** Absolute path to the compiled helper for this platform. */
  readonly path: string;
  /** Command that produces it, for error messages. */
  readonly buildCommand: string;
  readonly spawnOptions: SpawnOptions;
}

/**
 * Resolves the helper for the current platform, or null when the platform has
 * no native helper at all. Kept as a pure lookup so `available()` and `start()`
 * can never disagree about which binary they mean.
 */
function resolveTarget(platform: NodeJS.Platform): HelperTarget | null {
  switch (platform) {
    case 'win32':
      return {
        path: join(NATIVE_DIR, 'TetherHost.exe'),
        buildCommand: 'npm run build:native',
        // Keeps the helper from flashing a console window on Windows.
        spawnOptions: { windowsHide: true },
      };
    case 'darwin':
      return {
        path: join(NATIVE_DIR, 'TetherHostMac'),
        buildCommand: 'bash native/build-mac.sh',
        spawnOptions: {},
      };
    default:
      return null;
  }
}

const TARGET = resolveTarget(process.platform);

function unsupportedPlatformError(): Error {
  return new Error(
    `Tether's screen capture and input injection are not implemented for platform '${process.platform}'. ` +
      'Supported platforms are Windows (win32) and macOS (darwin). ' +
      'Everything else — terminal, files, system stats — still works.'
  );
}

function notBuiltError(target: HelperTarget): Error {
  return new Error(`native helper not found at ${target.path}. Run: ${target.buildCommand}`);
}

export interface ScreenInfo {
  primary: { X: number; Y: number; W: number; H: number };
  virtual: { X: number; Y: number; W: number; H: number };
  /** macOS only: whether the two TCC grants the helper needs are in place. */
  permissions?: { screenRecording: boolean; accessibility: boolean };
}

export interface Frame {
  data: string; // base64 JPEG
  w: number;
  h: number;
  sw: number;
  sh: number;
  bytes: number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class NativeHost {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready = false;
  private starting: Promise<void> | null = null;

  available(): boolean {
    return TARGET !== null && existsSync(TARGET.path);
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      if (!TARGET) {
        reject(unsupportedPlatformError());
        return;
      }
      if (!existsSync(TARGET.path)) {
        reject(notBuiltError(TARGET));
        return;
      }
      const proc = spawn(TARGET.path, [], TARGET.spawnOptions) as ChildProcessWithoutNullStreams;
      this.proc = proc;
      const rl = createInterface({ input: proc.stdout });
      this.rl = rl;

      const onReady = () => { this.ready = true; resolve(); };

      rl.on('line', (line) => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready && !this.ready) {
          // The macOS helper reports missing Screen Recording / Accessibility
          // grants here. Surfacing them at startup is the difference between a
          // black screen the user can fix and one they cannot explain.
          for (const warning of msg.warnings || []) console.warn('[native]', warning);
          onReady();
          return;
        }
        const id = msg.id;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.error || 'native error'));
      });

      // The helper writes nothing to stderr in normal operation; anything there
      // is a crash trace worth showing rather than discarding.
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.error('[native]', text);
      });

      proc.on('exit', (code) => {
        this.ready = false;
        this.proc = null;
        const err = new Error(`native host exited (code ${code})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.starting = null;
      });
      proc.on('error', reject);
    });
    return this.starting;
  }

  private send<T = any>(cmd: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc || !this.ready) { reject(new Error('native host not running')); return; }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
      // A stuck native call must not wedge the request forever.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('native host timeout'));
        }
      }, CALL_TIMEOUT_MS);
    });
  }

  info(): Promise<ScreenInfo> { return this.send<ScreenInfo>({ cmd: 'info' }); }

  capture(w: number, q: number, virtual: boolean): Promise<Frame> {
    return this.send<Frame>({ cmd: 'capture', w, q, virtual });
  }

  move(x: number, y: number) { return this.send({ cmd: 'move', x, y }); }
  down(button: string, x?: number, y?: number) { return this.send({ cmd: 'down', button, x, y }); }
  up(button: string, x?: number, y?: number) { return this.send({ cmd: 'up', button, x, y }); }
  click(button: string, x?: number, y?: number, double = false) {
    return this.send({ cmd: 'click', button, x, y, double });
  }
  scroll(dy: number, dx: number) { return this.send({ cmd: 'scroll', dy, dx }); }
  key(vk: number, mods: number[] = []) { return this.send({ cmd: 'key', vk, mods }); }
  text(text: string) { return this.send({ cmd: 'text', text }); }

  stop() {
    if (this.proc) { this.proc.kill(); this.proc = null; this.ready = false; }
  }
}

export const native = new NativeHost();

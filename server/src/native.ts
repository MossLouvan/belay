// Owns the compiled native helper subprocess and exposes a promise-based API
// for capture and input. One request per line in, one reply per line out,
// matched by an incrementing id. Serialized through a single process so frames
// and input never interleave on the wire.
//
// The helper is platform-specific but the wire protocol is not: Windows runs
// native/DeskhandlerHost.exe (C#), macOS runs native/DeskhandlerHostMac (Swift), and both
// speak the identical JSON command set. Everything below this comment is
// platform-agnostic.

import { spawn, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, Interface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backoffDelay, isHealthyRun } from './backoff.js';
import type { RawScreen } from './displays.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(__dirname, '..', 'native');

/**
 * How long a single native call may take before it is abandoned.
 *
 * Must exceed the helper's own worst case, or Node gives up on work the helper
 * is still legitimately doing. On macOS a cold capture after a display wake can
 * legitimately take up to 13s (5s waiting for shareable content, 5s starting
 * the stream, 3s for the first frame). Because the helper processes commands
 * strictly in order, abandoning one does not free the queue behind it — so a
 * timeout that is too short makes every subsequent call time out as well,
 * precisely during wake-from-sleep when recovery matters most.
 */
const CALL_TIMEOUT_MS = 15_000;

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
/**
 * The renamed helper is preferred, but a helper compiled before the rename is
 * still accepted: build:native is a manual step, and a rename that quietly
 * turned the Screen tab off until the owner remembered to re-run it would be a
 * regression dressed up as housekeeping. The fallback costs one existsSync.
 */
function helperPath(current: string, legacy: string): string {
  const preferred = join(NATIVE_DIR, current);
  if (existsSync(preferred)) return preferred;
  const old = join(NATIVE_DIR, legacy);
  return existsSync(old) ? old : preferred;
}

function resolveTarget(platform: NodeJS.Platform): HelperTarget | null {
  switch (platform) {
    case 'win32':
      return {
        path: helperPath('DeskhandlerHost.exe', 'TetherHost.exe'),
        buildCommand: 'npm run build:native',
        // Keeps the helper from flashing a console window on Windows.
        spawnOptions: { windowsHide: true },
      };
    case 'darwin':
      return {
        path: helperPath('DeskhandlerHostMac', 'TetherHostMac'),
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
    `Deskhandler's screen capture and input injection are not implemented for platform '${process.platform}'. ` +
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
  /**
   * Every monitor, in the helper's stable index order. `index` is what the
   * client passes back as `screen` so capture and input target the same
   * monitor. Absent from helpers older than the multi-monitor fix.
   *
   * Carries the OS's identity strings for each display but no verdict about
   * them: `/screen/info` runs these through `classifyScreens` before they
   * reach a client.
   */
  screens?: RawScreen[];
  /** macOS only: whether the two TCC grants the helper needs are in place. */
  permissions?: { screenRecording: boolean; accessibility: boolean };
}

/**
 * A frame of one window, plus where that window now is.
 *
 * The rectangle rides along with every frame because it is the only signal a
 * seamless client gets that the user dragged or resized the window on the host.
 * `hidden` replaces the pixels when the window is minimized: there is nothing
 * to print, and a black frame would be drawn faithfully as a black window.
 */
export interface WindowFrame {
  data?: string;
  w?: number;
  h?: number;
  sw?: number;
  sh?: number;
  bytes?: number;
  hidden?: boolean;
  title?: string;
  rect: { X: number; Y: number; W: number; H: number };
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

  /** Consecutive failed starts, reset by a run that lasted long enough. */
  private failures = 0;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /** True once stop() is called, so a deliberate shutdown is not restarted. */
  private stopped = false;

  available(): boolean {
    return TARGET !== null && existsSync(TARGET.path);
  }

  /**
   * Whether capture and input are usable *right now*.
   *
   * Deliberately live rather than a value sampled at boot: the helper can die
   * at any point, and reporting a boot-time constant told the phone that
   * capture worked while every call was failing.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Bring the helper back after an unexpected exit.
   *
   * Without this the first crash was permanent — screen and input stayed dead
   * until someone physically restarted the agent, which for a machine you are
   * trying to reach from your phone means the feature is simply gone.
   */
  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = backoffDelay(this.failures);
    console.warn(`[native] helper is down; restarting in ${delay}ms (attempt ${this.failures})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch((e: unknown) => {
        console.error('[native] restart failed:', e instanceof Error ? e.message : String(e));
        // start() rejecting still leaves the exit handler to schedule the next
        // attempt only if a process was spawned; when it never spawned, retry
        // from here so a temporarily missing binary still recovers.
        if (!this.proc) this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
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
      this.startedAt = Date.now();
      const rl = createInterface({ input: proc.stdout });
      this.rl = rl;

      const onReady = () => { this.ready = true; this.failures = 0; resolve(); };

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

      proc.on('exit', (code, signal) => {
        const uptime = Date.now() - this.startedAt;
        this.ready = false;
        this.proc = null;
        this.starting = null;
        // The readline interface holds a listener on the dead stdout; without
        // closing it every restart cycle leaks one.
        rl.close();
        this.rl = null;

        const how = signal ? `signal ${signal}` : `code ${code}`;
        const err = new Error(`native host exited (${how})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();

        if (this.stopped) return;
        // A run that lasted long enough is evidence the helper works, so an
        // unrelated later crash retries fast instead of inheriting a long delay.
        this.failures = isHealthyRun(uptime) ? 1 : this.failures + 1;
        console.warn(`[native] helper exited (${how}) after ${uptime}ms`);
        this.scheduleRestart();
      });
      proc.on('error', reject);
    });
    return this.starting;
  }

  private send<T = any>(cmd: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc || !this.ready) { reject(new Error('native host not running')); return; }
      const id = this.nextId++;

      // A stuck native call must not wedge the request forever. The handle is
      // cleared on settle — at 12fps an uncleared timer per frame meant ~180
      // live timers at all times, each pinning its closure, and an unref'd-less
      // timer could hold a clean exit open for the full timeout.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('native host timeout'));
      }, CALL_TIMEOUT_MS);
      timer.unref();

      const settle: Pending = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.pending.set(id, settle);

      this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
    });
  }

  info(): Promise<ScreenInfo> { return this.send<ScreenInfo>({ cmd: 'info' }); }

  // `screen` is the monitor index from ScreenInfo.screens. Optional everywhere:
  // undefined keys are dropped by JSON.stringify, so old helpers see the exact
  // same wire messages as before and fall back to the primary monitor.
  capture(w: number, q: number, virtual: boolean, screen?: number): Promise<Frame> {
    return this.send<Frame>({ cmd: 'capture', w, q, virtual, screen });
  }

  /**
   * The rectangle a pointer coordinate is normalized against.
   *
   * A `window` handle outranks a `screen` index in the helper, because a client
   * showing one window normalized against that window and nothing else. Both
   * are optional: with neither, the helper uses its primary monitor exactly as
   * it always has.
   */
  move(x: number, y: number, screen?: number, window?: string) {
    return this.send({ cmd: 'move', x, y, screen, window });
  }
  down(button: string, x?: number, y?: number, screen?: number, window?: string) {
    return this.send({ cmd: 'down', button, x, y, screen, window });
  }
  up(button: string, x?: number, y?: number, screen?: number, window?: string) {
    return this.send({ cmd: 'up', button, x, y, screen, window });
  }
  click(button: string, x?: number, y?: number, double = false, screen?: number, mods?: number[], window?: string) {
    return this.send({ cmd: 'click', button, x, y, double, screen, mods, window });
  }

  // ---- Seamless windows -------------------------------------------------
  //
  // Enumerate, capture and raise individual windows on the host, so a client
  // can show one remote window in a local window of its own rather than a whole
  // desktop. Only the Windows helper implements these today; the macOS helper
  // answers `unknown command`, which surfaces as a plain error the client turns
  // into "this host cannot do seamless windows yet".

  windows(): Promise<{ windows?: unknown }> { return this.send({ cmd: 'windows' }); }

  captureWindow(window: string, w: number, q: number): Promise<WindowFrame> {
    return this.send<WindowFrame>({ cmd: 'capturewindow', window, w, q });
  }

  focusWindow(window: string): Promise<{ focused?: boolean }> {
    return this.send({ cmd: 'focuswindow', window });
  }
  scroll(dy: number, dx: number) { return this.send({ cmd: 'scroll', dy, dx }); }
  key(vk: number, mods: number[] = []) { return this.send({ cmd: 'key', vk, mods }); }
  text(text: string) { return this.send({ cmd: 'text', text }); }

  stop() {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    // Anything in flight will never be answered now, so fail it rather than
    // leaving callers to wait out the full call timeout.
    const err = new Error('native host stopped');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.proc) { this.proc.kill(); this.proc = null; }
    this.ready = false;
  }
}

export const native = new NativeHost();

// Owns the compiled native helper subprocess and exposes a promise-based API
// for capture and input. One request per line in, one reply per line out,
// matched by an incrementing id. Serialized through a single process so frames
// and input never interleave on the wire.
//
// The helper is platform-specific but the wire protocol is not: Windows runs
// native/BelayHost.exe (C#), macOS runs native/BelayHostMac (Swift), and both
// speak the identical JSON command set. Everything below this comment is
// platform-agnostic.

import { spawn, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, Interface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backoffDelay, isHealthyRun } from './backoff.js';
import type { RawScreen } from './displays.js';
import type { ValidSignal } from './webrtc/relay.js';

/** A signaling frame pushed FROM the helper (the callee peer) toward Node, to be
 *  relayed to the phone: the helper's local answer, its ICE candidates, or a
 *  bye. Unlike capture/input this is not request/reply — the helper emits it
 *  asynchronously as ICE gathers, so it rides its own line shape (`type:
 *  'webrtc'`) rather than an id-matched reply. The payload is passed through
 *  UN-validated: the /ws/webrtc bridge runs it through `validateSignal` on the
 *  way out, so the relay validates the helper's output on the same boundary it
 *  validates the phone's — no path skips it. */
export type WebrtcSignalListener = (signal: unknown) => void;

/** An audio frame pushed FROM the helper while system-audio capture is running
 *  (`audiostart`). Like webrtc signaling this is push, not request/reply: the
 *  helper emits one line per 20 ms frame as capture produces it. The payload is
 *  passed through UN-validated; the consumer (audio-routes.ts) runs it through
 *  `validateHelperAudioFrame` on the same boundary the webrtc bridge validates
 *  signaling — no path skips it. */
export type AudioFrameListener = (frame: unknown) => void;

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
        path: helperPath('BelayHost.exe', 'TetherHost.exe'),
        buildCommand: 'npm run build:native',
        // Keeps the helper from flashing a console window on Windows.
        spawnOptions: { windowsHide: true },
      };
    case 'darwin':
      return {
        path: helperPath('BelayHostMac', 'TetherHostMac'),
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
    `Belay's screen capture and input injection are not implemented for platform '${process.platform}'. ` +
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

  /** Subscribers to signaling frames the helper pushes (answer/ICE/bye). Kept
   *  as a set so the /ws/webrtc bridge can attach for the life of a session and
   *  detach cleanly when the socket closes, without leaking a listener per
   *  reconnect. */
  private webrtcListeners = new Set<WebrtcSignalListener>();

  /** Subscribers to audio frames the helper pushes while capture runs. */
  private audioListeners = new Set<AudioFrameListener>();

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
        // A pushed signaling frame (not an id-matched reply): the helper's local
        // answer / ICE candidate / bye, on its way to the phone via the bridge.
        if (msg.type === 'webrtc') {
          this.dispatchWebrtcSignal(msg.signal);
          return;
        }
        // A pushed audio frame (not an id-matched reply): one 20 ms encoded
        // frame of system audio, on its way to the phone via audio-routes.ts.
        if (msg.type === 'audio') {
          this.dispatchAudioFrame(msg);
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
  //
  // `virtualDisplay` (distinct from `virtual`, which unions the whole desktop)
  // asks the helper to capture the active driver-backed display — the one it
  // created via `virtualDisplayCreate`, at the client's exact resolution. It is
  // dropped from the wire when false/undefined, so an old helper never sees it
  // and the shipping capture path is byte-for-byte unchanged.
  capture(w: number, q: number, virtual: boolean, screen?: number, virtualDisplay?: boolean):
    Promise<Frame> {
    return this.send<Frame>({
      cmd: 'capture', w, q, virtual, screen,
      virtualdisplay: virtualDisplay ? true : undefined,
    });
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

  /**
   * How long since the host's own keyboard or mouse was last used, in ms.
   *
   * Feeds the input floor's rule that the person physically at the machine
   * outranks everyone on a phone (input-floor.ts). The OS counters behind this
   * count *injected* input too, so the caller must discount its own injections
   * — `isLocalActivity` does exactly that.
   *
   * Null rather than throwing when the helper is older than this verb or the
   * platform has no counter: a missing probe must degrade to "no local user
   * detected", never to a desktop nobody can drive.
   */
  async idleMs(): Promise<number | null> {
    try {
      const reply = await this.send<{ idleMs?: unknown }>({ cmd: 'idle' });
      const v = reply?.idleMs;
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    } catch {
      return null;
    }
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
  // ---- Virtual display driver (opt-in, behind BELAY_VIRTUAL_DISPLAY) -----
  //
  // Ask the helper to create/destroy a driver-backed display at an exact
  // resolution and refresh, so the host renders what the client can show —
  // no physical panel required. Arguments are validated in
  // virtual-display.ts BEFORE these are called; the helper (and on Windows
  // the driver's IOCTL handler) validates again on its own boundary.
  //
  // A helper without the backend (macOS pre-rebuild, Windows without the
  // BelayVDD driver installed) answers `unknown command` or a structured
  // E_UNAVAILABLE-style error — the route turns either into a clear message,
  // never a hang. See docs/VIRTUAL-DISPLAY.md for backend status.

  virtualDisplayCreate(width: number, height: number, refreshHz: number):
    Promise<{ display?: unknown }> {
    return this.send({ cmd: 'virtualdisplay', action: 'create', w: width, h: height, hz: refreshHz });
  }

  virtualDisplayDestroy(): Promise<{ destroyed?: boolean }> {
    return this.send({ cmd: 'virtualdisplay', action: 'destroy' });
  }

  // `supported` reports whether the backend actually exists on this host (on
  // macOS: the private CGVirtualDisplay API is present) — the signal the phone
  // needs to decide whether to OFFER true-resolution capture at all, separate
  // from whether one is currently `active`.
  virtualDisplayStatus(): Promise<{ active?: boolean; supported?: boolean; display?: unknown }> {
    return this.send({ cmd: 'virtualdisplay', action: 'status' });
  }

  // ---- Clipboard sync ----------------------------------------------------
  //
  // Read and write the host's clipboard, so the phone and the PC can trade
  // text. Arguments are validated in clipboard.ts BEFORE these are called; the
  // helper validates again on its own boundary (stdin is untrusted there). A
  // helper built before the clipboard verb answers `unknown command`, which
  // surfaces as a clean error the route forwards — never a hang.

  clipboardGet(): Promise<{ text?: string; truncated?: boolean }> {
    return this.send({ cmd: 'clipboard', action: 'get' });
  }

  clipboardSet(text: string): Promise<{ set?: boolean }> {
    return this.send({ cmd: 'clipboard', action: 'set', text });
  }

  scroll(dy: number, dx: number) { return this.send({ cmd: 'scroll', dy, dx }); }
  key(vk: number, mods: number[] = []) { return this.send({ cmd: 'key', vk, mods }); }
  text(text: string) { return this.send({ cmd: 'text', text }); }

  // ---- WebRTC signaling (opt-in, behind BELAY_WEBRTC) --------------------
  //
  // The helper owns the real peer connection (the ICE callee) and the hardware
  // encoder; Node only relays SDP/ICE to it. These verbs hand the helper a
  // validated signaling frame from the phone, and the push subscription
  // (onWebrtcSignal) carries the helper's local answer/ICE back.
  //
  // HARDWARE-GATED: the helper's `webrtc` command and its `type:'webrtc'` push
  // are the libdatachannel side, which is NOT compiled yet (see
  // docs/WEBRTC-SLICE.md). Until then a `webrtc` command resolves as the
  // helper's `unknown command` error, exactly like the seamless-window verbs on
  // macOS — so the /ws/webrtc route degrades to a clean error, never a hang.

  /** Hand the helper one validated signaling frame from the phone (offer/ICE/
   *  bye). Request/reply so the caller learns the helper rejected it. */
  webrtcSignal(signal: ValidSignal): Promise<{ ok?: boolean }> {
    return this.send({ cmd: 'webrtc', signal });
  }

  /** Subscribe to signaling frames the helper pushes back (answer/ICE/bye).
   *  Returns an unsubscribe fn so a closing /ws/webrtc socket detaches cleanly
   *  rather than leaking one listener per session. */
  onWebrtcSignal(listener: WebrtcSignalListener): () => void {
    this.webrtcListeners.add(listener);
    return () => { this.webrtcListeners.delete(listener); };
  }

  // ---- System audio capture (opt-in, behind BELAY_WEBRTC) ----------------
  //
  // Driverless loopback on both platforms: ScreenCaptureKit `capturesAudio` on
  // macOS (rides the existing Screen & System Audio Recording grant — no
  // kernel driver, no BlackHole), WASAPI loopback on Windows. The helper owns
  // the capture and pushes `type:'audio'` frames; these verbs only start and
  // stop it. A helper built before the audio verbs answers `unknown command`,
  // which surfaces as a clean error — exactly like the seamless-window verbs
  // on macOS — so the routes degrade rather than hang.

  /** Start system-audio capture on the helper. */
  audioStart(): Promise<{ ok?: boolean; codec?: string; sampleRate?: number; channels?: number }> {
    return this.send({ cmd: 'audiostart' });
  }

  /** Stop system-audio capture. Safe to call when not capturing. */
  audioStop(): Promise<{ ok?: boolean }> {
    return this.send({ cmd: 'audiostop' });
  }

  /** Whether the helper is capturing, and with what parameters. */
  audioStatus(): Promise<{ ok?: boolean; capturing?: boolean; codec?: string }> {
    return this.send({ cmd: 'audiostatus' });
  }

  /** Subscribe to pushed audio frames. Returns an unsubscribe fn so a closing
   *  audio socket detaches cleanly rather than leaking one listener per
   *  session. */
  onAudioFrame(listener: AudioFrameListener): () => void {
    this.audioListeners.add(listener);
    return () => { this.audioListeners.delete(listener); };
  }

  private dispatchAudioFrame(frame: unknown): void {
    for (const listener of this.audioListeners) {
      // One listener throwing must not stop the others or crash the read loop.
      try { listener(frame); } catch (e) {
        console.error('[native] audio listener failed:', e instanceof Error ? e.message : String(e));
      }
    }
  }

  private dispatchWebrtcSignal(signal: unknown): void {
    for (const listener of this.webrtcListeners) {
      // One listener throwing must not stop the others or crash the read loop.
      try { listener(signal); } catch (e) {
        console.error('[native] webrtc listener failed:', e instanceof Error ? e.message : String(e));
      }
    }
  }

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

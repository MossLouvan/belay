// Owns the compiled TetherHost.exe subprocess and exposes a promise-based API
// for capture and input. One request per line in, one reply per line out,
// matched by an incrementing id. Serialized through a single process so frames
// and input never interleave on the wire.

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, Interface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = join(__dirname, '..', 'native', 'TetherHost.exe');

export interface ScreenInfo {
  primary: { X: number; Y: number; W: number; H: number };
  virtual: { X: number; Y: number; W: number; H: number };
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
    return existsSync(EXE);
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      if (!existsSync(EXE)) {
        reject(new Error(`TetherHost.exe not found at ${EXE}. Run: npm run build:native`));
        return;
      }
      const proc = spawn(EXE, [], { windowsHide: true });
      this.proc = proc;
      const rl = createInterface({ input: proc.stdout });
      this.rl = rl;

      const onReady = () => { this.ready = true; resolve(); };

      rl.on('line', (line) => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready && !this.ready) { onReady(); return; }
        const id = msg.id;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.error || 'native error'));
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
      }, 8000);
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

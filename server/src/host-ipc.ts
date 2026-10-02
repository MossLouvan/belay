// The host's one-way (plus one request/reply) channel to Belay.app.
//
// When the host runs as an Electron utilityProcess child of the packaged app,
// `process.parentPort` exists and the app listens on it for the pairing link
// (to draw the QR in a window instead of the terminal) and answers autostart
// questions with the login-item state. Run from a terminal there is no parent
// port and every call here is a no-op, so nothing else in the host has to know
// which way it was started.

import { createRequire } from 'node:module';

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

/** Electron's utilityProcess port, or null outside the app. */
export function parentPort(): ParentPort | null {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
  return port ?? null;
}

/** True when Belay.app is driving this host (BELAY_HOST_APP is set by it). */
export function underHostApp(): boolean {
  return parentPort() !== null && process.env.BELAY_HOST_APP === '1';
}

export function postToApp(message: Record<string, unknown>): void {
  parentPort()?.postMessage(message);
}

let nextRequestId = 1;
const pending = new Map<number, (reply: unknown) => void>();
let listening = false;

/** One round trip to the app; the reply carries the same `id`. */
export function requestFromApp(message: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
  const port = parentPort();
  if (!port) return Promise.reject(new Error('not running under Belay.app'));
  if (!listening) {
    listening = true;
    port.on('message', ({ data }) => {
      const id = (data as { id?: unknown } | null)?.id;
      const resolve = typeof id === 'number' ? pending.get(id) : undefined;
      if (resolve && typeof id === 'number') { pending.delete(id); resolve(data); }
    });
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Belay.app did not answer')); }, timeoutMs);
    pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    port.postMessage({ ...message, id });
  });
}

/**
 * The QR's module matrix for `text`, from the same encoder qrcode-terminal
 * draws with, so the app's QR and the terminal's can never disagree.
 */
export function qrModules(text: string): boolean[][] {
  const require = createRequire(import.meta.url);
  const QRCode = require('qrcode-terminal/vendor/QRCode');
  const level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  const qr = new QRCode(-1, level.L);
  qr.addData(text);
  qr.make();
  const n: number = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => Boolean(qr.isDark(r, c))));
}

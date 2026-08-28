// Speech-to-text on the host with whisper.cpp. The phone records 16 kHz mono
// WAV (so no ffmpeg is needed here) and POSTs the raw bytes; we hand the file
// to whisper-cli and return the text. Everything stays on this machine.
//
// Binaries + model live in server/whisper/ — run `npm run setup:whisper` once
// to download them, or point TETHER_WHISPER_CLI / TETHER_WHISPER_MODEL at an
// existing install.

import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const WHISPER_DIR = join(process.cwd(), 'whisper');
const IS_WIN = process.platform === 'win32';

function findCli(): string | null {
  if (process.env.TETHER_WHISPER_CLI && existsSync(process.env.TETHER_WHISPER_CLI)) {
    return process.env.TETHER_WHISPER_CLI;
  }
  // Newer whisper.cpp releases ship whisper-cli; older ones shipped main.
  for (const name of ['whisper-cli', 'main']) {
    const p = join(WHISPER_DIR, IS_WIN ? name + '.exe' : name);
    if (existsSync(p)) return p;
  }
  return null;
}

function findModel(): string | null {
  if (process.env.TETHER_WHISPER_MODEL && existsSync(process.env.TETHER_WHISPER_MODEL)) {
    return process.env.TETHER_WHISPER_MODEL;
  }
  try {
    const bins = readdirSync(WHISPER_DIR).filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'));
    if (bins.length) return join(WHISPER_DIR, bins[0]);
  } catch { /* dir missing */ }
  return null;
}

export function transcribeStatus(): { ready: boolean; cli: string | null; model: string | null; hint?: string } {
  const cli = findCli();
  const model = findModel();
  const ready = !!(cli && model);
  return {
    ready, cli, model,
    hint: ready ? undefined : 'run `npm run setup:whisper` in the server folder to download whisper.cpp and a model',
  };
}

// whisper is CPU-bound and each run can take a while; letting a client stack
// up dozens of them would flatten the host. One at a time is plenty for voice.
let inFlight = 0;
const MAX_IN_FLIGHT = 2;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // ~5 min of 16 kHz mono PCM

export async function transcribe(wav: Buffer): Promise<string> {
  const { ready, cli, model } = transcribeStatus();
  if (!ready) throw new Error('speech-to-text not set up — run `npm run setup:whisper` on the PC');
  if (wav.length < 1000) throw new Error('audio too short');
  if (wav.length > MAX_AUDIO_BYTES) throw new Error('audio too long');
  if (inFlight >= MAX_IN_FLIGHT) throw new Error('transcription busy — try again in a moment');
  inFlight++;
  try { return await transcribeNow(wav, cli!, model!); }
  finally { inFlight--; }
}

async function transcribeNow(wav: Buffer, cli: string, model: string): Promise<string> {

  const tmp = join(tmpdir(), `tether-${randomBytes(6).toString('hex')}.wav`);
  writeFileSync(tmp, wav);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        cli!,
        ['-m', model!, '-f', tmp, '--no-timestamps', '--no-prints', '-l', process.env.TETHER_WHISPER_LANG || 'en'],
        { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(new Error('whisper failed: ' + err.message));
          else resolve(stdout);
        },
      );
    });
    return text.replace(/\s+/g, ' ').trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* temp file already gone */ }
  }
}

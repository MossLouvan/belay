// On-device smoke test for the Windows helper's WASAPI loopback capture.
//
// The macOS twin of this is scripts/smoke-audio.py. This one is JavaScript, not
// Python, for one boring reason: Node is guaranteed to exist on a machine that
// runs the Belay host, and a Python install is not.
//
// It drives native\BelayHost.exe over its stdio protocol — audiostart, capture
// while a system sound plays, audiostop — then checks what no CI can check:
// that the frames contain NON-ZERO samples, on a contiguous sequence, with the
// 960-sample timestamp step the wire contract requires.
//
// Usage (PowerShell, in the server folder, with the helper already built):
//     npm run build:native:win
//     node scripts\smoke-audio-win.mjs
//
// Reading the output:
//   * a failing `audiostart` prints the helper's real error — that text is the
//     fault (no render endpoint, permission, exclusive-mode holder), not a bug
//     in this script;
//   * `frames: N, nonzero: 0` means loopback works but the mix was silent:
//     play something on the machine's DEFAULT output device and run it again;
//   * `SOUND CAPTURED` is the only result that proves audio on this PC.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(dirname(fileURLToPath(import.meta.url))), 'native', 'BelayHost.exe');
const CAPTURE_SECONDS = 5;
const START_TIMEOUT_MS = 12_000;
const SAMPLES_PER_FRAME = 960;

/** Play a system sound on the default render endpoint, so loopback has something
 *  to hear. Fire-and-forget: a machine with no such wav still runs the test, it
 *  just needs the user to play something themselves. */
function playTestSound() {
  const wav = 'C:\\Windows\\Media\\Alarm01.wav';
  const script = `$p = New-Object Media.SoundPlayer '${wav}'; 1..4 | ForEach-Object { $p.PlaySync() }`;
  const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  child.on('error', () => { /* no PowerShell or no wav — the user can play audio by hand. */ });
  return child;
}

async function main() {
  const helper = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  helper.on('error', (e) => {
    console.error(`FAIL: could not launch ${HELPER}: ${e.message}`);
    console.error('Build it first: npm run build:native:win');
    process.exit(1);
  });

  const frames = [];
  const replies = [];
  let onStartReply = () => {};
  const startReply = new Promise((resolve) => { onStartReply = resolve; });

  createInterface({ input: helper.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.type === 'audio') frames.push(msg);
    else replies.push(msg);
    if (msg?.id === 1) onStartReply(msg);
  });

  helper.stdin.write('{"id":1,"cmd":"audiostart"}\n');
  const started = await Promise.race([
    startReply,
    new Promise((resolve) => setTimeout(() => resolve(null), START_TIMEOUT_MS)),
  ]);
  if (!started) {
    console.error('FAIL: audio capture did not acknowledge startup', replies);
    helper.kill();
    process.exit(1);
  }
  if (started.ok !== true || started.capturing !== true) {
    console.error('FAIL: audio capture could not start ->', JSON.stringify(started));
    console.error('That error text IS the fault. See docs/AUDIO.md §2a for what each one means.');
    helper.kill();
    process.exit(1);
  }
  console.log('start reply:', JSON.stringify(started));

  // Only play once loopback is listening — starting the sound during
  // initialisation is what produced false "silent capture" results on macOS.
  const sound = playTestSound();
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));
  helper.stdin.write('{"id":2,"cmd":"audiostop"}\n');
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { sound.kill(); } catch { /* already gone */ }
  helper.stdin.end();
  helper.kill();

  console.log('audio frames:', frames.length);
  if (frames.length === 0) {
    console.error('FAIL: no audio frames at all — the capture thread produced nothing.');
    console.error('Ask the helper why: send {"id":3,"cmd":"audiostatus"} and read "stopReason".');
    process.exit(1);
  }

  const first = frames[0];
  const payload = Buffer.from(first.data, 'base64');
  console.log(`first: seq ${first.seq} ts ${first.ts} codec ${first.codec} sr ${first.sr} ch ${first.ch} payload_bytes ${payload.length}`);

  const seqs = frames.map((f) => f.seq);
  const contiguous = seqs.every((s, i) => i === 0 || s === (seqs[i - 1] + 1) % 65536);
  console.log('contiguous seqs:', contiguous);

  const stamps = frames.map((f) => f.ts);
  const stepped = stamps.every((t, i) => i === 0 || (t - stamps[i - 1] + 2 ** 32) % 2 ** 32 === SAMPLES_PER_FRAME);
  console.log(`ts step ${SAMPLES_PER_FRAME} everywhere:`, stepped);

  const nonzero = frames.filter((f) => Buffer.from(f.data, 'base64').some((b) => b !== 0)).length;
  console.log(`frames with nonzero samples: ${nonzero} of ${frames.length}`);

  const passed = nonzero > 0 && contiguous && stepped;
  console.log('VERDICT:', passed
    ? 'SOUND CAPTURED'
    : 'FAIL — capture must contain nonzero audio with valid sequence and timestamps');
  if (!passed && nonzero === 0) {
    console.log('(Silence with a valid cadence means loopback is healthy but the default');
    console.log(' output device was quiet. Play music on it and run this again.)');
  }
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

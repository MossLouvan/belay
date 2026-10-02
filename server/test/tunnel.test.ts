// tunnel.ts: the sidecar line protocol, and the supervisor against a fake
// belay-net written in a few lines of node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSidecarLine, startTunnel } from '../src/tunnel.js';

const NODE = 'ab'.repeat(32);

test('parseSidecarLine accepts only the two protocol lines', () => {
  assert.deepEqual(parseSidecarLine(`ready ${NODE}`), { type: 'ready', nodeId: NODE });
  assert.deepEqual(parseSidecarLine('sig abc-_XYZ'), { type: 'sig', sig: 'abc-_XYZ' });
  assert.equal(parseSidecarLine('ready not-hex'), null);
  assert.equal(parseSidecarLine('sig with=padding'), null);
  assert.equal(parseSidecarLine('[belay-net] allow-list: 2'), null);
  assert.equal(parseSidecarLine(''), null);
});

// A stand-in sidecar: answers `ready`, echoes `sign` as a signature, records
// `allow` lines to a file so the test can see what reached it.
function fakeSidecar(dir: string): string {
  const script = join(dir, 'fake-net.mjs');
  writeFileSync(script, `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    process.stdout.write('ready ${NODE}\\n');
    createInterface({ input: process.stdin }).on('line', (l) => {
      appendFileSync(process.env.FAKE_LOG, l + '\\n');
      if (l.startsWith('sign ')) process.stdout.write('sig SIG_' + l.slice(5).replace(/[^A-Za-z0-9]/g, '_') + '\\n');
      if (l === 'allow die') process.exit(3);
    });
    process.stdin.on('end', () => process.exit(0));
  `);
  const wrapper = join(dir, 'belay-net');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

const until = async (ok: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!ok()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('the supervisor reports the node id, signs, forwards the allow-list and re-sends it after a restart', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'belay-tunnel-sup-'));
  const log = join(dir, 'log');
  process.env.FAKE_LOG = log;
  const t = startTunnel({ targetPort: 1, binary: fakeSidecar(dir), relayUrls: ['https://r.example'] });
  try {
    assert.equal(await t.nodeId, NODE);
    assert.equal(await t.sign(`belay-claim:v1:${NODE}:1`), `SIG_belay_claim_v1_${NODE}_1`);
    t.setAllowList(['n1', 'n2']);
    const { readFileSync } = await import('node:fs');
    await until(() => readFileSync(log, 'utf8').includes('allow n1 n2'));
    // Kill it: the restart must carry the allow-list over.
    t.setAllowList(['die']);
    await until(() => (readFileSync(log, 'utf8').match(/^allow die$/gm) ?? []).length === 2, 8000);
    await assert.rejects(t.sign('a\nb'), /one line/);
  } finally {
    t.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

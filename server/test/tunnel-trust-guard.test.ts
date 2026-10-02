// Guard: no trust decision in the host may reach past the public socket API.
//
// tunnel-listener.ts tags each tunneled socket's remoteAddress itself. The
// tempting shortcuts — `tlsSocket._parent` to find the raw socket, or
// `remotePort` to tell listeners apart — are private or spoofable, and a
// future "small fix" using either would silently re-open the loopback door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('server/src never reads socket._parent or remotePort', () => {
  const offenders = readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /\b_parent\b|\bremotePort\b/.test(readFileSync(join(SRC, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

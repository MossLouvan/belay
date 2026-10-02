// Unit tests for the claim QR the host shows when it starts unlinked.
//
//   cd app && node --test src/account/claim-link.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClaimLink } from './claim-link.ts';

const NODE = 'a'.repeat(64);
const LINK = `belay://claim?c=ABCD2345&n=${NODE}`;

test('a well-formed claim link parses', () => {
  assert.deepEqual(parseClaimLink(LINK), { code: 'ABCD2345', nodeId: NODE });
});

test('the code is upper-cased and spacing tolerated, so a typed code works too', () => {
  assert.equal(parseClaimLink(`belay://claim?c=abcd+2345&n=${NODE}`)?.code, 'ABCD2345');
  assert.ok(parseClaimLink(`  ${LINK}\n`));
});

test('the compat scheme and the path form both parse', () => {
  assert.ok(parseClaimLink(LINK.replace(/^belay:/, 'tether:')));
  assert.ok(parseClaimLink(`belay:///claim?c=ABCD2345&n=${NODE}`));
});

test('a pairing link is not a claim link', () => {
  assert.equal(parseClaimLink('belay://pair?v=1&id=x&c=472234&a=http%3A%2F%2F1.2.3.4'), null);
});

test('unrelated QR codes return null instead of throwing', () => {
  for (const raw of ['', 'hello', 'https://example.com', 'WIFI:S:x;;', '{"a":1}', 'belay://claim']) {
    assert.equal(parseClaimLink(raw), null, `${raw} must not parse`);
  }
});

test('a malformed code or node id is refused', () => {
  assert.equal(parseClaimLink(`belay://claim?c=ABC&n=${NODE}`), null, 'short code');
  assert.equal(parseClaimLink(`belay://claim?c=ABCD2341&n=${NODE}`), null, 'not base32 (1)');
  assert.equal(parseClaimLink('belay://claim?c=ABCD2345&n='), null, 'no node');
  assert.equal(parseClaimLink('belay://claim?c=ABCD2345&n=not%20a%20node%20id'), null, 'node with spaces');
  assert.equal(parseClaimLink(`belay://claim?c=ABCD2345&n=${NODE.toUpperCase()}`), null, 'hex must be lowercase');
  assert.equal(parseClaimLink(`belay://claim?c=ABCD2345&n=${'a'.repeat(63)}`), null, 'exactly 64 hex');
});

// The type-the-code fallback: the host prints the code beside the QR.
test('a typed claim code is normalised, or null when it cannot be one', async () => {
  const { parseClaimCode } = await import('./claim-link.ts');
  assert.equal(parseClaimCode(' ylk7-wpvm '), 'YLK7WPVM');
  assert.equal(parseClaimCode('YLK7 WPVM'), 'YLK7WPVM');
  assert.equal(parseClaimCode('YLK7WPV'), null);
  assert.equal(parseClaimCode('YLK7WPV1'), null);
  assert.equal(parseClaimCode(''), null);
});

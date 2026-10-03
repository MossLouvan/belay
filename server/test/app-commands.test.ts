import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppCommands, type OwnerAuth } from '../src/app-commands.js';

const ID = 'a'.repeat(32);

function harness(answer: OwnerAuth | (() => Promise<OwnerAuth>)) {
  const calls: unknown[][] = [];
  const asked: string[] = [];
  const replies: Record<string, unknown>[] = [];
  const handle = createAppCommands({
    authOwner: (reason) => { asked.push(reason); return typeof answer === 'function' ? answer() : Promise.resolve(answer); },
    decide: (...a) => { calls.push(['decide', ...a]); },
    openFirstPhone: () => { calls.push(['openFirstPhone']); },
    showCode: () => { calls.push(['showCode']); },
    removePhone: (p) => { calls.push(['removePhone', p]); },
    link: (s) => { calls.push(['link', s]); },
    reply: (r) => { replies.push(r); },
  });
  return { handle, calls, asked, replies };
}

test('Allow, "Let a phone connect" and "Pair another phone" do nothing without the owner', async () => {
  for (const message of [
    { type: 'pair-decide', pendingId: ID, allow: true },
    { type: 'open-first-phone' },
    { type: 'pair-code' },
  ]) {
    const h = harness({ ok: false, error: 'Canceled by user.' });
    await h.handle(message);
    assert.deepEqual(h.calls, [], `${message.type} ran without owner auth`);
    assert.equal(h.asked.length, 1);
    assert.deepEqual(h.replies, [{ type: 'owner-auth', action: message.type, ok: false, error: 'Canceled by user.' }]);
  }
});

test('a check that throws refuses too', async () => {
  const h = harness(() => Promise.reject(new Error('native host not running')));
  await h.handle({ type: 'pair-decide', pendingId: ID, allow: true });
  assert.deepEqual(h.calls, []);
  assert.equal(h.replies[0].ok, false);
});

test('an answer that is not exactly ok:true refuses', async () => {
  const h = harness({ ok: 'yes' } as unknown as OwnerAuth);
  await h.handle({ type: 'open-first-phone' });
  assert.deepEqual(h.calls, []);
});

test('with the owner verified, the gated actions run', async () => {
  const h = harness({ ok: true });
  await h.handle({ type: 'pair-decide', pendingId: ID, allow: true });
  await h.handle({ type: 'open-first-phone' });
  await h.handle({ type: 'pair-code' });
  assert.deepEqual(h.calls, [['decide', ID, true], ['openFirstPhone'], ['showCode']]);
  assert.ok(h.replies.every((r) => r.ok === true));
});

test('Deny, Remove and sign-in never ask', async () => {
  const h = harness({ ok: false });
  await h.handle({ type: 'pair-decide', pendingId: ID, allow: false });
  await h.handle({ type: 'device-remove', tokenPrefix: 'abcd' });
  await h.handle({ type: 'link-session', session: 's' });
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.calls, [['decide', ID, false], ['removePhone', 'abcd'], ['link', 's']]);
});

test('one prompt at a time: a second gated command while asking is refused', async () => {
  let release!: (a: OwnerAuth) => void;
  const h = harness(() => new Promise<OwnerAuth>((r) => { release = r; }));
  const first = h.handle({ type: 'pair-code' });
  await h.handle({ type: 'open-first-phone' });
  release({ ok: true });
  await first;
  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.calls, [['showCode']]);
  assert.equal(h.replies.find((r) => r.action === 'open-first-phone')?.ok, false);
});

test('malformed commands are ignored', async () => {
  const h = harness({ ok: true });
  await h.handle({ type: 'pair-decide', pendingId: 5, allow: true });
  await h.handle({ type: 'pair-decide', pendingId: ID, allow: 'yes' });
  await h.handle({ type: 'device-remove', tokenPrefix: 7 });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.asked, []);
});

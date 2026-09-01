// Unit tests for the push-notification webhook: config parsing, what a
// notification says (and refuses to say), and the promise that no webhook
// failure can travel back into a session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  loadNotifyConfig, eventClassOf, buildMessage, buildRequest, deliver, notify,
  notifyBannerLine, resetNotifyLogState,
} from '../src/notify.js';
import type { NotifyConfig, NotifyEvent } from '../src/notify.js';

const approvalEvent: NotifyEvent = {
  kind: 'approval',
  host: 'MacBook Air',
  hostId: 'host-1234',
  session: { id: 'abc123', title: 'deskhandler' },
  tool: 'Bash',
  detail: 'curl -H "Authorization: Bearer sk-SECRET" https://api.example.com',
  expiresAt: Date.now() + 30 * 60 * 1000,
};

function cfgWith(url: string, extra: Partial<NotifyConfig> = {}): NotifyConfig {
  return { ...loadNotifyConfig({ DESKHANDLER_NOTIFY_URL: url }), ...extra };
}

// ---- config parsing --------------------------------------------------------

test('no URL means notifications are off, silently', () => {
  const cfg = loadNotifyConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.disabledReason, undefined);
});

test('a malformed or non-http URL disables with a visible reason', () => {
  // A typo must degrade into a banner line, never into a webhook that
  // silently fires nowhere — that would recreate the silent-phone bug.
  for (const bad of ['not a url', 'ftp://ntfy.sh/topic', 'file:///etc/passwd']) {
    const cfg = loadNotifyConfig({ DESKHANDLER_NOTIFY_URL: bad });
    assert.equal(cfg.enabled, false, bad);
    assert.ok(cfg.disabledReason, bad);
  }
});

test('defaults: ntfy format, approval+error events, detail hidden', () => {
  const cfg = loadNotifyConfig({ DESKHANDLER_NOTIFY_URL: 'https://ntfy.sh/my-topic' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.format, 'ntfy');
  assert.equal(cfg.includeDetail, false);
  assert.deepEqual([...cfg.events].sort(), ['approval', 'error']);
});

test('the legacy TETHER_NOTIFY_* names still configure notifications', () => {
  // A webhook configured before the rename must keep pinging the phone —
  // notifications failing quietly is the exact bug this module exists to fix.
  const cfg = loadNotifyConfig({
    TETHER_NOTIFY_URL: 'https://ntfy.sh/my-topic',
    TETHER_NOTIFY_FORMAT: 'json',
    TETHER_NOTIFY_TOKEN: 'tk_old',
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.format, 'json');
  assert.equal(cfg.token, 'tk_old');
});

test('the canonical name wins over the legacy one', () => {
  const cfg = loadNotifyConfig({
    DESKHANDLER_NOTIFY_URL: 'https://ntfy.sh/new-topic',
    TETHER_NOTIFY_URL: 'https://ntfy.sh/old-topic',
  });
  assert.match(cfg.url, /new-topic/);
});

test('events, format, detail and token are all read from the env', () => {
  const cfg = loadNotifyConfig({
    DESKHANDLER_NOTIFY_URL: 'https://hooks.example.com/x',
    DESKHANDLER_NOTIFY_FORMAT: 'json',
    DESKHANDLER_NOTIFY_EVENTS: 'approval, done ,error',
    DESKHANDLER_NOTIFY_DETAIL: 'on',
    DESKHANDLER_NOTIFY_TOKEN: ' tk_abc ',
  });
  assert.equal(cfg.format, 'json');
  assert.deepEqual([...cfg.events].sort(), ['approval', 'done', 'error']);
  assert.equal(cfg.includeDetail, true);
  assert.equal(cfg.token, 'tk_abc');
});

test('an unknown format or event name disables with a reason, not a guess', () => {
  const badFmt = loadNotifyConfig({ DESKHANDLER_NOTIFY_URL: 'https://x.example', DESKHANDLER_NOTIFY_FORMAT: 'xml' });
  assert.equal(badFmt.enabled, false);
  assert.match(badFmt.disabledReason || '', /FORMAT/);

  // "approvals" quietly meaning "nothing at all" is the failure mode this
  // guards against.
  const badEv = loadNotifyConfig({ DESKHANDLER_NOTIFY_URL: 'https://x.example', DESKHANDLER_NOTIFY_EVENTS: 'approvals' });
  assert.equal(badEv.enabled, false);
  assert.match(badEv.disabledReason || '', /approvals/);
});

test('expired asks are gated by the approval event class', () => {
  assert.equal(eventClassOf('expired'), 'approval');
  assert.equal(eventClassOf('approval'), 'approval');
  assert.equal(eventClassOf('done'), 'done');
  assert.equal(eventClassOf('error'), 'error');
});

// ---- message construction --------------------------------------------------

test('an approval message carries computer, session, tool and time left', () => {
  const now = Date.now();
  const msg = buildMessage({ ...approvalEvent, expiresAt: now + 30 * 60 * 1000 }, false, now);
  assert.match(msg.title, /MacBook Air/);
  assert.match(msg.body, /"deskhandler"/);
  assert.match(msg.body, /Bash/);
  assert.match(msg.body, /30 min to answer/);
  assert.equal(msg.priority, 'high');
  assert.equal(msg.link, 'deskhandler://agent?host=host-1234&session=abc123');
});

test('detail is redacted by default — the secret never enters the message', () => {
  const msg = buildMessage(approvalEvent, false);
  assert.ok(!msg.body.includes('sk-SECRET'));
  assert.ok(!msg.body.includes('curl'));
  assert.ok(!msg.title.includes('sk-SECRET'));
});

test('opted-in detail appears, capped', () => {
  const withDetail = buildMessage(approvalEvent, true);
  assert.ok(withDetail.body.includes('curl -H'));

  const long = buildMessage({ ...approvalEvent, detail: 'x'.repeat(500) }, true);
  assert.ok(long.body.length < 400);
  assert.ok(long.body.includes('…'));
});

test('a forever ask says it waits, instead of inventing a deadline', () => {
  const msg = buildMessage({ ...approvalEvent, expiresAt: undefined }, false);
  assert.match(msg.body, /waits until you answer/);
});

test('expired, done and error messages each say what happened next', () => {
  const expired = buildMessage({ ...approvalEvent, kind: 'expired', waitedMin: 30 }, false);
  assert.match(expired.body, /nobody answered/);
  assert.match(expired.body, /30 min/);
  assert.match(expired.body, /Send a prompt/);

  const done = buildMessage({
    kind: 'done', host: 'PC', hostId: 'h', session: { id: 's', title: 'corrosion' },
    ok: true, costUsd: 0.08, durationMs: 12_000,
  }, false);
  assert.match(done.body, /12s/);
  assert.match(done.body, /\$0\.08/);
  assert.equal(done.priority, 'default');

  const failed = buildMessage({
    kind: 'done', host: 'PC', hostId: 'h', session: { id: 's', title: 'corrosion' }, ok: false,
  }, false);
  assert.match(failed.title, /failed/);
  assert.equal(failed.priority, 'high');

  const err = buildMessage({
    kind: 'error', host: 'PC', hostId: 'h', session: { id: 's', title: 'corrosion' },
    text: 'the Claude process exited (1)',
  }, false);
  assert.match(err.body, /exited \(1\)/);
});

// ---- request construction --------------------------------------------------

test('buildRequest returns null when disabled or when the event class is off', () => {
  assert.equal(buildRequest(loadNotifyConfig({}), approvalEvent), null);
  // done is not in the default event set
  const cfg = cfgWith('https://ntfy.sh/t');
  assert.equal(buildRequest(cfg, { ...approvalEvent, kind: 'done' }), null);
  assert.notEqual(buildRequest(cfg, approvalEvent), null);
  assert.notEqual(buildRequest(cfg, { ...approvalEvent, kind: 'expired' }), null);
});

test('the ntfy request puts the text in headers ntfy reads', () => {
  const req = buildRequest(cfgWith('https://ntfy.sh/t', { token: 'tk_1' }), approvalEvent)!;
  assert.equal(req.url, 'https://ntfy.sh/t');
  assert.match(req.headers.Title, /MacBook Air/);
  assert.equal(req.headers.Priority, 'high');
  assert.equal(req.headers.Click, 'deskhandler://agent?host=host-1234&session=abc123');
  assert.equal(req.headers.Authorization, 'Bearer tk_1');
  assert.match(req.body, /Bash/);
  assert.ok(!req.body.includes('sk-SECRET'));
});

test('no token means no Authorization header at all', () => {
  const req = buildRequest(cfgWith('https://ntfy.sh/t'), approvalEvent)!;
  assert.equal(req.headers.Authorization, undefined);
});

test('a non-ASCII host label survives as a header, ugly but legal', () => {
  // Header values must be latin-1; the body keeps the real UTF-8 text.
  const req = buildRequest(cfgWith('https://ntfy.sh/t'), { ...approvalEvent, host: 'Möss’s Mac 🖥' })!;
  assert.ok(/^[\x20-\x7e]*$/.test(req.headers.Title), req.headers.Title);
});

test('the json request is structured, and Slack/Discord-compatible', () => {
  const req = buildRequest(cfgWith('https://hooks.example.com/x', { format: 'json' }), approvalEvent)!;
  assert.equal(req.headers['Content-Type'], 'application/json');
  const body = JSON.parse(req.body);
  assert.equal(body.event, 'approval');
  assert.equal(body.host, 'MacBook Air');
  assert.equal(body.session.id, 'abc123');
  assert.equal(body.tool, 'Bash');
  assert.equal(body.detail, undefined, 'detail must stay out of the payload by default');
  assert.ok(!req.body.includes('sk-SECRET'));
  // Slack incoming webhooks render `text`, Discord webhooks render `content`.
  assert.ok(typeof body.text === 'string' && body.text.includes('MacBook Air'));
  assert.equal(body.content, body.text);
});

test('the json request includes detail only when opted in', () => {
  const req = buildRequest(
    cfgWith('https://hooks.example.com/x', { format: 'json', includeDetail: true }), approvalEvent,
  )!;
  const body = JSON.parse(req.body);
  assert.match(body.detail, /curl/);
});

test('the token never appears in any request body', () => {
  for (const format of ['ntfy', 'json'] as const) {
    const req = buildRequest(cfgWith('https://x.example/t', { format, token: 'tk_SECRET' }), approvalEvent)!;
    assert.ok(!req.body.includes('tk_SECRET'), format);
  }
});

// ---- delivery: failure must be inert ----------------------------------------

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  // deliver() logs its once-only failure line through console.error; the test
  // output should not look like a test failure.
  const orig = console.error;
  console.error = () => {};
  return fn().finally(() => { console.error = orig; });
}

test('an unreachable webhook resolves false and never throws', async () => {
  resetNotifyLogState();
  const req = buildRequest(cfgWith('http://127.0.0.1:1/t'), approvalEvent)!;
  const ok = await quietly(() => deliver(req, 500));
  assert.equal(ok, false);
});

test('a hanging webhook is abandoned at the timeout', async () => {
  resetNotifyLogState();
  const server = createServer(() => { /* never responds */ });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const req = buildRequest(cfgWith(`http://127.0.0.1:${port}/t`), approvalEvent)!;
    const started = Date.now();
    const ok = await quietly(() => deliver(req, 200));
    assert.equal(ok, false);
    assert.ok(Date.now() - started < 5000, 'must give up at the timeout, not hang');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('a rejecting endpoint counts as failure; failures log once, recovery resets', async () => {
  resetNotifyLogState();
  let status = 500;
  const server = createServer((_req, res) => { res.statusCode = status; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const req = buildRequest(cfgWith(`http://127.0.0.1:${port}/t`), approvalEvent)!;
  const logged: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (line: unknown) => { logged.push(String(line)); };
  console.log = () => {};
  try {
    assert.equal(await deliver(req, 2000), false);
    assert.equal(await deliver(req, 2000), false);
    // Ten approvals against a dead webhook should cost one log line, not ten.
    assert.equal(logged.length, 1);
    assert.match(logged[0], /best-effort/);
    assert.ok(!logged[0].includes('/t'), 'the topic path is a capability and stays out of logs');

    status = 200;
    assert.equal(await deliver(req, 2000), true);
    status = 503;
    assert.equal(await deliver(req, 2000), false);
    assert.equal(logged.length, 2, 'a recovery re-arms the once-only failure line');
  } finally {
    console.error = origErr;
    console.log = origLog;
    server.close();
    server.closeAllConnections();
  }
});

test('notify() is synchronous and cannot throw, whatever the config holds', async () => {
  resetNotifyLogState();
  await quietly(async () => {
    // A config no parser would produce — enabled with garbage — still may not
    // reach the caller as an exception: this is the approval path's shield.
    const broken = { ...cfgWith('https://x.example/t'), url: 'http://' } as NotifyConfig;
    assert.equal(notify(approvalEvent, broken), undefined);
    notify(approvalEvent, cfgWith('http://127.0.0.1:1/t'));
    // Let the fire-and-forget promises settle so nothing rejects after the test.
    await new Promise((r) => setTimeout(r, 700));
  });
});

// ---- banner -----------------------------------------------------------------

test('the banner says off, why, or where — and never a credential', () => {
  assert.match(notifyBannerLine(loadNotifyConfig({})), /off — set DESKHANDLER_NOTIFY_URL/);
  assert.match(
    notifyBannerLine(loadNotifyConfig({ DESKHANDLER_NOTIFY_URL: 'nope' })),
    /OFF — .*not a valid URL/,
  );
  const on = notifyBannerLine(loadNotifyConfig({
    DESKHANDLER_NOTIFY_URL: 'https://user:hunter2@ntfy.example.com/topic',
    DESKHANDLER_NOTIFY_TOKEN: 'tk_SECRET',
  }));
  assert.match(on, /ntfy\.example\.com\/topic/);
  assert.match(on, /metadata only/);
  assert.ok(!on.includes('hunter2'));
  assert.ok(!on.includes('tk_SECRET'));
});

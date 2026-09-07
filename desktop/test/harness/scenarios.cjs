// The conditions the display renderer must keep drawing through. Each one
// injects a fault on the mock host and then asks the same question: do frames
// still reach the canvas afterwards, and is the newest one what is drawn?
//
// `ctx` is { win, host, frame, probe, waitFor, sleep } from run.cjs. A scenario
// returns { ok, detail }; `detail` is what a reader sees on failure.


/** Frames drawn must grow by `count` within `timeoutMs`. */
async function keepsDrawing(ctx, count = 15, timeoutMs = 4000) {
  const before = await ctx.probe();
  const { ok, last } = await ctx.waitFor((s) => s.drawn >= before.drawn + count, timeoutMs);
  return { ok, detail: `drawn ${before.drawn} -> ${last.drawn}, received ${last.received}, status "${last.status}"` };
}

/** With the stream paused, the last frame the host sent must be the one on the canvas. */
async function newestDrawn(ctx, timeoutMs = 4000) {
  const newest = ctx.host.state.frameIndex - 1;
  const { ok, last } = await ctx.waitFor((s) => s.frame === newest, timeoutMs);
  return { ok, detail: `newest ${newest}, drawn frame ${last.frame}, drawn ${last.drawn}, received ${last.received}` };
}

/** Sockets the mock is still feeding; one left for dead by `halfOpen` does not count. */
const streamsOpen = (ctx) => ctx.host.streams().filter((s) => s.open && !s.dead).length;

/** Everything a reconnect needs: a new upgrade, then frames on the new socket. */
async function reconnects(ctx, timeoutMs = 20000) {
  const upgradesBefore = ctx.host.log.filter((l) => l.startsWith('UPGRADE')).length;
  const { ok } = await ctx.waitFor(() => ctx.host.log.filter((l) => l.startsWith('UPGRADE')).length > upgradesBefore && streamsOpen(ctx) === 1, timeoutMs);
  if (!ok) return { ok: false, detail: 'no reconnect within ' + timeoutMs + 'ms; streams open: ' + streamsOpen(ctx) };
  return keepsDrawing(ctx);
}

const scenarios = [
  {
    name: 'steady-stream',
    run: (ctx) => keepsDrawing(ctx, 30, 6000),
  },
  {
    name: 'binary-and-config-on-open',
    async run(ctx) {
      const stream = ctx.host.streams()[0];
      const config = ctx.host.state.received.find((m) => m?.type === 'config');
      const upgrade = ctx.host.log.find((l) => l.startsWith('UPGRADE /ws/screen'));
      const ok = Boolean(stream?.binary && config && config.screen === 0 && config.w === 1600 && upgrade?.endsWith('ok'));
      return { ok, detail: JSON.stringify({ binary: stream?.binary, config, upgrade }) };
    },
  },
  {
    name: 'burst-200-newest-wins',
    async run(ctx) {
      ctx.host.inject({ kind: 'stall', ms: 60000 });
      await ctx.sleep(200);
      const before = await ctx.probe();
      ctx.host.inject({ kind: 'burst', count: 200 });
      const result = await newestDrawn(ctx, 6000);
      const after = await ctx.probe();
      ctx.host.inject({ kind: 'resume' });
      const detail = result.detail + `, drew ${after.drawn - before.drawn} of 200`;
      return { ok: result.ok, detail };
    },
  },
  {
    name: 'slow-decode-then-small-frames',
    async run(ctx) {
      ctx.host.inject({ kind: 'stall', ms: 60000 });
      await ctx.sleep(200);
      ctx.host.inject({ kind: 'big' });
      ctx.host.inject({ kind: 'burst', count: 5 });
      const result = await newestDrawn(ctx, 8000);
      await ctx.sleep(500);
      const settled = await ctx.probe();
      ctx.host.inject({ kind: 'resume' });
      const stillNewest = settled.frame === ctx.host.state.frameIndex - 1 && settled.canvas[0] === ctx.frame.w;
      return { ok: result.ok && stillNewest, detail: result.detail + `, settled frame ${settled.frame} canvas ${settled.canvas.join('x')}` };
    },
  },
  {
    name: 'config-echo-ignored',
    async run(ctx) { ctx.host.inject({ kind: 'echo' }); return keepsDrawing(ctx); },
  },
  {
    name: 'error-message-shown-and-survived',
    async run(ctx) {
      ctx.host.inject({ kind: 'error', error: 'capture failed: secure desktop' });
      const shown = await ctx.waitFor((s) => s.statusClass === 'bad' && /secure desktop/.test(s.status), 2000);
      const drawing = await keepsDrawing(ctx);
      return { ok: shown.ok && drawing.ok, detail: `status "${shown.last.status}"; ` + drawing.detail };
    },
  },
  {
    name: 'garbage-frames-skipped',
    async run(ctx) { ctx.host.inject({ kind: 'garbage' }); return keepsDrawing(ctx); },
  },
  {
    name: 'clean-close-reconnects',
    async run(ctx) { ctx.host.inject({ kind: 'close' }); return reconnects(ctx); },
  },
  {
    name: 'abrupt-terminate-reconnects',
    async run(ctx) { ctx.host.inject({ kind: 'terminate' }); return reconnects(ctx); },
  },
  {
    name: 'ticket-refused-falls-back',
    async run(ctx) {
      ctx.host.inject({ kind: 'refuseTickets', count: 1 });
      ctx.host.inject({ kind: 'close' });
      return reconnects(ctx);
    },
  },
  {
    name: 'legacy-json-frames',
    async run(ctx) {
      ctx.host.inject({ kind: 'json', on: true });
      ctx.host.inject({ kind: 'close' });
      const result = await reconnects(ctx);
      ctx.host.inject({ kind: 'stall', ms: 60000 });
      await ctx.sleep(200);
      ctx.host.inject({ kind: 'burst', count: 3 });
      const newest = await newestDrawn(ctx);
      ctx.host.inject({ kind: 'json', on: false });
      ctx.host.inject({ kind: 'resume' });
      return { ok: result.ok && newest.ok, detail: result.detail + '; ' + newest.detail };
    },
  },
  {
    name: 'stall-3s-status-is-honest',
    async run(ctx) {
      ctx.host.inject({ kind: 'stall', ms: 5000 });
      // A status that still says "N fps" seconds into silence is lying.
      const honest = await ctx.waitFor((s) => !/fps/.test(s.status), 4000);
      const resumed = await keepsDrawing(ctx, 15, 6000);
      return { ok: honest.ok && resumed.ok, detail: `status during stall "${honest.last.status}"; ` + resumed.detail };
    },
  },
  {
    name: 'half-open-socket-recovers',
    async run(ctx) {
      const started = Date.now();
      ctx.host.inject({ kind: 'halfOpen' });
      const result = await reconnects(ctx, 25000);
      const stalls = (await ctx.probe()).stalls;
      return { ok: result.ok && stalls >= 1, detail: `recovered after ${Date.now() - started}ms, stalls ${stalls}; ` + result.detail };
    },
  },
  {
    name: 'window-resize',
    async run(ctx) {
      ctx.win.setSize(700, 400);
      await ctx.sleep(100);
      ctx.win.setSize(960, 540);
      return keepsDrawing(ctx);
    },
  },
  {
    name: 'long-run-no-backlog',
    async run(ctx) {
      const sentBefore = ctx.host.state.frameIndex;
      const before = await ctx.probe();
      await ctx.sleep(8000);
      const after = await ctx.probe();
      const sent = ctx.host.state.frameIndex - sentBefore;
      const drawn = after.drawn - before.drawn;
      // Newest-wins may skip frames under load, but it must never fall behind
      // the wire: what is undrawn at the end is at most the latch's one frame.
      const backlog = (after.received - after.drawn) - (before.received - before.drawn);
      const ok = sent >= 100 && drawn >= sent * 0.8 && backlog <= 2;
      return { ok, detail: `host sent ${sent}, drawn ${drawn} in 8s, backlog growth ${backlog}, dropped ${after.dropped}` };
    },
  },
];

module.exports = { scenarios };

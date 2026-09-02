// The rendezvous process: one WebSocket endpoint binding the tested pure logic
// (lease table, mailbox registry, TURN minting, rate limiting) to the network.
//
// This file is deliberately the thinnest layer in the package — parse with
// protocol.ts, dispatch, reply with a constructor frame — because it is the one
// layer the unit suite cannot exercise. Everything with a decision in it lives
// in the tested modules. UNVERIFIED-DEPLOY: this binding has type-checked but
// has not carried real cross-NAT traffic; docs/SCALABILITY.md holds the
// verification runbook.
//
// Statelessness contract: nothing here survives a restart, and nothing needs
// to. Leases re-announce within one TTL; a dropped WS re-attaches to a fresh
// mailbox; TURN credentials are self-verifying. Kill any instance at any time.

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { loadConfig } from './config.js';
import { createLeaseTable } from './lease.js';
import { createMailboxRegistry, type Mailbox, type MailboxSide } from './mailbox.js';
import { createRateLimiter } from './rate-limit.js';
import { mintTurnCredential } from './turn-credentials.js';
import {
  parseClientFrame,
  errorFrame,
  attachedFrame,
  leaseOkFrame,
  presenceFrame,
  signalFrame,
  turnCredentialFrame,
} from './protocol.js';

const configResult = loadConfig();
if (!configResult.ok) {
  process.stderr.write(`[rendezvous] fatal: ${configResult.error}\n`);
  process.exit(1);
}
const config = configResult.config;

const leases = createLeaseTable();
const mailboxes = createMailboxRegistry();
// Per-IP: generous for real clients (a host announces every ~30s), hostile to
// floods. Distinct buckets so a signaling burst can't starve lease renewal.
const announceLimit = createRateLimiter({ capacity: 30, refillPerSec: 1 });
const turnLimit = createRateLimiter({ capacity: 10, refillPerSec: 0.2 });
const frameLimit = createRateLimiter({ capacity: 200, refillPerSec: 50 });

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, leases: leases.size(), mailboxes: mailboxes.size() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 96 * 1024 });

interface ConnectionState {
  mailbox: Mailbox | null;
  side: MailboxSide | null;
}

wss.on('connection', (ws: WebSocket, req) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const state: ConnectionState = { mailbox: null, side: null };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ws.send(errorFrame('binary frames not accepted'));
      return;
    }
    if (!frameLimit.take(ip)) {
      ws.send(errorFrame('rate limited'));
      return;
    }

    const parsed = parseClientFrame(data.toString('utf8'));
    if (!parsed.ok) {
      ws.send(errorFrame(parsed.error));
      return;
    }

    const frame = parsed.frame;
    switch (frame.type) {
      case 'announce': {
        if (!announceLimit.take(ip)) {
          ws.send(errorFrame('rate limited'));
          return;
        }
        const outcome = leases.announce({ ...frame.announce, ttlSec: frame.ttlSec });
        ws.send(outcome.accepted ? leaseOkFrame(frame.ttlSec) : errorFrame(outcome.reason));
        return;
      }
      case 'lookup': {
        ws.send(presenceFrame(leases.lookup(frame.mailboxId) !== null));
        return;
      }
      case 'attach': {
        if (state.mailbox) {
          ws.send(errorFrame('already attached'));
          return;
        }
        const opened = mailboxes.open(frame.mailboxId);
        if (!opened.ok) {
          ws.send(errorFrame(opened.error));
          return;
        }
        const attached = opened.mailbox.attach(frame.side, {
          deliver(message) {
            if (ws.readyState === ws.OPEN) ws.send(signalFrame(message));
          },
        });
        if (!attached.ok) {
          ws.send(errorFrame(attached.error ?? 'attach failed'));
          return;
        }
        state.mailbox = opened.mailbox;
        state.side = frame.side;
        ws.send(attachedFrame(frame.side));
        return;
      }
      case 'signal': {
        if (!state.mailbox || !state.side) {
          ws.send(errorFrame('not attached'));
          return;
        }
        const result = state.mailbox.ingest(state.side, frame.message);
        if (!result.ok) ws.send(errorFrame(result.error));
        return;
      }
      case 'turn': {
        if (!state.mailbox) {
          ws.send(errorFrame('not attached'));
          return;
        }
        if (!turnLimit.take(ip)) {
          ws.send(errorFrame('rate limited'));
          return;
        }
        const minted = mintTurnCredential(
          { accountId: state.mailbox.mailboxId, sessionId: frame.sessionId },
          config.turnSecret,
        );
        if (!minted.ok) {
          ws.send(errorFrame(minted.error));
          return;
        }
        const { username, credential, ttlSec } = minted.value;
        ws.send(turnCredentialFrame(username, credential, ttlSec, config.turnUrls));
        return;
      }
    }
  });

  ws.on('close', () => {
    if (state.mailbox && state.side) state.mailbox.detach(state.side);
  });

  ws.on('error', () => {
    // Socket-level errors surface as 'close'; nothing to report per-frame.
  });
});

// A half-attached mailbox whose peers vanished is reaped on a timer as well as
// lazily, so an idle instance's memory converges to its live sessions.
const reaper = setInterval(() => {
  mailboxes.reap();
  leases.prune();
}, 30_000);
reaper.unref();

httpServer.listen(config.port, () => {
  process.stdout.write(`[rendezvous] listening on :${config.port} (ws path /ws)\n`);
});

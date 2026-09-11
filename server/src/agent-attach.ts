// The attach surface: one WebSocket route the phone and the desk both use, and
// two loopback REST routes that exist only so the CLI at the desk can get in.
//
// The socket contract is deliberately the same one /ws/terminal already speaks,
// message for message, so the phone can point its existing terminal renderer at
// an agent session without a second protocol to maintain:
//
//   host → client   {type:'ready', mode:'pty', cols, rows, attached, session}
//                   {type:'data', data}          pty output (scrollback first)
//                   {type:'resize', cols, rows}  the effective (minimum) size
//                   {type:'exit'}                the session's process ended
//                   {type:'error', error}        could not attach / start
//   client → host   {type:'data', data}          keystrokes
//                   {type:'resize', cols, rows}  this client's window size
//
// The two additions over /ws/terminal are `resize` in the host→client direction
// and `attached` on ready, and both exist for the same reason: with several
// clients on one pty the size is negotiated rather than dictated, so a client
// has to be told what it actually got (see minSize in agent-pty-buffer.ts).

import type { Express, Request, Response } from 'express';
import type { WebSocket } from 'ws';

import { getSnapshot, ptyRegistry } from './agent.js';
import { clampDim, DEFAULT_COLS, DEFAULT_ROWS } from './agent-pty-buffer.js';
import type { TermSize } from './agent-pty-buffer.js';
import type { Attachment } from './agent-pty.js';
import {
  ATTACH_SECRET_HEADER, attachSecretMatches, isLoopback, LOCAL_CONSOLE_TOKEN,
} from './attach-secret.js';
import { messageOf } from './errors.js';

/**
 * Per-client send ceiling. Past this the client is considered saturated and
 * output is dropped for it until it drains — never buffered without bound, and
 * never by pausing the shared pty (agent-pty.ts explains why).
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on one inbound keystroke frame. The shared WebSocketServer already
 * refuses anything past its maxPayload, so this is the second line: a client
 * cannot hand the pty a megabyte of input in a single write no matter how it
 * got here. Well past the largest real paste.
 */
const MAX_INPUT_CHARS = 256 * 1024;

export interface AttachDeps {
  /** Mint a single-use WebSocket ticket for a token. */
  readonly issueTicket: (token: string) => { ticket: string; expiresInSec: number };
  /** The host's attach secret, as minted at boot. */
  readonly secret: string;
}

/**
 * Loopback + file-secret routes. Not behind the device bearer auth on purpose:
 * the CLI runs on this machine as this user and has no pairing token, and
 * proving it can read a 0600 file in the user's home is exactly the claim
 * being made. Everything here is refused outright from any non-loopback
 * address, before the secret is even looked at.
 */
export function registerAttachRoutes(app: Express, deps: AttachDeps): void {
  const guard = (req: Request, res: Response): boolean => {
    if (!isLoopback(req.socket.remoteAddress || '')) {
      res.status(403).json({ error: 'loopback only' });
      return false;
    }
    if (!attachSecretMatches(req.headers[ATTACH_SECRET_HEADER], deps.secret)) {
      res.status(401).json({ error: 'bad or missing attach secret' });
      return false;
    }
    return true;
  };

  // What `npm run attach` with no id prints.
  app.get('/agent/attach/sessions', (req, res) => {
    if (!guard(req, res)) return;
    res.json({
      sessions: ptyRegistry().list().map((s) => ({
        id: s.id, title: s.title, cwd: s.cwd, running: s.running,
        attached: s.attached, lastActivity: s.lastActivity,
        claudeSessionId: s.claudeSessionId ?? null,
      })),
    });
  });

  // The ticket the CLI spends on the upgrade. Bound to the local-console
  // handle, which only /ws/agent-attach accepts.
  app.post('/agent/attach/ticket', (req, res) => {
    if (!guard(req, res)) return;
    res.json(deps.issueTicket(LOCAL_CONSOLE_TOKEN));
  });
}

/**
 * One attached client on a shared session.
 *
 * The socket is registered for close/error before the attach is awaited: the
 * attach may have to spawn a `claude` first, which is tens of milliseconds
 * during which the client can vanish, and a detach that arrives before the
 * handler exists would leave this client attached forever.
 */
export async function handleAgentAttach(ws: WebSocket, url: URL): Promise<void> {
  const id = url.searchParams.get('id') || '';
  const size: TermSize = {
    cols: clampDim(url.searchParams.get('cols'), DEFAULT_COLS),
    rows: clampDim(url.searchParams.get('rows'), DEFAULT_ROWS),
  };

  let closed = false;
  let attachment: Attachment | null = null;
  const markClosed = (): void => {
    closed = true;
    // Detaching never kills the session — that is the entire point of this
    // route. The pty keeps running with whatever other clients are on it, or
    // with none at all.
    attachment?.detach();
  };
  ws.on('close', markClosed);
  ws.on('error', markClosed);

  const send = (msg: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (error: string): void => {
    send({ type: 'error', error });
    try { ws.close(); } catch { /* already gone */ }
  };

  const snap = getSnapshot(id);
  if (!snap) { fail('no such session — run `npm run attach` with no id to list the ones you can join'); return; }
  if (snap.kind !== 'pty') {
    fail('this session is not a live terminal session — it was created before Belay owned the terminal, so it can only be driven from the phone');
    return;
  }
  if (!ptyRegistry().has(id)) { fail('this session cannot be attached on this host'); return; }

  // Output that arrives before `ready` has gone out is held, not sent. The
  // attach replays the scrollback synchronously — that is what makes a late
  // attacher see the current screen — so without this queue the very first
  // frame on the wire would be a screenful of data ahead of the handshake that
  // tells the client how wide it is.
  let readySent = false;
  const early: string[] = [];
  const pushData = (data: string): void => {
    if (!readySent) { early.push(data); return; }
    send({ type: 'data', data });
  };

  try {
    attachment = await ptyRegistry().attach(id, {
      size,
      accepts: () => ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES,
      onData: pushData,
      onSize: (next) => send({ type: 'resize', cols: next.cols, rows: next.rows }),
      onExit: () => { send({ type: 'exit' }); try { ws.close(); } catch { /* gone */ } },
    });
  } catch (e: unknown) {
    fail(messageOf(e));
    return;
  }
  if (!attachment) { fail('no such session — run `npm run attach` with no id to list the ones you can join'); return; }

  // Vanished while the session was starting: give the seat back at once.
  if (closed || ws.readyState !== ws.OPEN) { attachment.detach(); return; }

  send({
    type: 'ready', mode: 'pty',
    cols: attachment.size().cols, rows: attachment.size().rows,
    attached: attachment.attached(),
    session: { id: snap.id, title: snap.title, cwd: snap.cwd },
  });
  readySent = true;
  for (const data of early) send({ type: 'data', data });
  early.length = 0;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Belt to the socket's own maxPayload braces: a frame this large is
      // not a paste, and there is no reason to push it at a pty.
      if (msg.type === 'data' && typeof msg.data === 'string' && msg.data.length <= MAX_INPUT_CHARS) attachment!.write(msg.data);
      else if (msg.type === 'resize') attachment!.resize(msg.cols, msg.rows);
    } catch { /* malformed frames are ignored, as on every other socket */ }
  });
}

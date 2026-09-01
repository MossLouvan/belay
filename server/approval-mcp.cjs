// MCP sidecar that turns Claude Code permission prompts into phone approvals.
//
// Claude Code spawns this as an MCP stdio server (configured per session by
// agent.ts) and calls its single tool, request_permission, whenever it wants
// to use a tool that needs approval. We forward the ask to the Belay host
// over loopback and block until the user answers on their phone. No response
// within the host's timeout window means deny — this fails closed.
//
// Plain Node, no dependencies: MCP stdio is newline-delimited JSON-RPC 2.0.

'use strict';

const http = require('node:http');

// BELAY_* with a TETHER_* fallback, and the fallback here is not merely
// polite: a host process from before the rename can still be running and will
// spawn THIS file (it resolves the sidecar by path, not by version) with the
// old variable names. Dropping them would break approvals for that live host
// the moment this repo updates, without it ever restarting.
const URL_TARGET = process.env.BELAY_APPROVE_URL || process.env.TETHER_APPROVE_URL || '';
const KEY = process.env.BELAY_APPROVE_KEY || process.env.TETHER_APPROVE_KEY || '';
const SESSION = process.env.BELAY_APPROVE_SESSION || process.env.TETHER_APPROVE_SESSION || '';
// The host decides how long an ask may wait (it is configurable there, and may
// be "forever"); it hands us a window slightly longer than its own so the host
// always answers first. The fallback only matters if an old host spawns a new
// sidecar without the variable.
const TIMEOUT_MS = Number(process.env.BELAY_APPROVE_TIMEOUT_MS || process.env.TETHER_APPROVE_TIMEOUT_MS) || 31 * 60 * 1000;

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: (req.params && req.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'belay-approve', version: '1.0.0' },
      },
    });
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: req.id,
      result: {
        tools: [{
          name: 'request_permission',
          description: 'Ask the Belay user on their phone to approve a tool use.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_use_id: { type: 'string' },
            },
            required: ['tool_name', 'input'],
          },
        }],
      },
    });
  } else if (req.method === 'tools/call') {
    const args = (req.params && req.params.arguments) || {};
    askPhone(args.tool_name || 'unknown', args.input || {})
      .then((verdict) => {
        const payload = verdict.allow
          ? { behavior: 'allow', updatedInput: args.input || {} }
          : { behavior: 'deny', message: verdict.message || 'Denied from the Belay app.' };
        send({
          jsonrpc: '2.0', id: req.id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        });
      })
      .catch((e) => {
        send({
          jsonrpc: '2.0', id: req.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'approval bridge error: ' + e.message }) }] },
        });
      });
  } else if (req.id !== undefined) {
    // Politely refuse anything else that expects an answer.
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
}

function askPhone(toolName, input) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ session: SESSION, key: KEY, toolName, input });
    const req = http.request(URL_TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      // The host holds this request open until the user answers; the window
      // came from the host itself, padded past its own approval timeout.
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ allow: false, message: 'bad response from host' }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', reject);
    req.end(body);
  });
}

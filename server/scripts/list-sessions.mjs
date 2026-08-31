// Print every Claude Code session found on this machine, newest first, with a
// ready-to-paste resume command — for walking back up to the PC after time
// away. The same discovery the phone's "On this PC" list uses (compact copy;
// plain node so it runs without the TS toolchain).
//
// Usage: npm run sessions

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), '.claude', 'projects');
const HEAD_BYTES = 64 * 1024;
const CAP = 40;

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } finally { closeSync(fd); }
}

function extractMeta(head) {
  let cwd, preview;
  for (const line of head.split('\n')) {
    if (cwd && preview) break;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof e?.cwd === 'string' && e.cwd) cwd = e.cwd;
    if (!preview && e?.type === 'user') {
      const c = e.message?.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? (c.find((b) => b?.type === 'text' && b.text?.trim())?.text || '') : '';
      if (text.trim()) preview = text.trim().replace(/\s+/g, ' ').slice(0, 100);
    }
  }
  return { cwd, preview };
}

// The cd target, quoted for the shell this line will be pasted into: a project folder with a
// space in its name used to print a cd that split at the space. Mirrors the
// quoting in src/handoff.ts, which builds the same line for the one-tap path.
function cdTarget(p) {
  return process.platform === 'win32'
    ? `/d "${p.replace(/"/g, '')}"`
    : `'${p.replace(/'/g, `'\\''`)}'`;
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const candidates = [];
let dirs = [];
try { dirs = readdirSync(ROOT); } catch { /* no sessions yet */ }
for (const dir of dirs) {
  const full = join(ROOT, dir);
  try {
    if (!statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      candidates.push({ file: join(full, f), id: f.slice(0, -6), mtime: statSync(join(full, f)).mtimeMs });
    }
  } catch { /* unreadable */ }
}
candidates.sort((a, b) => b.mtime - a.mtime);

console.log('');
console.log('  Claude Code sessions on this machine');
console.log('  ────────────────────────────────────');
let shown = 0;
for (const c of candidates) {
  if (shown >= CAP) break;
  let meta;
  try { meta = extractMeta(readHead(c.file)); } catch { continue; }
  if (!meta.cwd || !existsSync(meta.cwd)) continue;
  shown++;
  const name = meta.cwd.split(/[\\/]/).filter(Boolean).pop();
  console.log('');
  console.log(`  ${name}  ·  ${ago(c.mtime)}`);
  if (meta.preview) console.log(`    "${meta.preview}"`);
  console.log(`    cd ${cdTarget(meta.cwd)} && claude --resume ${c.id}`);
}
if (!shown) console.log('\n  none found');
console.log('');

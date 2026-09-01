// Discovery of every Claude Code session on this machine — not just the ones
// Belay started. Claude Code persists one JSONL transcript per session under
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl; we scan those, read
// only the head of each file (transcripts can be tens of MB), and recover the
// real cwd + the first user prompt so sessions are recognizable in a list.
//
// The directory encoding is lossy, so the cwd always comes from the `cwd`
// field inside the JSONL entries, never from the directory name.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DiscoveredSession {
  claudeSessionId: string;
  cwd: string;
  mtime: number;
  preview: string; // first user prompt, trimmed — '' when none was found
}

const HEAD_BYTES = 64 * 1024;
const SCAN_CAP = 100;
const CACHE_MS = 30_000;

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

function readHead(path: string, bytes = HEAD_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

// First text of a user entry; entry shapes vary by Claude Code version, so
// accept both a plain string and an array of content blocks.
function userText(entry: any): string {
  const c = entry?.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    for (const block of c) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text.trim();
      }
    }
  }
  return '';
}

// Pull cwd + preview out of the head of a transcript. Defensive: garbage
// lines are skipped, missing fields stay absent, nothing throws.
export function extractMeta(head: string): { cwd?: string; preview?: string } {
  let cwd: string | undefined;
  let preview: string | undefined;
  for (const line of head.split('\n')) {
    if (cwd && preview) break;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof entry?.cwd === 'string' && entry.cwd) cwd = entry.cwd;
    if (!preview && entry?.type === 'user') {
      const text = userText(entry);
      if (text) preview = text.replace(/\s+/g, ' ').slice(0, 120);
    }
  }
  return { cwd, preview };
}

// One pass over a projects root. Exclusion happens before the cap so attached
// sessions never consume scan slots.
export function scanSessions(root: string, exclude: Set<string>, cap = SCAN_CAP): DiscoveredSession[] {
  const candidates: { file: string; id: string; mtime: number }[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return []; }
  for (const dir of dirs) {
    const full = join(root, dir);
    let files: string[] = [];
    try {
      if (!statSync(full).isDirectory()) continue;
      files = readdirSync(full);
    } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (exclude.has(id)) continue;
      try { candidates.push({ file: join(full, f), id, mtime: statSync(join(full, f)).mtimeMs }); }
      catch { /* unreadable entry */ }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  // Cap the results, not the attempts — a transcript with no recoverable cwd
  // shouldn't eat a slot. Head-reads stay bounded regardless (cap * 3).
  const out: DiscoveredSession[] = [];
  let reads = 0;
  for (const c of candidates) {
    if (out.length >= cap || reads >= cap * 3) break;
    reads++;
    let meta: { cwd?: string; preview?: string };
    try { meta = extractMeta(readHead(c.file)); } catch { continue; }
    // No recoverable cwd, or the project folder is gone — nothing to resume into.
    if (!meta.cwd || !existsSync(meta.cwd)) continue;
    out.push({ claudeSessionId: c.id, cwd: meta.cwd, mtime: c.mtime, preview: meta.preview || '' });
  }
  return out;
}

// Cached wrapper for the real machine. The raw scan is cached; the exclusion
// set is applied per call so a fresh attach disappears immediately.
let cache: { at: number; data: DiscoveredSession[] } | null = null;

export function discoverSessions(exclude: Set<string>): DiscoveredSession[] {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), data: scanSessions(PROJECTS_ROOT, new Set()) };
  }
  return cache.data.filter((s) => !exclude.has(s.claudeSessionId));
}

// History for resumed sessions, recovered from Claude Code's own transcript.
//
// A session attached from the phone used to open amnesiac: the conversation
// existed on disk but the feed showed nothing until new output arrived, so
// "resume" meant trusting a title. Claude Code appends one JSONL transcript
// per session under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl; this reads
// the *tail* of that file — transcripts grow to tens of MB, and orientation
// needs the end of the story, not the start — and turns it into the same feed
// events the live stream produces, via the shared mappers in agent-events.ts.
//
// Everything here is best-effort by design: a missing or unreadable
// transcript yields [], and a corrupt line is skipped rather than sinking the
// lines around it. History is a courtesy; attach must never fail over it.

import { closeSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { eventsFromAssistantContent, eventsFromToolResults } from './agent-events.js';
import type { AgentEvent } from './agent-events.js';

/** How far back the tail read reaches. Enough for dozens of turns, bounded
 * so a giant transcript costs one small read, never a full parse. */
export const TAIL_BYTES = 256 * 1024;
/** Feed events restored on attach — comfortably under the 400-event cap,
 * leaving the live session room before old context starts falling off. */
export const HISTORY_CAP = 100;

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

// Read the last `bytes` of a file. When the read starts mid-file the first
// line is almost certainly a fragment of JSON, so it is dropped — a corrupt
// head would just be skipped by the parser anyway, but dropping it keeps the
// "garbage line" path for genuinely damaged files.
export function readTail(path: string, bytes = TAIL_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    const n = readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8', 0, n);
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : '';
  } finally {
    closeSync(fd);
  }
}

// First text of a user entry. `<command-…>` and other angle-bracket wrappers
// are the CLI talking to itself (slash-command envelopes, local stdout
// echoes), not something the user said — they read as noise on a phone.
function userText(content: unknown): string {
  if (typeof content === 'string') return content.startsWith('<') ? '' : content.trim();
  if (!Array.isArray(content)) return '';
  for (const block of content as any[]) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return block.text.startsWith('<') ? '' : block.text.trim();
    }
  }
  return '';
}

/**
 * Transcript JSONL lines → feed events, oldest first. Only user and
 * assistant entries matter; sidechains (subagent chatter interleaved into
 * the same file) and Claude Code's bookkeeping types are skipped.
 */
export function transcriptEvents(lines: readonly string[], cap = HISTORY_CAP): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain === true) continue;
    const t = Date.parse(entry.timestamp) || Date.now();
    if (entry.type === 'assistant') {
      out.push(...eventsFromAssistantContent(entry.message?.content, t));
    } else if (entry.type === 'user') {
      const results = eventsFromToolResults(entry.message?.content, t);
      if (results.length) out.push(...results);
      else {
        const text = userText(entry.message?.content);
        if (text) out.push({ t, kind: 'user', text });
      }
    }
  }
  return out.slice(-cap);
}

// The directory name under ~/.claude/projects encodes the cwd lossily, so the
// session file is found by scanning every project dir for <uuid>.jsonl rather
// than by reconstructing a path.
export function findTranscript(claudeSessionId: string, root = PROJECTS_ROOT): string | null {
  const name = `${claudeSessionId}.jsonl`;
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    try {
      if (readdirSync(join(root, dir)).includes(name)) return join(root, dir, name);
    } catch { /* not a directory, or unreadable — either way, not here */ }
  }
  return null;
}

/** The tail of a Claude-side transcript as feed events; [] when there is
 * nothing readable to restore. */
export function loadClaudeHistory(claudeSessionId: string, root = PROJECTS_ROOT): AgentEvent[] {
  const path = findTranscript(claudeSessionId, root);
  if (!path) return [];
  try {
    return transcriptEvents(readTail(path).split('\n').filter(Boolean));
  } catch { return []; }
}

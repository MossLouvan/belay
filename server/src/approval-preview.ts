// What the approval card shows instead of raw JSON. The phone was asking
// people to approve a change they could not read — a pretty-printed input
// object is legible to a programmer at a desk, not to a thumb on a train —
// which trains exactly the Allow reflex an approval system exists to
// prevent. So the host ships a structured preview: the before/after of an
// Edit, the full content of a Write plus whether it replaces a file that
// already exists (the dangerous case, checked here because only the host can
// see the disk), or the bare command for Bash. The phone renders these with
// the same diff machinery as the "what changed" screen.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type ApprovalPreview =
  | { kind: 'edit'; path: string; oldText: string; newText: string; capped: boolean; replaceAll: boolean }
  | { kind: 'write'; path: string; content: string; capped: boolean; exists: boolean; existingLines?: number }
  | { kind: 'command'; command: string };

// Per-side ceiling on preview text. Big enough that real edits arrive whole,
// small enough that a generated-file rewrite cannot flood the websocket and
// the phone's memory; `capped` rides along so the card says what it cut.
const TEXT_CAP = 6000;
// Counting lines means reading the file; past this size the count is skipped
// and the card falls back to "replaces an existing file" without a number.
const COUNT_CAP_BYTES = 512 * 1024;

const cap = (s: string): { text: string; capped: boolean } =>
  s.length > TEXT_CAP ? { text: s.slice(0, TEXT_CAP), capped: true } : { text: s, capped: false };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function resolvedPath(p: string | undefined, cwd: string): string | undefined {
  if (!p) return undefined;
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * Lines in the file a Write would replace, plus whether it exists at all.
 * Best-effort on purpose: an unreadable target must not break the ask, it
 * just downgrades the warning to existence-only.
 */
function existingFile(path: string): { exists: boolean; lines?: number } {
  try {
    if (!existsSync(path)) return { exists: false };
    const st = statSync(path);
    if (!st.isFile()) return { exists: true };
    if (st.size > COUNT_CAP_BYTES) return { exists: true };
    const text = readFileSync(path, 'utf8');
    return { exists: true, lines: text.length === 0 ? 0 : text.split('\n').length };
  } catch {
    return { exists: false };
  }
}

/** The preview for one ask; undefined for tools with nothing better than the detail line. */
export function buildPreview(tool: string, input: unknown, cwd: string): ApprovalPreview | undefined {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

  if (tool === 'Bash') {
    const command = str(record.command);
    return command ? { kind: 'command', command: cap(command).text } : undefined;
  }

  if (tool === 'Edit') {
    const path = str(record.file_path);
    const oldText = str(record.old_string);
    const newText = str(record.new_string);
    if (path === undefined || oldText === undefined || newText === undefined) return undefined;
    const o = cap(oldText);
    const n = cap(newText);
    return {
      kind: 'edit', path,
      oldText: o.text, newText: n.text,
      capped: o.capped || n.capped,
      replaceAll: record.replace_all === true,
    };
  }

  if (tool === 'Write') {
    const path = str(record.file_path);
    const content = str(record.content);
    if (path === undefined || content === undefined) return undefined;
    const c = cap(content);
    const target = resolvedPath(path, cwd);
    const on = target ? existingFile(target) : { exists: false };
    return {
      kind: 'write', path,
      content: c.text, capped: c.capped,
      exists: on.exists, existingLines: on.lines,
    };
  }

  return undefined;
}

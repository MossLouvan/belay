// Pure parsing behind the "what changed" screen: split the host's unified
// diff into per-file sections with each line classified for rendering.
//
// Classification, not syntax highlighting: the phone colours added lines,
// removed lines and the position markers, and leaves everything else in the
// machine panel's plain mono. That is the whole vocabulary a reader needs to
// follow a diff, and it works for every language including none.
//
// Node-tested (diff-format.test.mjs), so nothing here may import react-native.

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

export interface DiffFileSection {
  /** The file's path as the diff names it, for the section header. */
  readonly path: string;
  readonly lines: readonly DiffLine[];
}

// "diff --git a/src/x.ts b/src/x.ts" — the b-side is where the file lives
// now (after a rename, the side the reader cares about).
const FILE_HEADER = /^diff --git (?:"?a\/.*"? )?"?b\/(.*?)"?$/;

const META_PREFIXES = [
  '--- ', '+++ ', 'index ', 'new file', 'deleted file', 'old mode', 'new mode',
  'similarity ', 'rename ', 'copy ', 'Binary files ', 'GIT binary patch', '\\ No newline',
];

function classify(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  // Order matters: '--- a/x' and '+++ b/x' would otherwise read as
  // remove/add, painting every file header red and green.
  if (META_PREFIXES.some((p) => line.startsWith(p))) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

/**
 * Split a unified diff into file sections. Anything before the first file
 * header (there should be nothing) is grouped under an unnamed section rather
 * than dropped — a parser that discards input it does not expect would hide
 * exactly the surprising part.
 */
export function splitDiff(diff: string): DiffFileSection[] {
  if (diff.trim().length === 0) return [];
  const sections: { path: string; lines: DiffLine[] }[] = [];
  let current: { path: string; lines: DiffLine[] } | null = null;

  for (const raw of diff.split('\n')) {
    const header = FILE_HEADER.exec(raw);
    if (header) {
      current = { path: header[1] ?? '', lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { path: '', lines: [] };
      sections.push(current);
    }
    current.lines.push({ kind: classify(raw), text: raw });
  }

  // The final split('\n') leaves one empty trailing line per diff; render
  // nothing rather than a blank context row at the end of the last file.
  return sections.map((s) => {
    const lines = [...s.lines];
    while (lines.length > 0 && lines[lines.length - 1]!.text === '') lines.pop();
    return { path: s.path, lines };
  });
}

// ---- generating a diff, not just parsing one -------------------------------
//
// The approval card needs a diff for a change that has not happened yet: an
// Edit's old/new strings, or a Write's whole content. There is no git on the
// phone, so the diff is built here — line-classified text that splitDiff and
// DiffBody already know how to render, which keeps the approval card and the
// post-hoc "what changed" screen speaking the same visual language.

/** A built diff plus whether the line cap cut it. */
export interface GeneratedDiff {
  readonly text: string;
  readonly capped: boolean;
}

/** Changed lines shown before an approval-card diff is cut. */
export const GENERATED_DIFF_CAP = 400;
/** Unchanged lines kept around the changed block, unified-diff style. */
const CONTEXT_LINES = 3;

const capLines = (lines: readonly string[], cap: number): { lines: readonly string[]; capped: boolean } =>
  lines.length > cap ? { lines: lines.slice(0, cap), capped: true } : { lines, capped: false };

/**
 * An Edit's old→new strings as diff lines. Not an LCS diff on purpose: the
 * edit really is "this text becomes that text", so common leading and
 * trailing lines become context and everything between reads as remove/add.
 * That is truthful and cheap, and never mis-pairs lines the way a clever
 * matcher can.
 */
export function editDiff(oldText: string, newText: string, cap = GENERATED_DIFF_CAP): GeneratedDiff {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  const out: string[] = [];
  // Context lines take the unified-diff leading space so classify() reads
  // them as context, even when the source line itself starts with + or -.
  for (const line of a.slice(Math.max(0, head - CONTEXT_LINES), head)) out.push(' ' + line);
  for (const line of a.slice(head, a.length - tail)) out.push('-' + line);
  for (const line of b.slice(head, b.length - tail)) out.push('+' + line);
  for (const line of a.slice(a.length - tail, a.length - tail + CONTEXT_LINES)) out.push(' ' + line);

  const { lines, capped } = capLines(out, cap);
  return { text: lines.join('\n'), capped };
}

/** A Write's content as one all-additions diff. */
export function writeDiff(content: string, cap = GENERATED_DIFF_CAP): GeneratedDiff {
  const { lines, capped } = capLines(content.split('\n').map((l) => '+' + l), cap);
  return { text: lines.join('\n'), capped };
}

/** How a file's kind reads in the list: a word, not a status letter. */
export function kindWord(kind: 'new' | 'edited' | 'deleted' | 'renamed'): string {
  if (kind === 'new') return 'NEW';
  if (kind === 'deleted') return 'DELETED';
  if (kind === 'renamed') return 'RENAMED';
  return 'EDITED';
}

/** "+12 −3" for the file list — compact, but with real words nearby. */
export function countBadge(added: number | null, removed: number | null, binary: boolean): string {
  if (binary) return 'BINARY';
  if (added === null && removed === null) return '';
  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`−${removed}`);
  return parts.join(' ');
}

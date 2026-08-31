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

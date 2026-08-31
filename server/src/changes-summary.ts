// The plain-English headline for "what changed" — the sentence the owner reads
// standing in a queue, deciding whether to trust the work without walking to
// the computer.
//
// Two rules govern every string produced here, and the tests pin both:
//
//   1. No git vocabulary. Not "3 files changed, 47 insertions(+)" — the reader
//      may never have used git, and the numbers-with-signs form answers a
//      question nobody standing in a queue is asking. The headline says what
//      happened in words: "Claude edited 3 files, mostly in the server
//      folder."
//   2. Honest before reassuring. Anything that should give the owner pause —
//      deleted files, large removals, touched secrets or build config,
//      removed tests — becomes a caution that renders BEFORE the headline.
//      A summary that soothes ("tidied up" for 200 deleted test lines) is
//      worse than no summary, because the whole point of this surface is to
//      decide whether to trust the work.
//
// Pure on purpose: counts in, sentences out, no fs, no git, no clock. The
// wording is behaviour here, so it must be testable and improvable the way
// any other behaviour is.

/** One changed file, as the git collector in changes.ts reports it. */
export interface ChangedFile {
  readonly path: string;
  readonly kind: 'new' | 'edited' | 'deleted' | 'renamed';
  /** For renames: where the file used to live. */
  readonly from?: string;
  /** Lines added / removed; null when unknowable (binary files). */
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

export interface ChangeSummary {
  /** One or two plain sentences: what happened, where, and how much. */
  readonly headline: string;
  /** Plain warnings, most alarming first. Rendered above the headline. */
  readonly cautions: readonly string[];
}

// Removal has to be both large and lopsided before it earns a caution:
// a refactor that moves 300 lines adds roughly as many as it removes, and
// crying wolf on every refactor would teach the owner to skip the cautions.
const HEAVY_REMOVAL_LINES = 100;
const HEAVY_REMOVAL_RATIO = 3;

// Tests are cheaper to delete than to fix, which is exactly why deleting them
// deserves its own caution at a lower bar than ordinary code.
const TEST_REMOVAL_LINES = 30;

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$/i;

// Files whose contents are worth more than the rest of the project put
// together. "token" is deliberately absent: it matches tokens.ts-style theme
// files far more often than credentials.
const SECRET_PATH = /(^|\/)\.env(\.[^/]*)?$|secret|credential|password|id_rsa|\.pem$|\.key$|\.p12$|\.keystore$/i;

// Files that change what the project *does* when built or run — a small edit
// here can matter more than a large one anywhere else.
const CONFIG_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'dockerfile', 'makefile',
  'tsconfig.json', 'settings.json', 'app.json', 'cargo.toml', 'go.mod',
  'requirements.txt', 'pyproject.toml', 'gemfile',
]);
const WORKFLOW_PATH = /(^|\/)\.github\/workflows\//i;

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

const basename = (path: string): string => path.split('/').pop() ?? path;

/** "a, b and c" — the way a person lists things, not an array dump. */
function listNames(paths: readonly string[], max: number): string {
  const names = paths.map(basename);
  if (names.length <= max) {
    return names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  const shown = names.slice(0, max).join(', ');
  return `${shown} and ${count(names.length - max, 'other')}`;
}

/**
 * Where the work happened, from the first path segment: "all in the server
 * folder" when every file shares one, "mostly in …" past two-thirds, and
 * silence otherwise — a wrong location claim is worse than none.
 */
function folderPhrase(files: readonly ChangedFile[]): string {
  if (files.length < 2) return '';
  const tally = new Map<string, number>();
  for (const f of files) {
    const slash = f.path.indexOf('/');
    if (slash <= 0) continue; // top-level file: no folder to name
    const seg = f.path.slice(0, slash);
    tally.set(seg, (tally.get(seg) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [seg, n] of tally) {
    if (n > bestCount) { best = seg; bestCount = n; }
  }
  if (bestCount === files.length) return ` — all in the ${best} folder`;
  if (bestCount >= Math.ceil((files.length * 2) / 3)) return ` — mostly in the ${best} folder`;
  return '';
}

/** "Claude deleted 1 file, edited 3 files and added 2 new files". */
function actionSentence(files: readonly ChangedFile[]): string {
  const deleted = files.filter((f) => f.kind === 'deleted');
  const added = files.filter((f) => f.kind === 'new');
  const edited = files.filter((f) => f.kind === 'edited');
  const renamed = files.filter((f) => f.kind === 'renamed');

  // One file: name it outright — "3 files" hides the one fact that matters.
  if (files.length === 1) {
    const f = files[0]!;
    if (f.kind === 'deleted') return `Claude deleted one file, ${f.path}.`;
    if (f.kind === 'new') return `Claude added one new file, ${f.path}.`;
    if (f.kind === 'renamed') return `Claude renamed ${f.from ?? 'a file'} to ${f.path}.`;
    return `Claude edited one file, ${f.path}.`;
  }

  // Destructive verbs lead, so the sentence cannot bury a deletion.
  const parts: string[] = [];
  if (deleted.length) parts.push(`deleted ${count(deleted.length, 'file')}`);
  if (edited.length) parts.push(`edited ${count(edited.length, 'file')}`);
  if (added.length) parts.push(`added ${count(added.length, 'new file')}`);
  if (renamed.length) parts.push(`renamed ${count(renamed.length, 'file')}`);
  const joined = parts.length <= 1
    ? (parts[0] ?? 'changed some files')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Claude ${joined}${folderPhrase(files)}.`;
}

/** How much changed, in words a non-programmer parses in one read. */
function scaleSentence(files: readonly ChangedFile[]): string {
  const added = files.reduce((sum, f) => sum + (f.added ?? 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.removed ?? 0), 0);
  const binaries = files.filter((f) => f.binary).length;

  const sentences: string[] = [];
  if (added + removed === 0) {
    if (binaries === 0) return '';
  } else if (added + removed < 10) {
    sentences.push('Only a few lines changed.');
  } else if (removed === 0) {
    sentences.push(`About ${count(added, 'new line')} of work, nothing taken out.`);
  } else if (added === 0) {
    sentences.push(`Nothing new was written — ${count(removed, 'line')} came out.`);
  } else if (removed > added) {
    sentences.push(`More came out than went in: ${count(removed, 'line')} removed, ${added} added.`);
  } else {
    sentences.push(`Mostly new work: about ${count(added, 'new line')}, with ${removed} removed.`);
  }

  if (binaries > 0) {
    sentences.push(
      binaries === 1
        ? 'One of the files is an image or other file that can’t be shown as text.'
        : `${binaries} of the files are images or other files that can’t be shown as text.`,
    );
  }
  return sentences.join(' ');
}

function deletionCaution(files: readonly ChangedFile[]): string | null {
  const deleted = files.filter((f) => f.kind === 'deleted');
  if (deleted.length === 0) return null;
  const names = listNames(deleted.map((f) => f.path), 3);
  return deleted.length === 1
    ? `It deleted ${names}. Make sure that was meant to happen.`
    : `It deleted ${count(deleted.length, 'file')} (${names}). Make sure that was meant to happen.`;
}

function secretCaution(files: readonly ChangedFile[]): string | null {
  const touched = files.filter((f) => SECRET_PATH.test(f.path));
  if (touched.length === 0) return null;
  return `It touched ${listNames(touched.map((f) => f.path), 2)}, which can hold passwords or keys. Look at that change before anything else.`;
}

function heavyRemovalCaution(files: readonly ChangedFile[]): string | null {
  // The single worst shrink, not a list: one concrete example reads as a fact
  // to check, a list of five reads as noise to skip.
  const shrunk = files
    .filter((f) => f.kind === 'edited'
      && (f.removed ?? 0) >= HEAVY_REMOVAL_LINES
      && (f.removed ?? 0) > (f.added ?? 0) * HEAVY_REMOVAL_RATIO)
    .sort((a, b) => (b.removed ?? 0) - (a.removed ?? 0));
  const worst = shrunk[0];
  if (!worst) return null;
  const also = shrunk.length > 1 ? ` ${count(shrunk.length - 1, 'other file')} shrank a lot too.` : '';
  return `A lot came out of ${worst.path}: ${count(worst.removed ?? 0, 'line')} gone, only ${worst.added ?? 0} added.${also}`;
}

function testRemovalCaution(files: readonly ChangedFile[]): string | null {
  const deletedTests = files.filter((f) => f.kind === 'deleted' && TEST_PATH.test(f.path));
  const shrunkTests = files.filter((f) => f.kind === 'edited' && TEST_PATH.test(f.path)
    && (f.removed ?? 0) >= TEST_REMOVAL_LINES
    && (f.removed ?? 0) > (f.added ?? 0));
  if (deletedTests.length === 0 && shrunkTests.length === 0) return null;
  const what = deletedTests.length > 0
    ? `${listNames(deletedTests.map((f) => f.path), 2)} ${deletedTests.length === 1 ? 'was' : 'were'} deleted`
    : `${count(shrunkTests.reduce((sum, f) => sum + (f.removed ?? 0), 0), 'line')} came out of ${listNames(shrunkTests.map((f) => f.path), 2)}`;
  return `Tests were removed: ${what}. Fewer tests means less is being checked automatically.`;
}

function configCaution(files: readonly ChangedFile[]): string | null {
  const touched = files.filter((f) => f.kind !== 'deleted'
    && (CONFIG_BASENAMES.has(basename(f.path).toLowerCase()) || WORKFLOW_PATH.test(f.path)));
  if (touched.length === 0) return null;
  return `It changed ${listNames(touched.map((f) => f.path), 2)}, which affects how the project is built or run.`;
}

/**
 * The one export: file classifications in, honest sentences out.
 *
 * Caution order is fixed — deletions, secrets, heavy removals, removed tests,
 * config — so the most irreversible or dangerous fact is always the first
 * thing on screen.
 */
export function summarizeChanges(files: readonly ChangedFile[]): ChangeSummary {
  if (files.length === 0) {
    return {
      headline: 'No changes — every file is exactly as it was before.',
      cautions: [],
    };
  }
  const cautions = [
    deletionCaution(files),
    secretCaution(files),
    heavyRemovalCaution(files),
    testRemovalCaution(files),
    configCaution(files),
  ].filter((c): c is string => c !== null);

  const scale = scaleSentence(files);
  const headline = scale ? `${actionSentence(files)} ${scale}` : actionSentence(files);
  return { headline, cautions };
}

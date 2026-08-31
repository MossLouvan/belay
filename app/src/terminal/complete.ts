// Tab completion for the line-based terminal input.
//
// The input box is a plain TextInput, but completion is a *shell* feature: only
// zsh/bash/PowerShell knows what "ls Doc<tab>" should become. So the host runs
// a short dance against the real pty — write the line, write a tab, capture the
// echo, then kill the shell's line with Ctrl-U so its buffer is empty again —
// and sends the captured raw bytes back. This module is the pure half on the
// phone: it replays that echo through a tiny line discipline and decides what
// the shell actually did — completed the line, offered candidates, or nothing.
//
// The desync-proof invariant lives in that division of labour: the shell's
// line buffer is ALWAYS returned to empty (the host kills it even on timeout),
// so the TextInput is the only line buffer that exists between dances. This
// module never guesses at shell state; it only reads what the shell said.
//
// Pure and renderer-free on purpose — exercised by complete.test.mjs under
// node:test, and must never value-import react-native.

export type CompletionResult =
  /** The shell completed (or rewrote) the line; put this text in the input. */
  | { readonly kind: 'line'; readonly line: string }
  /** Ambiguous: candidates to offer, plus the line extended to their common prefix. */
  | { readonly kind: 'candidates'; readonly candidates: readonly string[]; readonly line: string }
  /** The shell had nothing to add. */
  | { readonly kind: 'none' }
  /** The echo used screen addressing this replay cannot follow (ConPTY does). */
  | { readonly kind: 'unreadable' };

// --- echo replay -------------------------------------------------------------

export interface EchoScreen {
  readonly lines: readonly string[];
  readonly bell: boolean;
  /** True when the echo moved the cursor vertically or absolutely — the replay
      is line-relative and cannot follow, so nothing here can be trusted. */
  readonly unreadable: boolean;
}

const TAB_STOP = 8;
const CSI_FINAL_MIN = 0x40; // '@'
const CSI_FINAL_MAX = 0x7e; // '~'

/** CSI finals that move vertically or address the screen absolutely. A dance is
    relative to one prompt line; these mean the shell (in practice, ConPTY) is
    repainting a region we never saw, so the replay must declare defeat rather
    than reconstruct a wrong line. */
const UNREADABLE_FINALS = new Set(['A', 'B', 'H', 'f', 'J', 'd', 'E', 'F', 'L', 'M', 'S', 'T']);

const firstParam = (params: string, fallback: number): number => {
  const n = parseInt(params.split(';')[0] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Replays raw echo bytes through a minimal line discipline: printable chars
 * overwrite at the cursor, `\r`/`\n`/`\b` move it, CSI K/C/D/G/P/X/@ edit the
 * current line. This is NOT the transcript's ANSI parser — it reconstructs what
 * the *shell's edit line* looks like after the echo, starting from empty,
 * which is exactly the shell's buffer because the dance began on an empty line.
 */
export function interpretEcho(raw: string): EchoScreen {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  let bell = false;
  let unreadable = false;

  const line = (): string[] => lines[row];
  const pad = (target: number): void => {
    const l = line();
    while (l.length < target) l.push(' ');
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\x1b') {
      const next = raw[i + 1];
      if (next === '[') {
        // CSI: params/intermediates then one final byte in @-~.
        let j = i + 2;
        while (j < raw.length && (raw.charCodeAt(j) < CSI_FINAL_MIN || raw.charCodeAt(j) > CSI_FINAL_MAX)) j += 1;
        if (j >= raw.length) break; // split sequence at the end of the capture
        const final = raw[j];
        const params = raw.slice(i + 2, j).replace(/[?>=!<]/g, '');
        if (UNREADABLE_FINALS.has(final)) unreadable = true;
        else if (final === 'C') col += firstParam(params, 1);
        else if (final === 'D') col = Math.max(0, col - firstParam(params, 1));
        else if (final === 'G') col = Math.max(0, firstParam(params, 1) - 1);
        else if (final === 'K') {
          const mode = parseInt(params, 10) || 0;
          if (mode === 0) line().length = Math.min(line().length, col);
          else if (mode === 1) { pad(col); for (let k = 0; k < col; k += 1) line()[k] = ' '; }
          else lines[row] = [];
        } else if (final === 'P') line().splice(col, firstParam(params, 1));
        else if (final === 'X') { const n = firstParam(params, 1); pad(col); for (let k = 0; k < n && col + k < line().length; k += 1) line()[col + k] = ' '; }
        else if (final === '@') { pad(col); const blanks = new Array(firstParam(params, 1)).fill(' '); line().splice(col, 0, ...blanks); }
        // Everything else (SGR, modes, save/restore) styles rather than moves.
        i = j + 1;
        continue;
      }
      if (next === ']') {
        // OSC: runs to BEL or ST.
        const bel = raw.indexOf('\x07', i + 2);
        const st = raw.indexOf('\x1b\\', i + 2);
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
        if (end === -1) break;
        i = end + (end === st ? 2 : 1);
        continue;
      }
      if (next === 'M') unreadable = true; // reverse index: a vertical move
      // Two-byte escapes (charset selects, keypad modes, save/restore).
      i += next === '(' || next === ')' ? 3 : 2;
      continue;
    }
    if (ch === '\r') col = 0;
    else if (ch === '\n') { row += 1; if (!lines[row]) lines[row] = []; }
    else if (ch === '\b') col = Math.max(0, col - 1);
    else if (ch === '\x07') bell = true;
    else if (ch === '\t') col = (Math.floor(col / TAB_STOP) + 1) * TAB_STOP;
    else if (ch >= ' ') { pad(col); line()[col] = ch; col += 1; }
    i += 1;
  }

  return {
    lines: lines.map((l) => l.join('').replace(/\s+$/, '')),
    bell,
    unreadable,
  };
}

// --- word boundaries ---------------------------------------------------------

export interface LastWord {
  /** Raw index in the input where the word's basename portion starts. */
  readonly baseStart: number;
  /** The unescaped basename portion (after the word's last slash). */
  readonly base: string;
  /** The quote the cursor sits inside, if any — insertion must respect it. */
  readonly quote: '"' | "'" | null;
}

/**
 * Finds the trailing word the shell would complete: the token after the last
 * unquoted whitespace, and within it the part after the last slash — because a
 * shell lists *basenames* for path completion, so matching and splicing must
 * happen at the basename boundary, not the token boundary. Quoting and
 * backslash escapes are honoured so `ls "My Doc` yields base `My Doc`.
 */
export function lastWord(input: string): LastWord {
  let baseStart = 0;
  let base = '';
  let inSingle = false;
  let inDouble = false;

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (!inSingle && ch === '\\' && i + 1 < input.length) {
      base += input[i + 1];
      i += 2;
      continue;
    }
    if ((ch === "'" && !inDouble) || (ch === '"' && !inSingle)) {
      if (ch === "'") inSingle = !inSingle;
      else inDouble = !inDouble;
      // A quote opening a fresh word: splicing must keep the quote itself.
      if (base === '') baseStart = i + 1;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
      baseStart = i + 1;
      base = '';
      i += 1;
      continue;
    }
    if (ch === '/') {
      baseStart = i + 1;
      base = '';
      i += 1;
      continue;
    }
    base += ch;
    i += 1;
  }

  return { baseStart, base, quote: inSingle ? "'" : inDouble ? '"' : null };
}

/** Characters that would be shell syntax rather than filename when unquoted. */
const NEEDS_ESCAPE = /([\\ \t"'`$&|;()<>*?[\]{}~#!])/g;

const escapeWord = (text: string): string => text.replace(NEEDS_ESCAPE, '\\$1');

/**
 * Splices a chosen candidate over the input's trailing basename, escaping it
 * the way the user would have to. Inside an open quote the text goes in raw —
 * the quote is already doing the escaping (a quote character of the same kind
 * is the one thing dropped, since it would close the quote mid-name).
 */
export function applyCandidate(input: string, candidate: string): string {
  const w = lastWord(input);
  const head = input.slice(0, w.baseStart);
  if (w.quote) return head + candidate.split(w.quote).join('');
  return head + escapeWord(candidate);
}

const commonPrefix = (words: readonly string[]): string => {
  if (words.length === 0) return '';
  let prefix = words[0];
  for (const word of words.slice(1)) {
    let k = 0;
    while (k < prefix.length && k < word.length && prefix[k] === word[k]) k += 1;
    prefix = prefix.slice(0, k);
  }
  return prefix;
};

// --- classification ----------------------------------------------------------

/** bash and zsh both gate huge candidate lists behind a y/n question; the
    capture then holds a question, not a list. (The host's Ctrl-U answers it
    "no", so the shell is not left waiting.) */
const LIST_QUESTION = /possibilit|do you wish|y or n|yes\/no/i;

const MAX_CANDIDATES = 64;

/** An upward cursor move. In a candidate list this is the shell finishing: it
    printed the list below the prompt and is climbing back up to redraw the
    edit line — everything after it is prompt repaint, not candidates. */
const CURSOR_UP = /\x1b\[\d*[AF]|\x1bM/;

/**
 * Flattens one candidate row to plain text: escape sequences and control
 * bytes vanish, tabs become column gaps wide enough for the splitter to see.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;:?>=!<]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/\t/g, '   ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
}

/** The edit line the pre-list echo settles on, or null when it cannot be
    trusted: an unreadable replay, or a wrap fragment that lost the line's
    first character (see the guard note in parseCompletion). */
function reconstructLine(sent: string, raw: string): string | null {
  const echo = interpretEcho(raw);
  if (echo.unreadable) return null;
  const lines = echo.lines.filter((l) => l !== '');
  if (lines.length !== 1) return lines.length === 0 ? sent : null;
  const line = lines[0];
  return line[0] === sent[0] ? line : null;
}

const splitColumns = (lines: readonly string[], sent: string): string[] =>
  lines
    .filter((l) => !LIST_QUESTION.test(l))
    .flatMap((l) => l.split(/\s{2,}/))
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c !== sent)
    .slice(0, MAX_CANDIDATES);

/**
 * Decides what the shell did with the tab, given the line we sent and the raw
 * echo captured after it.
 *
 * No newline in the echo means the shell edited in place: the replayed line IS
 * the shell's buffer (the dance started from an empty one), so any change — an
 * appended suffix, or a rewrite like case correction — is taken wholesale.
 *
 * A newline means a candidate list. The segment before the first newline is
 * the edit line (possibly already extended to the common prefix); the region
 * after it holds the candidate rows, ending where the shell starts repainting
 * — at its first upward cursor move (zsh climbs back to the prompt) or at the
 * last newline (bash reprints prompt and line below the list). The redrawn
 * prompt is never parsed at all, because nothing outside the shell knows what
 * the prompt looks like: the returned line is computed here from the sent
 * text and the candidates, which is authoritative precisely because the host
 * cleared the shell's own buffer.
 */
export function parseCompletion(sent: string, raw: string): CompletionResult {
  const nl = raw.indexOf('\n');

  if (nl === -1) {
    const echo = interpretEcho(raw);
    if (echo.unreadable) return { kind: 'unreadable' };
    const lines = echo.lines.filter((l) => l !== '');
    if (lines.length === 0) return { kind: 'none' };
    if (lines.length > 1) return { kind: 'unreadable' };
    const line = lines[0];
    if (line === sent) return { kind: 'none' };
    // A soft-wrapped echo overwrites itself into a tail fragment when replayed
    // (the host widens the pty to 400 columns to prevent wrapping, but a
    // pathologically wide prompt could still hit the edge). A real completion
    // always keeps the line's first character; a fragment almost never does —
    // refuse rather than corrupt the input.
    if (line[0] !== sent[0]) return { kind: 'unreadable' };
    return { kind: 'line', line };
  }

  const head = reconstructLine(sent, raw.slice(0, nl));
  if (head === null) return { kind: 'unreadable' };

  const rest = raw.slice(nl + 1);
  const up = rest.search(CURSOR_UP);
  const region = up !== -1 ? rest.slice(0, up) : rest.slice(0, Math.max(0, rest.lastIndexOf('\n')));
  const rows = region.split('\n').map(stripAnsi).filter((l) => l.length > 0);
  const candidates = splitColumns(rows, sent);

  // A list gated behind the shell's y/n question parses to nothing here, which
  // is honest: there were too many candidates to offer, and the host's Ctrl-U
  // has already answered the question "no". Any prefix the shell inserted
  // before listing still comes through via the head segment.
  if (candidates.length === 0) return head !== sent ? { kind: 'line', line: head } : { kind: 'none' };

  if (candidates.length === 1) {
    return { kind: 'line', line: applyCandidate(head, candidates[0]) };
  }

  const base = lastWord(head).base;
  const matching = candidates.filter((c) => c.startsWith(base));
  const prefix = commonPrefix(matching.length > 0 ? matching : candidates);
  const line = prefix.length > base.length ? applyCandidate(head, prefix) : head;
  return { kind: 'candidates', candidates, line };
}

// A small, dependency-free ANSI/VT parser for the Terminal screen, plus the
// themed 16-colour ramps the screen renders its spans with.
//
// A real pty emits escape sequences for colour, cursor movement and erasure.
// Rendering them as literal text looks broken, and stripping them entirely
// throws away everything that makes a shell readable. This module keeps a
// line-oriented screen buffer with a cursor and a graphic pen, so `\r`
// overwrites, progress bars, `clear`, and SGR colours all behave.
//
// It is deliberately NOT a full terminal emulator: there is no alternate
// screen buffer, no scroll regions and no wide-character handling, so
// full-screen TUIs (vim, htop) render approximately rather than exactly. That
// trade is intentional — a real emulator is a large dependency, and the common
// case here is an interactive shell.
//
// The public API is immutable: `feed()` takes a state and returns a new one.
// Internally a single call works on a transient copy (copy-on-write per line)
// so streaming stays O(changed lines) rather than O(scrollback).

export interface AnsiIndexColor {
  readonly kind: 'idx';
  /** 0-15 for the system palette, 16-255 for the xterm cube/greyscale. */
  readonly index: number;
}

export interface AnsiRgbColor {
  readonly kind: 'rgb';
  /** `#rrggbb`. */
  readonly hex: string;
}

export type AnsiColor = AnsiIndexColor | AnsiRgbColor;

export interface Style {
  readonly fg: AnsiColor | null;
  readonly bg: AnsiColor | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
}

export interface TermLine {
  readonly chars: readonly string[];
  readonly styles: readonly Style[];
}

export interface TermState {
  readonly lines: readonly TermLine[];
  readonly row: number;
  readonly col: number;
  readonly style: Style;
  readonly saved: { readonly row: number; readonly col: number } | null;
  /** An escape sequence split across two chunks, carried to the next feed. */
  readonly pending: string;
}

export interface TermOptions {
  readonly cols: number;
  readonly rows: number;
  readonly maxLines: number;
}

export interface Span {
  readonly text: string;
  readonly style: Style;
}

export const DEFAULT_STYLE: Style = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
});

/** Guards against a malformed stream growing the carry-over buffer forever. */
const MAX_PENDING = 4096;
const TAB_WIDTH = 8;
const MIN_COLS = 10;
const MIN_ROWS = 4;

/**
 * How far past the top of the viewport a single escape may move the cursor,
 * as a multiple of the screen height. A CSI parameter is host-controlled and
 * unbounded (`ESC [ 5000000 B` is twelve bytes), and every row target is
 * materialised by `ensureRow`, so without this an accidental `cat` of a binary
 * file allocates millions of lines and takes the app down. Two screens is far
 * more than any legitimate cursor addressing needs: absolute moves (CUP, VPA)
 * address a row inside the viewport, and relative moves (CUD, CNL, IND) only
 * ever scroll one line past the bottom at a time.
 */
const ROW_OVERSHOOT = 2;
/**
 * Lines the buffer may run past `maxLines` before it is trimmed mid-pass.
 * Trimming is O(scrollback), so it is amortised over a block of appends rather
 * than run on every one — but it does run during the pass, which is what keeps
 * peak memory bounded no matter how long the chunk is.
 */
const TRIM_SLACK = 256;

// --- style interning --------------------------------------------------------
// Cells hold a reference to a shared frozen Style, so run-length grouping at
// render time is a reference comparison and identical runs cost one object.

const STYLE_CACHE_LIMIT = 512;
const styleCache = new Map<string, Style>();

const colorKey = (c: AnsiColor | null): string =>
  c === null ? '-' : c.kind === 'idx' ? `i${c.index}` : `r${c.hex}`;

function internStyle(style: Style): Style {
  const key = `${colorKey(style.fg)}|${colorKey(style.bg)}|${style.bold ? 1 : 0}${style.dim ? 1 : 0}${
    style.italic ? 1 : 0
  }${style.underline ? 1 : 0}${style.inverse ? 1 : 0}`;
  const hit = styleCache.get(key);
  if (hit) return hit;
  // A truecolor-heavy stream could otherwise grow this without bound.
  if (styleCache.size >= STYLE_CACHE_LIMIT) styleCache.clear();
  const frozen = Object.freeze(style);
  styleCache.set(key, frozen);
  return frozen;
}

// --- transient working context ---------------------------------------------

interface MutableLine {
  chars: string[];
  styles: Style[];
}

interface Ctx {
  lines: MutableLine[];
  row: number;
  col: number;
  style: Style;
  saved: { row: number; col: number } | null;
  cols: number;
  rows: number;
  maxLines: number;
  /**
   * Line objects already cloned in this pass and therefore safe to mutate.
   * Keyed by identity rather than index so that inserting, deleting or
   * trimming lines never invalidates the bookkeeping.
   */
  owned: WeakSet<TermLine | MutableLine>;
}

const EMPTY_LINE: TermLine = Object.freeze({ chars: Object.freeze([]), styles: Object.freeze([]) });

export function createTermState(): TermState {
  return {
    lines: [EMPTY_LINE],
    row: 0,
    col: 0,
    style: DEFAULT_STYLE,
    saved: null,
    pending: '',
  };
}

/** Wipes the scrollback but keeps the current pen, as a real `clear` does. */
export function clearTermState(state: TermState): TermState {
  return { ...createTermState(), style: state.style };
}

function ownLine(ctx: Ctx, row: number): MutableLine {
  const src = ctx.lines[row];
  if (ctx.owned.has(src)) return src;
  const clone: MutableLine = { chars: src.chars.slice(), styles: src.styles.slice() };
  ctx.lines[row] = clone;
  ctx.owned.add(clone);
  return clone;
}

function newLine(ctx: Ctx): MutableLine {
  const line: MutableLine = { chars: [], styles: [] };
  ctx.owned.add(line);
  return line;
}

/** Top of the visible screen — CUP/ED are relative to this, not to line 0. */
const viewportTop = (ctx: Ctx): number => Math.max(0, ctx.lines.length - ctx.rows);

/**
 * The highest row index any single operation may reach. Always at least
 * `lines.length` (so ordinary scrolling past the bottom still works) and at
 * most one extra screen beyond that.
 */
const rowCeiling = (ctx: Ctx): number => viewportTop(ctx) + ctx.rows * ROW_OVERSHOOT;

/** Drops `count` lines off the top, keeping the cursor and mark pointing at the same text. */
function dropLeading(ctx: Ctx, count: number): void {
  if (count <= 0) return;
  ctx.lines = ctx.lines.slice(count);
  ctx.row = Math.max(0, ctx.row - count);
  if (ctx.saved) ctx.saved = { row: Math.max(0, ctx.saved.row - count), col: ctx.saved.col };
}

/**
 * Materialises rows up to `row` and returns the row actually reached, which is
 * `row` clamped to `rowCeiling` and re-based if the buffer had to be trimmed on
 * the way. Callers assign the result back to `ctx.row`: after this returns, the
 * index is guaranteed to exist in `ctx.lines`.
 */
function ensureRow(ctx: Ctx, row: number): number {
  let target = Math.min(Math.max(0, row), rowCeiling(ctx));
  while (ctx.lines.length <= target) {
    ctx.lines.push(newLine(ctx));
    if (ctx.lines.length > ctx.maxLines + TRIM_SLACK) {
      const excess = ctx.lines.length - ctx.maxLines;
      dropLeading(ctx, excess);
      target -= excess;
    }
  }
  return Math.max(0, target);
}

function padTo(line: MutableLine, col: number): void {
  while (line.chars.length < col) {
    line.chars.push(' ');
    line.styles.push(DEFAULT_STYLE);
  }
}

function writeChar(ctx: Ctx, ch: string): void {
  if (ctx.col >= ctx.cols) {
    ctx.col = 0;
    ctx.row += 1;
  }
  ctx.row = ensureRow(ctx, ctx.row);
  const line = ownLine(ctx, ctx.row);
  padTo(line, ctx.col);
  line.chars[ctx.col] = ch;
  line.styles[ctx.col] = ctx.style;
  ctx.col += 1;
}

function handleControl(ctx: Ctx, ch: string): void {
  if (ch === '\n') {
    ctx.row += 1;
    ctx.row = ensureRow(ctx, ctx.row);
    return;
  }
  if (ch === '\r') {
    ctx.col = 0;
    return;
  }
  if (ch === '\b') {
    ctx.col = Math.max(0, ctx.col - 1);
    return;
  }
  if (ch === '\t') {
    const target = Math.min(ctx.cols - 1, (Math.floor(ctx.col / TAB_WIDTH) + 1) * TAB_WIDTH);
    while (ctx.col < target) writeChar(ctx, ' ');
    return;
  }
  // Bell, shift-in/out and every other C0 byte are dropped rather than drawn.
}

// --- CSI ---------------------------------------------------------------------

function parseParams(body: string): number[] {
  if (!body) return [];
  return body.split(';').map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function eraseInLine(ctx: Ctx, mode: number): void {
  ctx.row = ensureRow(ctx, ctx.row);
  const line = ownLine(ctx, ctx.row);
  if (mode === 1) {
    padTo(line, ctx.col);
    for (let i = 0; i <= ctx.col && i < line.chars.length; i += 1) {
      line.chars[i] = ' ';
      line.styles[i] = DEFAULT_STYLE;
    }
    return;
  }
  if (mode === 2) {
    line.chars.length = 0;
    line.styles.length = 0;
    return;
  }
  line.chars.length = Math.min(line.chars.length, ctx.col);
  line.styles.length = line.chars.length;
}

function eraseInDisplay(ctx: Ctx, mode: number): void {
  if (mode === 2 || mode === 3) {
    // Drop the current screen but keep the scrollback above it, which is what
    // a user of a phone-sized log view actually wants from `clear`.
    const top = viewportTop(ctx);
    ctx.lines.length = top;
    ctx.row = ensureRow(ctx, top);
    ctx.col = 0;
    return;
  }
  if (mode === 1) {
    eraseInLine(ctx, 1);
    return;
  }
  eraseInLine(ctx, 0);
  ctx.lines.length = Math.min(ctx.lines.length, ctx.row + 1);
}

function eraseChars(ctx: Ctx, count: number): void {
  ctx.row = ensureRow(ctx, ctx.row);
  const line = ownLine(ctx, ctx.row);
  for (let i = ctx.col; i < Math.min(line.chars.length, ctx.col + count); i += 1) {
    line.chars[i] = ' ';
    line.styles[i] = DEFAULT_STYLE;
  }
}

function spliceChars(ctx: Ctx, count: number, insert: boolean): void {
  ctx.row = ensureRow(ctx, ctx.row);
  const line = ownLine(ctx, ctx.row);
  padTo(line, ctx.col);
  if (insert) {
    // ICH allocates before the truncation below, so the count is clamped first:
    // inserting more blanks than the line can hold is a no-op with a huge price.
    const width = Math.min(count, ctx.cols);
    line.chars.splice(ctx.col, 0, ...new Array<string>(width).fill(' '));
    line.styles.splice(ctx.col, 0, ...new Array<Style>(width).fill(DEFAULT_STYLE));
    line.chars.length = Math.min(line.chars.length, ctx.cols);
    line.styles.length = line.chars.length;
    return;
  }
  line.chars.splice(ctx.col, count);
  line.styles.splice(ctx.col, count);
}

function spliceLines(ctx: Ctx, count: number, insert: boolean): void {
  ctx.row = ensureRow(ctx, ctx.row);
  if (insert) {
    // IL past the bottom of the screen scrolls everything off anyway, so a
    // count larger than one screen buys nothing and allocates without limit.
    const added = Math.min(count, ctx.rows);
    ctx.lines.splice(ctx.row, 0, ...Array.from({ length: added }, () => newLine(ctx)));
    return;
  }
  ctx.lines.splice(ctx.row, count);
  ctx.row = ensureRow(ctx, ctx.row);
}

/**
 * Row targets are clamped here, before anything is allocated. `ensureRow`
 * enforces the same ceiling, but doing it at the source keeps the cursor and
 * the buffer in agreement instead of leaving `ctx.row` pointing into the void.
 */
const clampRow = (ctx: Ctx, row: number): number => Math.max(0, Math.min(row, rowCeiling(ctx)));

function moveCursor(ctx: Ctx, final: string, params: readonly number[]): void {
  const n = Math.max(1, params[0] || 1);
  if (final === 'A') ctx.row = Math.max(0, ctx.row - n);
  else if (final === 'B') ctx.row = clampRow(ctx, ctx.row + n);
  else if (final === 'C') ctx.col = Math.min(ctx.cols - 1, ctx.col + n);
  else if (final === 'D') ctx.col = Math.max(0, ctx.col - n);
  else if (final === 'E') { ctx.row = clampRow(ctx, ctx.row + n); ctx.col = 0; }
  else if (final === 'F') { ctx.row = Math.max(0, ctx.row - n); ctx.col = 0; }
  else if (final === 'G' || final === '`') ctx.col = Math.max(0, Math.min(ctx.cols - 1, n - 1));
  else if (final === 'd') ctx.row = clampRow(ctx, viewportTop(ctx) + n - 1);
  else if (final === 'H' || final === 'f') {
    ctx.row = clampRow(ctx, viewportTop(ctx) + Math.max(1, params[0] || 1) - 1);
    ctx.col = Math.max(0, Math.min(ctx.cols - 1, Math.max(1, params[1] || 1) - 1));
  }
  ctx.row = ensureRow(ctx, ctx.row);
}

const CURSOR_FINALS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'd', 'f', '`']);

function handleCsi(ctx: Ctx, seq: string): void {
  // seq is `ESC [ <body> <final>`; private (`?`) sequences set modes we do not
  // model (alternate screen, bracketed paste) and are ignored on purpose.
  const final = seq[seq.length - 1];
  const body = seq.slice(2, -1);
  if (body.startsWith('?') || body.startsWith('>') || body.startsWith('<')) return;
  const params = parseParams(body);

  if (final === 'm') {
    ctx.style = applySgr(ctx.style, params);
    return;
  }
  if (CURSOR_FINALS.has(final)) {
    moveCursor(ctx, final, params);
    return;
  }
  if (final === 'K') eraseInLine(ctx, params[0] || 0);
  else if (final === 'J') eraseInDisplay(ctx, params[0] || 0);
  else if (final === 'X') eraseChars(ctx, Math.max(1, params[0] || 1));
  else if (final === 'P') spliceChars(ctx, Math.max(1, params[0] || 1), false);
  else if (final === '@') spliceChars(ctx, Math.max(1, params[0] || 1), true);
  else if (final === 'L') spliceLines(ctx, Math.max(1, params[0] || 1), true);
  else if (final === 'M') spliceLines(ctx, Math.max(1, params[0] || 1), false);
  else if (final === 's') ctx.saved = { row: ctx.row, col: ctx.col };
  else if (final === 'u' && ctx.saved) {
    ctx.row = ctx.saved.row;
    ctx.col = ctx.saved.col;
    ctx.row = ensureRow(ctx, ctx.row);
  }
  // Everything else (device reports, scroll regions, tab stops) is a no-op.
}

// --- SGR ---------------------------------------------------------------------

/** Reads a 38/48 extended-colour argument, returning the colour and how many params it consumed. */
function readExtendedColor(params: readonly number[], at: number): { color: AnsiColor | null; used: number } {
  const kind = params[at + 1];
  if (kind === 5) {
    const index = params[at + 2];
    if (!Number.isFinite(index) || index < 0 || index > 255) return { color: null, used: 3 };
    return { color: { kind: 'idx', index }, used: 3 };
  }
  if (kind === 2) {
    const parts = [params[at + 2], params[at + 3], params[at + 4]];
    if (parts.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return { color: null, used: 5 };
    const hex = parts.map((v) => v.toString(16).padStart(2, '0')).join('');
    return { color: { kind: 'rgb', hex: `#${hex}` }, used: 5 };
  }
  return { color: null, used: 2 };
}

function applySgr(base: Style, params: readonly number[]): Style {
  if (params.length === 0) return DEFAULT_STYLE;
  let next: Style = base;
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i];
    if (p === 0) { next = DEFAULT_STYLE; continue; }
    if (p === 1) { next = { ...next, bold: true }; continue; }
    if (p === 2) { next = { ...next, dim: true }; continue; }
    if (p === 3) { next = { ...next, italic: true }; continue; }
    if (p === 4) { next = { ...next, underline: true }; continue; }
    if (p === 7) { next = { ...next, inverse: true }; continue; }
    if (p === 22) { next = { ...next, bold: false, dim: false }; continue; }
    if (p === 23) { next = { ...next, italic: false }; continue; }
    if (p === 24) { next = { ...next, underline: false }; continue; }
    if (p === 27) { next = { ...next, inverse: false }; continue; }
    if (p >= 30 && p <= 37) { next = { ...next, fg: { kind: 'idx', index: p - 30 } }; continue; }
    if (p >= 40 && p <= 47) { next = { ...next, bg: { kind: 'idx', index: p - 40 } }; continue; }
    if (p >= 90 && p <= 97) { next = { ...next, fg: { kind: 'idx', index: p - 90 + 8 } }; continue; }
    if (p >= 100 && p <= 107) { next = { ...next, bg: { kind: 'idx', index: p - 100 + 8 } }; continue; }
    if (p === 39) { next = { ...next, fg: null }; continue; }
    if (p === 49) { next = { ...next, bg: null }; continue; }
    if (p === 38 || p === 48) {
      const { color, used } = readExtendedColor(params, i);
      next = p === 38 ? { ...next, fg: color } : { ...next, bg: color };
      i += used - 1;
    }
  }
  return internStyle(next);
}

// --- escape scanning ---------------------------------------------------------

const CSI_RE = /^\x1b\[[0-9;:<=>?]*[ -\/]*[@-~]/;
const OSC_RE = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/;
const STRING_RE = /^\x1b[PX^_][\s\S]*?\x1b\\/;
const CHARSET_RE = /^\x1b[()*+][\s\S]/;
/** Two-byte escapes such as ESC 7 / ESC M that carry no payload. */
const SINGLE_RE = /^\x1b[@-Z\\-_0-9=><]/;

interface EscapeMatch {
  /** `partial` means "wait for more bytes"; `invalid` drops the lone ESC. */
  readonly kind: 'csi' | 'other' | 'partial' | 'invalid';
  readonly text: string;
}

const PARTIAL: EscapeMatch = { kind: 'partial', text: '' };

/**
 * Classifies the escape sequence at the head of `rest`. Dispatching on the
 * introducer (rather than trying regexes in order) is what makes a truncated
 * OSC/DCS come back as `partial` instead of being mis-read as a 2-byte escape.
 */
function matchEscape(rest: string): EscapeMatch {
  if (rest.length < 2) return { ...PARTIAL, text: rest };
  const intro = rest[1];
  const tryOne = (re: RegExp, kind: 'csi' | 'other'): EscapeMatch => {
    const m = re.exec(rest);
    return m ? { kind, text: m[0] } : { ...PARTIAL, text: rest };
  };
  if (intro === '[') return tryOne(CSI_RE, 'csi');
  if (intro === ']') return tryOne(OSC_RE, 'other');
  if (intro === 'P' || intro === 'X' || intro === '^' || intro === '_') return tryOne(STRING_RE, 'other');
  if (intro === '(' || intro === ')' || intro === '*' || intro === '+') return tryOne(CHARSET_RE, 'other');
  const single = SINGLE_RE.exec(rest);
  if (single) return { kind: 'other', text: single[0] };
  return { kind: 'invalid', text: '\x1b' };
}

function trim(ctx: Ctx, maxLines: number): void {
  dropLeading(ctx, ctx.lines.length - maxLines);
}

function freezeLines(ctx: Ctx): readonly TermLine[] {
  // Lines untouched this pass are already frozen TermLines; only freeze the
  // ones we cloned, so the cost stays proportional to what actually changed.
  return ctx.lines.map((line) =>
    ctx.owned.has(line)
      ? Object.freeze({ chars: Object.freeze(line.chars), styles: Object.freeze(line.styles) })
      : (line as TermLine)
  );
}

/**
 * Consumes a chunk of shell output. `chunk` comes off a WebSocket, so it is
 * validated rather than trusted: a non-string is ignored outright.
 */
export function feed(state: TermState, chunk: unknown, options: TermOptions): TermState {
  if (typeof chunk !== 'string' || chunk.length === 0) return state;

  const cols = Math.max(MIN_COLS, Math.floor(options.cols) || MIN_COLS);
  const rows = Math.max(MIN_ROWS, Math.floor(options.rows) || MIN_ROWS);
  const maxLines = Math.max(rows, Math.floor(options.maxLines) || rows);

  const ctx: Ctx = {
    lines: state.lines.map((l) => l as unknown as MutableLine),
    row: Math.min(state.row, state.lines.length - 1),
    col: state.col,
    style: state.style,
    saved: state.saved ? { ...state.saved } : null,
    cols,
    rows,
    maxLines,
    owned: new WeakSet<TermLine | MutableLine>(),
  };

  const input = state.pending + chunk;
  let pending = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\x1b') {
      const match = matchEscape(input.slice(i));
      if (match.kind === 'partial') {
        pending = match.text.length > MAX_PENDING ? '' : match.text;
        break;
      }
      if (match.kind === 'csi') handleCsi(ctx, match.text);
      i += match.text.length;
      continue;
    }
    if (ch < ' ' || ch === '\x7f') handleControl(ctx, ch);
    else writeChar(ctx, ch);
    i += 1;
  }

  trim(ctx, maxLines);
  return {
    lines: freezeLines(ctx),
    row: Math.max(0, Math.min(ctx.row, ctx.lines.length - 1)),
    col: ctx.col,
    style: ctx.style,
    saved: ctx.saved,
    pending,
  };
}

// --- rendering helpers -------------------------------------------------------

/** Groups a line into runs of identical style, ready to render as nested Text. */
export function lineToSpans(line: TermLine): readonly Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let i = 1; i <= line.chars.length; i += 1) {
    if (i === line.chars.length || line.styles[i] !== line.styles[start]) {
      spans.push({ text: line.chars.slice(start, i).join(''), style: line.styles[start] });
      start = i;
    }
  }
  return spans;
}

export function lineToText(line: TermLine): string {
  return line.chars.join('');
}

export function termToText(state: TermState): string {
  return state.lines.map(lineToText).join('\n');
}

/**
 * Resolves an ANSI colour to a hex value. Indices 0-15 come from the caller's
 * themed 16-colour ramp so the terminal reads correctly in light and dark;
 * 16-255 are the fixed xterm cube and greyscale.
 */
export function resolveColor(color: AnsiColor, ramp: readonly string[]): string | null {
  if (color.kind === 'rgb') return color.hex;
  const { index } = color;
  if (index < 16) return ramp[index] ?? null;
  if (index < 232) {
    const n = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const rgb = [levels[Math.floor(n / 36) % 6], levels[Math.floor(n / 6) % 6], levels[n % 6]];
    return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  const grey = Math.min(255, 8 + (index - 232) * 10);
  const hex = grey.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

// --- themed colour resolution -----------------------------------------------

/**
 * The 16 system colours, tuned per scheme. Index 0 (ANSI black) is deliberately
 * not black: on the dark canvas it would be invisible, so it becomes a grey
 * that still reads as "the dim one".
 */
export const ANSI_RAMPS: Readonly<Record<'dark' | 'light', readonly string[]>> = {
  dark: [
    '#4A5262', '#FF6B6B', '#3DDC97', '#F7B32B', '#7C8CFF', '#D48CFF', '#54D5E6', '#C8D2E4',
    '#6B7488', '#FF9A9A', '#7BEEBB', '#FFD166', '#A3AEFF', '#E3B4FF', '#8AE7F2', '#F3F6FC',
  ],
  light: [
    '#3A4152', '#B3261E', '#0B7A54', '#8A5A05', '#3B4CD8', '#8B2FB8', '#0E6F7E', '#4E5768',
    '#5D6780', '#8F1D17', '#075E41', '#6B4604', '#2E3BAB', '#6E2492', '#0A5764', '#0D1017',
  ],
};

export interface SpanColors {
  readonly color: string;
  readonly backgroundColor?: string;
  readonly opacity?: number;
  readonly fontWeight?: 'bold';
  readonly fontStyle?: 'italic';
  readonly textDecorationLine?: 'underline';
}

export function spanColors(style: Style, ramp: readonly string[], fgDefault: string, bgDefault: string): SpanColors {
  const fg = style.fg ? resolveColor(style.fg, ramp) ?? fgDefault : fgDefault;
  const bg = style.bg ? resolveColor(style.bg, ramp) ?? null : null;
  const inverted = style.inverse;
  return {
    color: inverted ? bg ?? bgDefault : fg,
    backgroundColor: inverted ? fg : bg ?? undefined,
    opacity: style.dim ? 0.65 : undefined,
    fontWeight: style.bold ? 'bold' : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecorationLine: style.underline ? 'underline' : undefined,
  };
}

// Whether the shell's own line buffer holds text, and which kind of tab the
// screen may therefore run.
//
// The completion dance (./complete.ts) is built on one invariant: the shell's
// line buffer is empty between dances, so the phone's TextInput is the only
// line buffer in the system. TYPE breaks into that world on purpose — it puts
// bytes at the shell's prompt *without* a return, exactly so a half-typed
// command can sit there and be finished. The moment that happens the shell's
// buffer, not the TextInput, is the real line, and a dance would replay the
// field's text on top of it and splice a completion into a line that never
// existed.
//
// So the screen keeps this ledger: every byte sent to the shell passes through
// `trackPrimed`, and `planTab` refuses to dance while the buffer is believed
// non-empty — it flushes the field and passes a real tab through instead,
// letting the shell's own completion take over in the transcript. That branch
// is safe whatever the truth is (raw keystrokes are always legal), while the
// dance is only safe on an empty buffer, so every ambiguous byte — a lone Esc,
// an up-arrow that may recall history, a truncated escape sequence — counts as
// priming. Being wrongly primed costs a native tab; being wrongly empty costs
// a corrupted line.
//
// Pure and renderer-free — exercised by primed.test.mjs under node:test, and
// must never value-import react-native.

export type TabPlan =
  /** Nothing of ours is in play; hand the shell a bare tab keystroke. */
  | { readonly kind: 'passthrough'; readonly data: string }
  /** The shell already holds part of the line: push the field's text after it
      and tab natively — the dance would corrupt what is there. */
  | { readonly kind: 'flush'; readonly data: string }
  /** Empty shell buffer, text in the field: the completion dance applies. */
  | { readonly kind: 'dance' };

/** Bytes after which every line editor's buffer is empty: return submits the
    line, newline is its pipe-mode twin, Ctrl-C aborts it, Ctrl-U kills it. */
const CLEARING = new Set(['\r', '\n', '\x03', '\x15']);

/** Bytes that can remove or repaint but never insert: backspace/delete-char
    (which may not *empty* a primed buffer, so they leave the flag alone),
    Ctrl-L's redraw, and the bell. */
const NEUTRAL = new Set(['\x7f', '\x08', '\x04', '\x0c', '\x07']);

const CSI_FINAL_MIN = 0x40; // '@'
const CSI_FINAL_MAX = 0x7e; // '~'

/**
 * Folds one chunk of sent keystrokes into the primed flag. Printables and
 * tabs insert; CSI left/right (word jumps included) only move the cursor;
 * up/down may recall a whole history line into the buffer, so they prime.
 * Anything unrecognised — including an escape sequence cut off at the end of
 * the chunk — primes too, per the bias explained above.
 */
export function trackPrimed(primed: boolean, data: string): boolean {
  let state = primed;
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (CLEARING.has(ch)) {
      state = false;
      i += 1;
      continue;
    }
    if (NEUTRAL.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === '\x1b' && data[i + 1] === '[') {
      let j = i + 2;
      while (j < data.length && (data.charCodeAt(j) < CSI_FINAL_MIN || data.charCodeAt(j) > CSI_FINAL_MAX)) j += 1;
      if (j >= data.length) return true; // truncated: cannot be read, so prime
      const final = data[j];
      if (final !== 'C' && final !== 'D') state = true;
      i = j + 1;
      continue;
    }
    state = true;
    i += 1;
  }
  return state;
}

/** What a tab press should do, given the field's text and the ledger. */
export function planTab(input: string, primed: boolean): TabPlan {
  if (input.length === 0) return { kind: 'passthrough', data: '\t' };
  if (primed) return { kind: 'flush', data: `${input}\t` };
  return { kind: 'dance' };
}

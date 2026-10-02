// What the command field sends to the shell. A paste from a chat or a doc is
// the main way commands arrive on a phone, so newlines are terminators — one
// line runs at a time — never flattened into one long command (#143).

/** The field's text as lines; a trailing newline adds no empty command. */
export function shellLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** RUN: every line followed by return. An empty field is just the return. */
export const runBytes = (text: string): string => `${shellLines(text).join('\r')}\r`;

/** TYPE: every complete line runs; the last is parked at the prompt, unreturned. */
export const typeBytes = (text: string): string => shellLines(text).join('\r');

/**
 * A piped shell never echoes what it is fed, so the transcript would show
 * only output with nothing to attribute it to (#144). The screen writes each
 * command into its own buffer as a dim `$` line before sending it.
 */
export const pipeEcho = (text: string): string =>
  shellLines(text).map((line) => `\x1b[2m$ ${line}\x1b[22m\r\n`).join('');

// Unit tests for the pure helpers behind the Terminal and Files screens:
// key encoding, output backpressure, and the binary-content heuristic.
//
//   cd app && node src/screen-helpers.test.mjs
//
// Same shape as ./terminal-ansi.test.mjs — no framework, throws on failure.
// Only modules free of JSX are imported here, since Node strips types but does
// not compile JSX; the components that use them are covered by Playwright.

import { encodeKey } from './terminal-keymap.ts';
import { EMPTY_OUTPUT, drainOutput, pushOutput } from './terminal-session.ts';
import { crumbsFor, formatSize, looksBinary, parentOf, sortEntries } from './files-format.ts';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

// --- key encoding ------------------------------------------------------------

const NONE = { ctrl: false, alt: false };
const CTRL = { ctrl: true, alt: false };
const ALT = { ctrl: false, alt: true };

check('unmodified keys pass through', encodeKey('a', NONE), 'a');
check('ctrl maps letters to control codes', encodeKey('c', CTRL), '\x03');
check('ctrl is case-insensitive', encodeKey('R', CTRL), '\x12');
check('ctrl maps bracket', encodeKey('[', CTRL), '\x1b');
check('ctrl+? is DEL, not US', encodeKey('?', CTRL), '\x7f');
check('alt prefixes ESC', encodeKey('f', ALT), '\x1bf');
check('ctrl+alt combine', encodeKey('c', { ctrl: true, alt: true }), '\x1b\x03');
check('ctrl on an arrow uses the CSI form', encodeKey('\x1b[D', CTRL), '\x1b[1;5D');
check('alt on an arrow uses the CSI form', encodeKey('\x1b[C', ALT), '\x1b[1;3C');
check('ctrl+alt on an arrow', encodeKey('\x1b[A', { ctrl: true, alt: true }), '\x1b[1;7A');
// Tab, Enter and Esc have no control form; they must survive an armed modifier
// unchanged rather than turn into some other byte.
check('ctrl leaves Tab alone', encodeKey('\t', CTRL), '\t');
check('ctrl leaves Enter alone', encodeKey('\r', CTRL), '\r');
check('ctrl leaves a multi-byte sequence alone', encodeKey('\x1b[3~', CTRL), '\x1b[3~');

// --- output backpressure -----------------------------------------------------

const small = pushOutput(pushOutput(EMPTY_OUTPUT, 'ab'), 'cd');
check('chunks accumulate', small.text, 'abcd');
check('nothing is dropped under the cap', small.dropped, 0);
check('drain empties the buffer', drainOutput(small).next, EMPTY_OUTPUT);
check('drain returns the text', drainOutput(small).text, 'abcd');
check('draining an empty buffer is empty', drainOutput(EMPTY_OUTPUT).text, '');

const flooded = ['1111', '2222', '3333'].reduce((buf, chunk) => pushOutput(buf, chunk, 8), EMPTY_OUTPUT);
check('the buffer is capped', flooded.text.length, 8);
check('the newest output survives', flooded.text, '22223333');
check('the drop is counted', flooded.dropped, 4);
const drained = drainOutput(flooded);
check('the drop is announced, not swallowed', drained.text.includes('dropped 4 characters'), true);
check('the notice leads the surviving output', drained.text.endsWith('22223333'), true);
check('a huge single chunk is capped too', pushOutput(EMPTY_OUTPUT, 'x'.repeat(5000), 100).text.length, 100);

// --- files formatting --------------------------------------------------------

check('bytes', formatSize(512), '512 B');
check('kilobytes', formatSize(2048), '2 KB');
check('megabytes', formatSize(5 * 1024 * 1024), '5.0 MB');
check('a negative size is unknown', formatSize(-1), '—');

check('posix crumbs', crumbsFor('/usr/local').map((c) => c.path), ['/', '/usr', '/usr/local']);
check('windows crumbs', crumbsFor('C:\\Users\\me').map((c) => c.path), ['C:\\', 'C:\\Users', 'C:\\Users\\me']);
check('parent of a posix path', parentOf('/usr/local'), '/usr');
check('parent of a root', parentOf('/'), null);

const entries = [
  { name: 'b.txt', path: '/b.txt', dir: false, size: 10, mtime: 2 },
  { name: 'a.txt', path: '/a.txt', dir: false, size: 30, mtime: 1 },
  { name: 'zdir', path: '/zdir', dir: true, size: 0, mtime: 3 },
];
check('folders lead', sortEntries(entries, 'name', false).map((e) => e.name), ['zdir', 'a.txt', 'b.txt']);
check('sort by size', sortEntries(entries, 'size', false).map((e) => e.name), ['zdir', 'b.txt', 'a.txt']);
check('descending reverses files', sortEntries(entries, 'name', true).map((e) => e.name), ['zdir', 'b.txt', 'a.txt']);

// --- binary detection --------------------------------------------------------
// The regression: an ANSI-colourised log is text. Every ESC in `ESC [ 3 1 m`
// used to count toward the odd-byte ratio, so `build.log` and `pytest.log` were
// hidden behind the "this looks like a binary file" wall.

const ansiLog = Array.from(
  { length: 60 },
  (_, i) => `\x1b[32mPASS\x1b[0m \x1b[2mtests/case_${i}\x1b[0m \x1b[33m0.0${i}s\x1b[0m`
).join('\n');
check('an ANSI-colourised log is text', looksBinary(ansiLog), false);
check('a dense SGR run is text', looksBinary('\x1b[31m\x1b[1m\x1b[4mx\x1b[0m'.repeat(200)), false);
check('an OSC title stream is text', looksBinary('\x1b]0;title\x07ok\n'.repeat(200)), false);
check('plain text is text', looksBinary('hello world\nsecond line\n'), false);
check('CJK is text', looksBinary('日本語のテキストです\n中文文本\n한국어 텍스트\n'.repeat(20)), false);
check('emoji is text', looksBinary('🎉 shipped 🚀 all green ✅\n'.repeat(50)), false);
check('empty content is text', looksBinary(''), false);
check('tabs and CRLF are text', looksBinary('a\tb\r\nc\td\r\n'.repeat(50)), false);

// A .DS_Store starts with NULs and control bytes; a stray ESC run with no
// introducer after it is still counted as odd.
const dsStore = '\u0000\u0000\u0000\u0001Bud1\u0000\u0000\u0010\u0000\u0000\u0000\u0008';
check('a NUL-bearing blob is binary', looksBinary(dsStore), true);
check('control-byte soup is binary', looksBinary('\u0001\u0002\u0003\u0004\u0005abc'.repeat(50)), true);
check('mojibake is binary', looksBinary('\ufffd\ufffd\ufffdPNG\ufffd'.repeat(50)), true);
check('bare ESC bytes still count as odd', looksBinary('\x1b\x01\x1b\x02\x1b\x03'.repeat(50)), true);

// --- report -----------------------------------------------------------------

if (failures.length > 0) {
  throw new Error(`screen-helpers: ${failures.length}/${checks} checks failed\n  - ${failures.join('\n  - ')}`);
}
// This file is a CLI script, not app code, so a console write is the output.
console.log(`screen-helpers: ${checks}/${checks} checks passed`);

// Which modifier means what when the keyboard and the host disagree.
//
// A Mac keyboard has Control/Option/Command; a Windows host wants
// Ctrl/Alt/Win. Forwarding the browser's names verbatim puts Command on the
// Windows key — so ⌘C, pressed where a Mac user's copy reflex lives, opens the
// Start menu, and every shortcut they know is displaced by one key. The remap
// here reassigns *roles*, not keys: the modifier under the thumb keeps doing
// the thing the thumb expects, and the leftover physical keys pick up the
// leftover roles so nothing on the remote side becomes unreachable.
//
// The map is chosen once per window from three facts — the client's keyboard,
// the host's platform, and the user's mode — and is pure, so every direction
// is unit-tested rather than discovered by breaking someone's copy-paste.
//
// Mac hosts get the unambiguous spellings (`rawctrl`, `cmd`) instead of
// `ctrl`, deliberately: the host's own BELAY_MAC_CTRL remap (server/keys.ts)
// exists for the phone app and rewrites the *name* `ctrl` according to a
// server-side env var this client cannot see. Speaking only the names that
// env var never touches means the mapping chosen here is the mapping that
// happens, whatever the host is configured to do for phones — one remap in
// charge, never two fighting.

/** Modes. `remap` translates roles; `verbatim` sends each key as itself. */
export const MODES = Object.freeze(['remap', 'verbatim']);

/** The pre-remap wire names, kept for hosts too old to report a platform. */
const LEGACY = Object.freeze({ ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'meta' });

/**
 * Host-name roles that make a chord: holding one of these means the key is a
 * command, never a character. `alt`/`option` is absent on purpose — Option is
 * how a Mac keyboard composes é and €, and treating it as a chord would turn
 * international typing into key events.
 */
const COMMAND_ROLES = Object.freeze(new Set(['ctrl', 'meta', 'win', 'cmd', 'rawctrl']));

export function isCommandRole(role) {
  return COMMAND_ROLES.has(role);
}

/**
 * The modifier map for one client/host pairing.
 *
 * `clientIsMac` is the *keyboard*, hostPlatform the host's self-reported OS
 * ('darwin' | 'win32' | anything else). Returns { ctrl, alt, meta, shift }
 * — the host-side name each browser modifier travels as — plus:
 *
 *   altComposes  Option produces characters locally, so a chord that holds it
 *                must recover the key from `event.code`, not `event.key`
 *                (Option+E arrives as "´", not "e").
 *   adjustable   whether remap and verbatim differ for this pairing, i.e.
 *                whether a toggle is worth showing at all.
 *
 * Mac → Windows remap is a full rotation: ⌘→Ctrl (copy reflex), ⌥→Win (the
 * key the owner asked for), and ⌃→Alt because it is the physical key left
 * over. The cost is that Alt chords move off the key labelled alt/option:
 * Alt+Tab is ⌃Tab, Alt+F4 is ⌃F4, menu accelerators ride ⌃. The alternative
 * — leaving ⌥ as Alt — would strand the Windows key on a modifier nobody has
 * left, which is the complaint that started this file.
 *
 * Windows → Mac remap mirrors it: Ctrl→⌘ (so Ctrl+C copies instead of
 * SIGINT-ing a terminal), Win→literal ⌃ (the leftover role — though the
 * client OS eats many Win chords before a browser sees them), Alt→⌥
 * unchanged. Mac → Mac and Windows → Windows need no translation, only the
 * unambiguous spellings on the Mac side.
 */
export function modifierMap(clientIsMac, hostPlatform, mode = 'remap') {
  const remap = mode !== 'verbatim';
  const base = {
    clientIsMac: clientIsMac === true,
    host: hostPlatform === 'win32' || hostPlatform === 'darwin' ? hostPlatform : 'other',
    shift: 'shift',
    altComposes: clientIsMac === true,
  };

  if (hostPlatform === 'win32') {
    const roles = clientIsMac && remap
      ? { ctrl: 'alt', alt: 'win', meta: 'ctrl' }
      : { ctrl: 'ctrl', alt: 'alt', meta: 'win' };
    return Object.freeze({ ...base, ...roles, adjustable: clientIsMac === true });
  }

  if (hostPlatform === 'darwin') {
    const roles = clientIsMac || !remap
      ? { ctrl: 'rawctrl', alt: 'alt', meta: 'cmd' }
      : { ctrl: 'cmd', alt: 'alt', meta: 'rawctrl' };
    return Object.freeze({ ...base, ...roles, adjustable: clientIsMac !== true });
  }

  // A host that never said what it is gets the wire names this client always
  // sent, so an old host sees byte-for-byte the traffic it was tested with.
  return Object.freeze({ ...base, ...LEGACY, adjustable: false });
}

/**
 * What a bare tap of one modifier should send, or null for nothing.
 *
 * A held modifier travels on the key it modifies, but the Windows key *does*
 * something alone — it opens the Start menu — and "click the Windows key
 * using Option" is the feature request this file answers. So a press-and-
 * release of the modifier whose role is `win` becomes the named `win` key.
 * No other modifier acts alone on either host, so everything else stays null.
 */
export function bareTapKey(browserKey, map) {
  const role = { Control: map.ctrl, Alt: map.alt, Meta: map.meta }[browserKey];
  return role === 'win' ? 'win' : null;
}

const CLIENT_LABEL = Object.freeze({
  mac: { ctrl: '⌃', alt: '⌥', meta: '⌘' },
  other: { ctrl: 'Ctrl', alt: 'Alt', meta: 'Win' },
});

const HOST_LABEL = Object.freeze({
  ctrl: 'Ctrl', alt: 'Alt', win: 'Win', meta: 'Win',
  cmd: '⌘', rawctrl: '⌃',
});

/**
 * The mapping as the UI must state it: one "press → sends" pair per modifier
 * whose role differs from what the key would mean verbatim. A remap the user
 * cannot see is a keyboard that lies; this is the sentence that keeps it
 * honest. Empty when nothing is being translated.
 */
export function legendOf(map) {
  const press = CLIENT_LABEL[map.clientIsMac ? 'mac' : 'other'];
  const self = modifierMap(map.clientIsMac, map.host, 'verbatim');
  return Object.freeze(['meta', 'alt', 'ctrl'].flatMap((mod) => {
    if (map[mod] === self[mod]) return [];
    return [Object.freeze({ press: press[mod], sends: HOST_LABEL[map[mod]] ?? map[mod] })];
  }));
}

/** legendOf, as the one-line string the display overlay shows. */
export function legendText(map) {
  return legendOf(map).map((e) => `${e.press} sends ${e.sends}`).join(' · ');
}

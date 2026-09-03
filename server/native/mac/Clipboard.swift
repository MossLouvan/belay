// Host clipboard access for the `clipboard` verb (get/set).
//
// NSPasteboard, text only. Reading returns whatever plain-text representation
// the pasteboard offers (rich content still carries one in almost every app);
// writing replaces the pasteboard's contents with a single plain-text item.
//
// The cap mirrors MAX_CLIPBOARD_UNITS in server/src/clipboard.ts and is
// counted the same way (UTF-16 code units, what JavaScript's String.length
// counts), so both layers agree on where "too big" starts. Node validates
// before sending; this clamps again because stdin is a boundary of its own.
//
// STATUS: WRITTEN-BUT-NOT-COMPILED — like the rest of mac/, this compiles via
// `bash native/build-mac.sh` on a machine with the Xcode CLT, which this
// change did not run. AppKit is already linked (see build-mac.sh).

import AppKit

enum HostClipboard {
    /// Mirrors MAX_CLIPBOARD_UNITS in server/src/clipboard.ts.
    static let maxTextUnits = 100_000

    /// The pasteboard's plain text, capped. An empty pasteboard (or one with
    /// no text representation, e.g. only an image) reads as empty text — that
    /// is an answer, not an error.
    static func read() -> (text: String, truncated: Bool) {
        let raw = NSPasteboard.general.string(forType: .string) ?? ""
        return capped(raw)
    }

    /// Replace the pasteboard's contents with `text`. Returns false when the
    /// pasteboard refused the write (rare, but the API can say no).
    static func write(_ text: String) -> Bool {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
    }

    /// Cut to at most `maxTextUnits` UTF-16 units on a Character boundary, so
    /// the cut can never emit half a surrogate pair (or half a grapheme).
    static func capped(_ raw: String) -> (text: String, truncated: Bool) {
        guard raw.utf16.count > maxTextUnits else { return (raw, false) }
        var out = String()
        out.reserveCapacity(maxTextUnits)
        var units = 0
        for character in raw {
            let width = character.utf16.count
            if units + width > maxTextUnits { break }
            out.append(character)
            units += width
        }
        return (out, true)
    }
}

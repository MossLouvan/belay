// The compact pixel-frame layout of server/src/frame-codec.ts, version 1,
// big-endian: magic 0xBF, version, u16 metaLen, u32 w/h/sw/sh, u32 jpegLen,
// then metaLen bytes of JSON meta (unused for a screen stream) and exactly
// jpegLen JPEG bytes. Every field is bounds-checked before any slice; anything
// malformed returns null and the message is skipped — the same contract as
// unparseable JSON.

export const BINARY_FRAME = Object.freeze({ magic: 0xbf, version: 0x01, header: 24, maxDimension: 1048576 });

/** @param {ArrayBuffer} buffer @returns {{ jpeg: Uint8Array } | null} */
export function decodeBinaryFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < BINARY_FRAME.header + 1) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== BINARY_FRAME.magic || view.getUint8(1) !== BINARY_FRAME.version) return null;
  const metaLen = view.getUint16(2);
  for (const offset of [4, 8, 12, 16]) {
    if (view.getUint32(offset) > BINARY_FRAME.maxDimension) return null;
  }
  const jpegLen = view.getUint32(20);
  const jpegStart = BINARY_FRAME.header + metaLen;
  // Exact framing: truncation and trailing garbage are both rejected.
  if (jpegLen < 1 || jpegStart + jpegLen !== buffer.byteLength) return null;
  return { jpeg: new Uint8Array(buffer, jpegStart, jpegLen) };
}

/** The bytes of a legacy JSON frame's base64 payload, or null if it is not base64. */
export function decodeBase64Frame(data) {
  if (typeof data !== 'string' || data.length === 0) return null;
  try {
    const text = atob(data);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

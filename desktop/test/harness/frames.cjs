// Frames the harness can recognise after they have been drawn.
//
// A frame is a solid colour that encodes its sequence number, produced by a
// tiny baseline JPEG encoder (DC-only blocks, so it needs no DCT and no
// dependency). The renderer draws it, the driver reads one canvas pixel back,
// and `frameIndexOf` says which frame is on screen — which is how the harness
// tells "frames keep drawing" from "the newest frame is what is drawn".

const LEVELS = 16;
const STEP = 256 / LEVELS;

/** The colour for frame `index`; 4096 distinct values before it wraps. */
function indexColor(index) {
  const level = (n) => (n % LEVELS) * STEP + STEP / 2;
  return { r: level(index), g: level(Math.floor(index / LEVELS)), b: level(Math.floor(index / (LEVELS * LEVELS))) };
}

/** Inverse of `indexColor`, tolerant of JPEG rounding. */
function frameIndexOf({ r, g, b }) {
  const level = (v) => Math.min(LEVELS - 1, Math.max(0, Math.floor(v / STEP)));
  return level(r) + level(g) * LEVELS + level(b) * LEVELS * LEVELS;
}

// ---- A DC-only baseline JPEG encoder ---------------------------------------

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** Canonical Huffman codes from a BITS/HUFFVAL pair (ITU T.81 Annex C). */
function huffmanCodes(bits, values) {
  const codes = new Map();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < bits[length - 1]; i += 1) {
      codes.set(values[k], { code, length });
      k += 1;
      code += 1;
    }
    code <<= 1;
  }
  return codes;
}

const DC_CODES = huffmanCodes(DC_BITS, DC_VALUES);
const EOB = huffmanCodes(AC_BITS, AC_VALUES).get(0x00);

function bitWriter() {
  const bytes = [];
  let acc = 0;
  let count = 0;
  const flushByte = (byte) => { bytes.push(byte); if (byte === 0xff) bytes.push(0x00); };
  return {
    write(value, length) {
      for (let i = length - 1; i >= 0; i -= 1) {
        acc = (acc << 1) | ((value >> i) & 1);
        count += 1;
        if (count === 8) { flushByte(acc); acc = 0; count = 0; }
      }
    },
    finish() {
      if (count > 0) { this.write((1 << (8 - count)) - 1, 8 - count); }
      return Buffer.from(bytes);
    },
  };
}

const category = (value) => (value === 0 ? 0 : Math.floor(Math.log2(Math.abs(value))) + 1);
const magnitudeBits = (value, size) => (value >= 0 ? value : value + (1 << size) - 1);

const segment = (marker, payload) => Buffer.concat([
  Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload,
]);

const rgbToYcc = ({ r, g, b }) => [
  0.299 * r + 0.587 * g + 0.114 * b,
  -0.168736 * r - 0.331264 * g + 0.5 * b + 128,
  0.5 * r - 0.418688 * g - 0.081312 * b + 128,
].map((v) => Math.min(255, Math.max(0, Math.round(v))));

/** A width x height JPEG of one solid colour. */
function solidColorJpeg({ r, g, b }, width, height) {
  const ycc = rgbToYcc({ r, g, b });
  // The DCT DC term of a flat 8x8 block is 8 x (level-shifted sample);
  // with a quantiser of 1 it is stored exactly.
  const dc = ycc.map((v) => 8 * (v - 128));
  const writer = bitWriter();
  const blocksX = Math.ceil(width / 8);
  const blocksY = Math.ceil(height / 8);
  for (let block = 0; block < blocksX * blocksY; block += 1) {
    for (let component = 0; component < 3; component += 1) {
      const diff = block === 0 ? dc[component] : 0;
      const size = category(diff);
      const { code, length } = DC_CODES.get(size);
      writer.write(code, length);
      if (size > 0) writer.write(magnitudeBits(diff, size), size);
      writer.write(EOB.code, EOB.length);
    }
  }
  const scan = writer.finish();
  const dqt = segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]));
  const sof = segment(0xc0, Buffer.from([
    8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
  ]));
  const dht = segment(0xc4, Buffer.concat([
    Buffer.from([0x00]), Buffer.from(DC_BITS), Buffer.from(DC_VALUES),
    Buffer.from([0x10]), Buffer.from(AC_BITS), Buffer.from(AC_VALUES),
  ]));
  const sos = segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), dqt, sof, dht, sos, scan, Buffer.from([0xff, 0xd9])]);
}

const cache = new Map();
/** Frame `index` as `{ w, h, jpeg }`, memoised per size. */
function solidJpeg(index, w = 640, h = 360) {
  const key = index + ':' + w + 'x' + h;
  if (!cache.has(key)) cache.set(key, { w, h, jpeg: solidColorJpeg(indexColor(index), w, h) });
  return cache.get(key);
}

module.exports = { indexColor, frameIndexOf, solidColorJpeg, solidJpeg };

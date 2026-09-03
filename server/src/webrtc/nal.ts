// Pure H.264/HEVC NAL-unit helpers: Annex-B parsing, AVCC conversion, and
// access-unit classification.
//
// This is the headless-testable REFERENCE for the byte-format contract between
// the native encoder and the RTP packetizer:
//   - VideoEncoder.swift converts VideoToolbox's AVCC output to Annex-B with
//     parameter sets prepended to every IDR — `avccToAnnexB` +
//     `summarizeAccessUnit` here encode the same rules, under `node --test`.
//   - belay_transport.cpp hands Annex-B access units to libdatachannel's
//     packetizer — `splitAnnexB` here is the same framing walk.
// When a real capture from the hardware path needs debugging (M3+), these
// functions are the conformance oracle: dump the bytes, run them through here.
//
// Everything is pure and allocation-conscious; no dependencies.

/** Framing byte layout shared by both codecs. */
export const ANNEXB_LONG_START_CODE = Object.freeze([0, 0, 0, 1]);
export const AVCC_LENGTH_PREFIX_BYTES = 4;

export type NalCodec = 'h264' | 'hevc';

/** H.264 NAL unit types this slice cares about (spec table 7-1). */
export const H264_NAL = Object.freeze({
  nonIdrSlice: 1,
  idrSlice: 5,
  sei: 6,
  sps: 7,
  pps: 8,
  accessUnitDelimiter: 9,
});

/** HEVC NAL unit types this slice cares about (spec table 7-1). */
export const HEVC_NAL = Object.freeze({
  idrWRadl: 19,
  idrNLp: 20,
  cra: 21,
  vps: 32,
  sps: 33,
  pps: 34,
});

/** One parsed NAL unit: its payload (no start code) and byte offset. */
export interface NalUnit {
  readonly bytes: Uint8Array;
  readonly offset: number;
}

/**
 * Splits an Annex-B elementary stream into NAL units. Accepts both 4-byte
 * (00 00 00 01) and 3-byte (00 00 01) start codes, as every compliant stream
 * mixes them. Returns an empty array for a buffer with no start code — callers
 * must treat that as malformed input, not an empty frame.
 */
export function splitAnnexB(buf: Uint8Array): NalUnit[] {
  const out: NalUnit[] = [];
  let i = 0;
  let nalStart = -1;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      const isLong = buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1;
      const isShort = buf[i + 2] === 1;
      if (isLong || isShort) {
        if (nalStart >= 0 && i > nalStart) {
          out.push({ bytes: buf.subarray(nalStart, i), offset: nalStart });
        }
        i += isLong ? 4 : 3;
        nalStart = i;
        continue;
      }
    }
    i += 1;
  }
  if (nalStart >= 0 && nalStart < buf.length) {
    out.push({ bytes: buf.subarray(nalStart), offset: nalStart });
  }
  return out;
}

/** H.264: NAL type is the low 5 bits of the first payload byte. */
export function h264NalType(nal: Uint8Array): number {
  if (nal.length === 0) throw new RangeError('empty NAL unit');
  return nal[0] & 0x1f;
}

/** HEVC: NAL type is bits 1..6 of the first payload byte (2-byte header). */
export function hevcNalType(nal: Uint8Array): number {
  if (nal.length < 2) throw new RangeError('HEVC NAL unit shorter than its 2-byte header');
  return (nal[0] >> 1) & 0x3f;
}

export function isKeyframeNal(nal: Uint8Array, codec: NalCodec): boolean {
  if (codec === 'h264') return h264NalType(nal) === H264_NAL.idrSlice;
  const t = hevcNalType(nal);
  return t === HEVC_NAL.idrWRadl || t === HEVC_NAL.idrNLp || t === HEVC_NAL.cra;
}

export function isParameterSetNal(nal: Uint8Array, codec: NalCodec): boolean {
  if (codec === 'h264') {
    const t = h264NalType(nal);
    return t === H264_NAL.sps || t === H264_NAL.pps;
  }
  const t = hevcNalType(nal);
  return t === HEVC_NAL.vps || t === HEVC_NAL.sps || t === HEVC_NAL.pps;
}

/**
 * Converts an AVCC buffer ([4-byte big-endian length][NAL] repeated — what
 * VideoToolbox emits) to Annex-B (what the RTP packetizer consumes). The same
 * walk as VideoEncoder.swift's emit(). Throws on a malformed buffer: a
 * truncated length prefix or a NAL that overruns the buffer is corrupt encoder
 * output and must never be forwarded as media.
 */
export function avccToAnnexB(avcc: Uint8Array): Uint8Array {
  const nals: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  while (offset < avcc.length) {
    if (offset + AVCC_LENGTH_PREFIX_BYTES > avcc.length) {
      throw new RangeError(`truncated AVCC length prefix at ${offset}/${avcc.length}`);
    }
    const len =
      (avcc[offset] << 24) | (avcc[offset + 1] << 16) | (avcc[offset + 2] << 8) | avcc[offset + 3];
    offset += AVCC_LENGTH_PREFIX_BYTES;
    if (len <= 0 || offset + len > avcc.length) {
      throw new RangeError(`malformed AVCC NAL length ${len} at ${offset}/${avcc.length}`);
    }
    nals.push(avcc.subarray(offset, offset + len));
    total += ANNEXB_LONG_START_CODE.length + len;
    offset += len;
  }
  const out = new Uint8Array(total);
  let w = 0;
  for (const nal of nals) {
    out.set(ANNEXB_LONG_START_CODE, w);
    w += ANNEXB_LONG_START_CODE.length;
    out.set(nal, w);
    w += nal.length;
  }
  return out;
}

/** Converts Annex-B to AVCC (4-byte length prefixes) — the reverse mapping,
 *  used to round-trip captures when debugging the native path. */
export function annexBToAvcc(annexB: Uint8Array): Uint8Array {
  const nals = splitAnnexB(annexB);
  if (nals.length === 0) throw new RangeError('no start codes: not an Annex-B stream');
  const total = nals.reduce((sum, n) => sum + AVCC_LENGTH_PREFIX_BYTES + n.bytes.length, 0);
  const out = new Uint8Array(total);
  let w = 0;
  for (const { bytes } of nals) {
    out[w] = (bytes.length >>> 24) & 0xff;
    out[w + 1] = (bytes.length >>> 16) & 0xff;
    out[w + 2] = (bytes.length >>> 8) & 0xff;
    out[w + 3] = bytes.length & 0xff;
    w += AVCC_LENGTH_PREFIX_BYTES;
    out.set(bytes, w);
    w += bytes.length;
  }
  return out;
}

/** What one Annex-B access unit contains — the properties the transport and
 *  the latency accounting rely on. */
export interface AccessUnitSummary {
  readonly nalCount: number;
  readonly isKeyframe: boolean;
  /** True when the parameter sets ride in-band (required on every keyframe:
   *  a decoder that joined late or lost state must be able to resync on any
   *  IDR — the rule VideoEncoder.swift implements by prepending them). */
  readonly hasParameterSets: boolean;
  readonly totalBytes: number;
}

export function summarizeAccessUnit(annexB: Uint8Array, codec: NalCodec): AccessUnitSummary {
  const nals = splitAnnexB(annexB);
  if (nals.length === 0) throw new RangeError('no start codes: not an Annex-B access unit');
  let isKeyframe = false;
  let hasParameterSets = false;
  for (const { bytes } of nals) {
    if (isKeyframeNal(bytes, codec)) isKeyframe = true;
    if (isParameterSetNal(bytes, codec)) hasParameterSets = true;
  }
  return { nalCount: nals.length, isKeyframe, hasParameterSets, totalBytes: annexB.length };
}

/**
 * The invariant the native encoder must uphold, as a checkable predicate:
 * every keyframe access unit carries its parameter sets in-band. Returns an
 * error string (not a throw) so a conformance harness can collect violations.
 */
export function checkKeyframeSelfContained(annexB: Uint8Array, codec: NalCodec): string | null {
  const summary = summarizeAccessUnit(annexB, codec);
  if (summary.isKeyframe && !summary.hasParameterSets) {
    return 'keyframe access unit is missing in-band parameter sets (late-join/loss resync would fail)';
  }
  return null;
}

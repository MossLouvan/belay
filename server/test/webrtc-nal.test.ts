// NAL-format reference tests: the byte contract between the native encoder
// (VideoEncoder.swift AVCC->Annex-B) and the RTP packetizer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitAnnexB,
  h264NalType,
  hevcNalType,
  isKeyframeNal,
  isParameterSetNal,
  avccToAnnexB,
  annexBToAvcc,
  summarizeAccessUnit,
  checkKeyframeSelfContained,
  H264_NAL,
  HEVC_NAL,
} from '../src/webrtc/nal.js';

/** Builds an Annex-B buffer from NAL payloads, alternating start-code widths
 *  to prove both are handled. */
function annexB(nals: number[][], mixStartCodes = false): Uint8Array {
  const parts: number[] = [];
  nals.forEach((nal, i) => {
    parts.push(...(mixStartCodes && i % 2 === 1 ? [0, 0, 1] : [0, 0, 0, 1]));
    parts.push(...nal);
  });
  return Uint8Array.from(parts);
}

/** H.264 NAL header byte for a type (forbidden_zero=0, nri=3). */
const h264 = (type: number, ...payload: number[]) => [0x60 | type, ...payload];
/** HEVC 2-byte NAL header for a type (layer 0, tid 1). */
const hevc = (type: number, ...payload: number[]) => [(type << 1) & 0x7e, 0x01, ...payload];

test('splitAnnexB handles 4-byte and 3-byte start codes', () => {
  const buf = annexB([h264(H264_NAL.sps, 1), h264(H264_NAL.pps, 2), h264(H264_NAL.idrSlice, 3, 4)], true);
  const nals = splitAnnexB(buf);
  assert.equal(nals.length, 3);
  assert.equal(h264NalType(nals[0].bytes), H264_NAL.sps);
  assert.equal(h264NalType(nals[1].bytes), H264_NAL.pps);
  assert.equal(h264NalType(nals[2].bytes), H264_NAL.idrSlice);
  assert.deepEqual([...nals[2].bytes.slice(1)], [3, 4]);
});

test('splitAnnexB returns empty for a buffer with no start code', () => {
  assert.deepEqual(splitAnnexB(Uint8Array.from([1, 2, 3, 4])), []);
  assert.deepEqual(splitAnnexB(new Uint8Array(0)), []);
});

test('NAL type extraction: H.264 low 5 bits, HEVC bits 1..6', () => {
  assert.equal(h264NalType(Uint8Array.from(h264(H264_NAL.idrSlice))), 5);
  assert.equal(hevcNalType(Uint8Array.from(hevc(HEVC_NAL.idrWRadl))), 19);
  assert.throws(() => h264NalType(new Uint8Array(0)), RangeError);
  assert.throws(() => hevcNalType(Uint8Array.from([0x28])), RangeError); // 1 byte < 2-byte header
});

test('keyframe and parameter-set classification per codec', () => {
  assert.equal(isKeyframeNal(Uint8Array.from(h264(H264_NAL.idrSlice)), 'h264'), true);
  assert.equal(isKeyframeNal(Uint8Array.from(h264(H264_NAL.nonIdrSlice)), 'h264'), false);
  assert.equal(isParameterSetNal(Uint8Array.from(h264(H264_NAL.sps)), 'h264'), true);
  assert.equal(isParameterSetNal(Uint8Array.from(h264(H264_NAL.sei)), 'h264'), false);

  for (const t of [HEVC_NAL.idrWRadl, HEVC_NAL.idrNLp, HEVC_NAL.cra]) {
    assert.equal(isKeyframeNal(Uint8Array.from(hevc(t)), 'hevc'), true);
  }
  for (const t of [HEVC_NAL.vps, HEVC_NAL.sps, HEVC_NAL.pps]) {
    assert.equal(isParameterSetNal(Uint8Array.from(hevc(t)), 'hevc'), true);
  }
  assert.equal(isKeyframeNal(Uint8Array.from(hevc(1)), 'hevc'), false);
});

test('AVCC -> Annex-B -> AVCC round-trips', () => {
  const nalA = h264(H264_NAL.sps, 9, 9);
  const nalB = h264(H264_NAL.idrSlice, 1, 2, 3, 4, 5);
  const avcc = Uint8Array.from([
    0, 0, 0, nalA.length, ...nalA,
    0, 0, 0, nalB.length, ...nalB,
  ]);
  const asAnnexB = avccToAnnexB(avcc);
  assert.deepEqual([...asAnnexB], [...annexB([nalA, nalB])]);
  assert.deepEqual([...annexBToAvcc(asAnnexB)], [...avcc]);
});

test('avccToAnnexB rejects corrupt buffers instead of forwarding them', () => {
  // Truncated length prefix.
  assert.throws(() => avccToAnnexB(Uint8Array.from([0, 0, 1])), RangeError);
  // Declared length overruns the buffer.
  assert.throws(() => avccToAnnexB(Uint8Array.from([0, 0, 0, 10, 1, 2])), RangeError);
  // Zero-length NAL.
  assert.throws(() => avccToAnnexB(Uint8Array.from([0, 0, 0, 0, 1])), RangeError);
});

test('summarizeAccessUnit sees keyframes and in-band parameter sets', () => {
  const idrWithParams = annexB([h264(H264_NAL.sps, 1), h264(H264_NAL.pps, 2), h264(H264_NAL.idrSlice, 3)]);
  const summary = summarizeAccessUnit(idrWithParams, 'h264');
  assert.equal(summary.nalCount, 3);
  assert.equal(summary.isKeyframe, true);
  assert.equal(summary.hasParameterSets, true);

  const pFrame = annexB([h264(H264_NAL.nonIdrSlice, 7)]);
  const p = summarizeAccessUnit(pFrame, 'h264');
  assert.equal(p.isKeyframe, false);
  assert.equal(p.hasParameterSets, false);

  assert.throws(() => summarizeAccessUnit(Uint8Array.from([1, 2, 3]), 'h264'), RangeError);
});

test('checkKeyframeSelfContained enforces the encoder invariant', () => {
  const goodIdr = annexB([h264(H264_NAL.sps, 1), h264(H264_NAL.pps, 2), h264(H264_NAL.idrSlice, 3)]);
  assert.equal(checkKeyframeSelfContained(goodIdr, 'h264'), null);

  const bareIdr = annexB([h264(H264_NAL.idrSlice, 3)]);
  assert.match(checkKeyframeSelfContained(bareIdr, 'h264') ?? '', /missing in-band parameter sets/);

  // P-frames are allowed to travel without parameter sets.
  const pFrame = annexB([h264(H264_NAL.nonIdrSlice, 7)]);
  assert.equal(checkKeyframeSelfContained(pFrame, 'h264'), null);

  // HEVC keyframe needs VPS/SPS/PPS too.
  const hevcIdr = annexB([hevc(HEVC_NAL.vps), hevc(HEVC_NAL.sps), hevc(HEVC_NAL.pps), hevc(HEVC_NAL.idrWRadl)]);
  assert.equal(checkKeyframeSelfContained(hevcIdr, 'hevc'), null);
  assert.match(checkKeyframeSelfContained(annexB([hevc(HEVC_NAL.idrWRadl)]), 'hevc') ?? '', /parameter sets/);
});

// What the stream readout shows, for whichever video path is actually live.
//
// This exists because the HUD read the JPEG frame counters directly, and those
// counters stop advancing the moment H.264 takes over — the host stops sending
// JPEG frames entirely. A working 60fps stream therefore displayed
// "fps 0 / 12, rate 0 KB/s, source —", which is the picture of a dead stream.
// Reporting a healthy stream as dead is worse than showing nothing.
//
// Kept pure and JSX-free so it can be tested directly, like the other model
// modules here.

import type { BwpStats } from './bwp';
import type { QualityPreset } from './model';
import type { StreamStats } from './stream';

export type HudRow = readonly [string, string];

export interface HudInputs {
  /** JPEG-path counters. Meaningless while `bwp` is non-null. */
  readonly stats: StreamStats;
  /** Host-reported stream rate, or null when H.264 is not carrying video. */
  readonly bwp: BwpStats | null;
  /** The host's frame size from its offer, when streaming H.264. */
  readonly bwpSize: { readonly width: number; readonly height: number } | null;
  /** 'gpu' when the host captures zero-copy, 'cpu' otherwise. */
  readonly bwpPath: string | null;
  readonly quality: QualityPreset;
  readonly pingMs: number | null;
  readonly zoom: number;
}

const dash = '—';

/** Bits per second as the largest unit that still reads naturally. */
export function formatBitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return dash;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/** True when H.264 is carrying the picture. */
export function isBwpLive(i: Pick<HudInputs, 'bwpPath' | 'bwp'>): boolean {
  return i.bwpPath !== null || i.bwp !== null;
}

export function hudRows(i: HudInputs): readonly HudRow[] {
  const ping = i.pingMs === null ? dash : `${i.pingMs} ms`;
  const zoom = `${i.zoom.toFixed(1)}×`;

  if (isBwpLive(i)) {
    // The host reports kilo*bits* per second; the JPEG path counts kilo*bytes*.
    // Labelling them identically is how a tenfold difference gets read as a
    // regression, so the unit is always spelled out.
    const fps = i.bwp ? `${Math.round(i.bwp.fps)} / ${i.quality.bwpFps}` : dash;
    const rate = i.bwp && i.bwp.kbps > 0 ? `${Math.round(i.bwp.kbps)} kbps` : dash;
    const cap = i.bwp ? formatBitrate(i.bwp.bitrate) : dash;
    const size =
      i.bwpSize && i.bwpSize.width > 0 ? `${i.bwpSize.width}×${i.bwpSize.height}` : dash;
    return [
      ['codec', i.bwpPath === 'gpu' ? 'H.264 · GPU' : 'H.264'],
      ['fps', fps],
      ['rate', rate],
      ['cap', cap],
      ['source', size],
      ['ping', ping],
      ['zoom', zoom],
    ];
  }

  return [
    ['fps', `${i.stats.fps} / ${i.quality.fps}`],
    ['rate', `${i.stats.kbps} KB/s`],
    ['frame', `${Math.round(i.stats.frameBytes / 1024)} KB`],
    ['sent', i.stats.width > 0 ? `${i.stats.width}×${i.stats.height}` : dash],
    ['source', i.stats.sourceWidth > 0 ? `${i.stats.sourceWidth}×${i.stats.sourceHeight}` : dash],
    ['ping', ping],
    ['zoom', zoom],
  ];
}

/**
 * The line under the quality picker describing what is actually being sent.
 *
 * The JPEG wording ("1024px wide at quality 50, up to 12 fps") describes knobs
 * H.264 does not have, and the frame-rate ceiling it quotes is the one the
 * JPEG path was limited to precisely because every frame cost full price. Left
 * unchanged it would tell someone watching 60fps video that they are getting 12.
 */
export function qualityDescription(quality: QualityPreset, bwpLive: boolean): string {
  if (bwpLive) {
    return (
      `H.264 up to ${quality.bwpFps} fps, capped at the ${quality.bwpPreset} bitrate. ` +
      'The host sends full resolution and only what changed, so sharpness no longer costs frame rate.'
    );
  }
  return (
    `Sending ${quality.w}px wide at quality ${quality.q}, up to ${quality.fps} fps. ` +
    'Applied to the running stream — no reconnect.'
  );
}

/** The live "Now: ..." line under the quality picker. */
export function nowLine(i: HudInputs): string {
  const ping = i.pingMs === null ? dash : `${i.pingMs} ms`;
  if (isBwpLive(i)) {
    if (!i.bwp) return `Now: starting H.264 · ping ${ping}`;
    return `Now: ${Math.round(i.bwp.fps)} fps · ${Math.round(i.bwp.kbps)} kbps · ping ${ping}`;
  }
  return `Now: ${i.stats.fps} fps · ${i.stats.kbps} KB/s · ping ${ping}`;
}

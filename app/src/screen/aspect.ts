// The remote desktop's aspect ratio, from the best source currently known.
//
// The stage is sized to this so the picture fills it exactly and touch
// coordinates map straight through. Precedence matters: H.264 (BWP) never
// fills the JPEG stats counters, so the offer's own size must come first —
// otherwise a secondary monitor or a scaled capture is drawn at the primary
// monitor's shape, letterboxed and with every tap landing off target.

import type { ScreenInfo } from '../api';
import type { StreamStats } from './stream';

export interface RemoteSize {
  readonly width: number;
  readonly height: number;
}

const DEFAULT_ASPECT = 16 / 9;

const ratio = (w: number, h: number): number | null => (w > 0 && h > 0 ? w / h : null);

export const aspectOf = (stats: StreamStats, info: ScreenInfo | null, bwp?: RemoteSize): number =>
  ratio(bwp?.width ?? 0, bwp?.height ?? 0)
  ?? ratio(stats.sourceWidth, stats.sourceHeight)
  ?? ratio(stats.width, stats.height)
  ?? ratio(info?.primary?.W ?? 0, info?.primary?.H ?? 0)
  ?? DEFAULT_ASPECT;

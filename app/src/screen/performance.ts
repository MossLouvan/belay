import type { QualityPreset } from './model';
export interface StreamSettings {
  readonly fps: number;
  readonly bitrateMbps: number;
  readonly audioEnabled: boolean;
  readonly codec: 'h264';
}
export function performanceQuality(base: QualityPreset, settings: StreamSettings | null): QualityPreset {
  if (!settings) return base;
  const fps = [30, 60, 120].includes(settings.fps) ? settings.fps : 60;
  const preset = new Map<number, QualityPreset['bwpPreset']>([[0,'auto'],[1.5,'data-saver'],[4,'balanced'],[10,'high'],[20,'max']]).get(settings.bitrateMbps) ?? 'auto';
  return { ...base, fps: Math.min(30, fps), bwpFps: fps, bwpPreset: preset };
}

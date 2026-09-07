import type { QualityPreset } from '../screen/model';
export type PresetId = 'generic' | 'roblox' | 'fortnite';
export type LayoutChoice = 'classic' | 'southpaw';
export const PRESETS = Object.freeze([
  Object.freeze({ id: 'generic', label: 'Generic', hint: 'Standard Xbox controls. Keyboard fallback uses WASD and mouse aim.' }),
  Object.freeze({ id: 'roblox', label: 'Roblox', hint: 'Keyboard fallback: R3 toggles Shift-lock.' }),
  Object.freeze({ id: 'fortnite', label: 'Fortnite', hint: 'Keyboard fallback: D-pad selects build pieces; Build and Edit use G and F.' }),
] as const);
export function presetOf(raw: unknown) { return PRESETS.find(p => p.id === raw) ?? PRESETS[0]; }
export function layoutChoice(raw: unknown): LayoutChoice { return raw === 'southpaw' ? raw : 'classic'; }
/** Prefer clear 60 Hz motion; high refresh remains an explicit choice. */
export function gamingQuality(path: string | null): QualityPreset {
  return { id: 'performance', label: 'Gaming', w: 1600, q: 65, fps: 30, hint: 'Clear motion at 60 fps with H.264; JPEG fallback targets 30 fps', bwpPreset: 'max', bwpFps: 60 };
}

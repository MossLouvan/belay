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
/** JPEG tops out at the legal CPU preset (30); GPU matches Ultra's 120 ceiling.
 * Width stays moderate. Existing JPEG presentation replaces frames, without a queue. */
export function gamingQuality(path: string | null): QualityPreset {
  return { id: 'smooth', label: 'Gaming', w: 1024, q: 35, fps: 30, hint: 'Lowest latency', bwpPreset: 'data-saver', bwpFps: path === 'gpu' ? 120 : 60 };
}

export type ControllerKind = 'dualsense' | 'dualshock' | 'xbox' | 'generic';
export type GlyphStyle = 'auto' | 'playstation';
export function kindOf(raw: unknown): ControllerKind {
  return raw === 'dualsense' || raw === 'dualshock' || raw === 'xbox' ? raw : 'generic';
}
export function glyphStyleOf(raw: unknown): GlyphStyle { return raw === 'playstation' ? raw : 'auto'; }
const XBOX = Object.freeze({ a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', start: 'Start', select: 'Back' });
const SONY = Object.freeze({ a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', start: 'Options', select: 'Create' });
export type ControllerLabels = Readonly<Record<keyof typeof XBOX, string>>;
export function labelsFor(kind: ControllerKind, style: GlyphStyle): ControllerLabels {
  return kind === 'dualsense' || kind === 'dualshock' || style === 'playstation' ? SONY : XBOX;
}
export function controlLabel(id: string, labels: ControllerLabels): string {
  return id === 'lx' ? 'Move' : id === 'rx' ? 'Look' : Object.hasOwn(labels, id) ? labels[id as keyof ControllerLabels] : id.toUpperCase();
}
/** Widen the two center targets outward so Options/Create remain legible. */
export function glyphLayout(controls: readonly ControlRect[], labels: ControllerLabels, menuWidth: number): readonly ControlRect[] {
  return controls.map(rect => {
    if ((rect.id !== 'start' && rect.id !== 'select') || controlLabel(rect.id, labels).length <= 5) return rect;
    const w = Math.max(rect.w, menuWidth);
    return { ...rect, w, x: rect.id === 'select' ? rect.x - (w - rect.w) : rect.x };
  });
}
import type { ControlRect } from './layout';

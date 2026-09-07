import type { LayoutChoice, PresetId } from './presets';
export interface ControlRect { readonly id: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** Three banks occupy disjoint grid columns. Inputs are the safe-area content box. */
export function gamepadLayout(w: number, h: number, choice: LayoutChoice, preset: PresetId, minTouch: number, gap: number): readonly ControlRect[] {
  if (![w, h, minTouch, gap].every(Number.isFinite) || minTouch < 44 || gap < 0 || w < 10 * minTouch + 4 * gap || h < 6 * minTouch + 4 * gap) return [];
  const size = minTouch, step = size + gap, stick = 2 * size + gap;
  const left = gap, right = w - gap - 3 * step + gap;
  const cell = (id: string, x: number, y: number, width = size, height = size): ControlRect => ({ id, x, y, w: width, h: height });
  const base = [
    cell('lb', left, gap), cell('lt', left + step, gap), cell('l3', left + 2 * step, gap),
    cell('rb', right, gap), cell('rt', right + step, gap), cell('r3', right + 2 * step, gap),
    cell(choice === 'classic' ? 'lx' : 'rx', left, h - gap - stick, stick, stick),
    cell(choice === 'classic' ? 'rx' : 'lx', right + step, h - gap - stick, stick, stick),
    cell('up', left + step, gap + step), cell('left', left, gap + 2 * step), cell('right', left + 2 * step, gap + 2 * step), cell('down', left + step, gap + 3 * step),
    cell('y', right + step, gap + step), cell('x', right, gap + 2 * step), cell('b', right + 2 * step, gap + 2 * step), cell('a', right + step, gap + 3 * step),
    cell('select', w / 2 - size - gap / 2, h - gap - size), cell('start', w / 2 + gap / 2, h - gap - size),
  ];
  // Keep the center's top two rows free for the labelled hold-to-exit HUD.
  return preset === 'fortnite' ? [...base, cell('build', w / 2 - size - gap / 2, gap + 2 * step), cell('edit', w / 2 + gap / 2, gap + 2 * step)] : base;
}
export function stickVector(dx: number, dy: number, radius: number): { readonly x: number; readonly y: number } {
  'worklet';
  if (radius <= 0 || !Number.isFinite(dx) || !Number.isFinite(dy)) return { x: 0, y: 0 };
  const length = Math.hypot(dx, dy); const divisor = Math.max(radius, length);
  return { x: dx / divisor, y: dy === 0 ? 0 : -dy / divisor };
}

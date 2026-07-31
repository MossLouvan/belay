// Fixed-capacity sample history for the System screen sparklines.
//
// Every operation returns a new array — the screen keeps these in React state,
// so mutating in place would silently skip renders.

/** How many samples a sparkline shows. */
export const HISTORY_CAPACITY = 48;

export interface Series {
  readonly cpu: readonly number[];
  readonly mem: readonly number[];
}

export const EMPTY_SERIES: Series = Object.freeze({ cpu: [], mem: [] });

const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
};

/** Appends `next`, dropping the oldest sample once `capacity` is reached. */
export function pushSample(
  values: readonly number[],
  next: number,
  capacity: number = HISTORY_CAPACITY
): readonly number[] {
  const appended = [...values, clampPercent(next)];
  return appended.length <= capacity ? appended : appended.slice(appended.length - capacity);
}

export function pushSeries(series: Series, cpu: number, mem: number): Series {
  return { cpu: pushSample(series.cpu, cpu), mem: pushSample(series.mem, mem) };
}

/** Mean of the samples, for the "avg" readout. Returns null when empty. */
export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total / values.length);
}

/** Highest sample seen in the window. Returns null when empty. */
export function peak(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((highest, value) => (value > highest ? value : highest), 0));
}

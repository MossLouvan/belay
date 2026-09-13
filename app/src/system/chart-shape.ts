// Whether a history series has enough shape to be drawn as a chart.
//
// Its own module rather than a corner of format.ts, which imports the api
// types and so cannot be loaded by the node test runner.

/**
 * Samples needed before the activity chart is a chart.
 *
 * The panel plots one thin column per sample against a fixed 48-slot window
 * and three gridlines. With one or two samples that is 46 empty slots, a ruled
 * grid, and a sliver pinned to the right edge — which does not read as "this
 * has only just started measuring", it reads as a chart that failed to load.
 * Four is the smallest count that draws a shape with a direction in it.
 */
export const CHART_MIN_SAMPLES = 4;

/**
 * Whether a history series has enough shape to plot. Pure and defensive: a
 * missing series, or one padded out with values the host could not measure,
 * is not a chart.
 */
export function chartHasShape(values: readonly number[] | undefined | null): boolean {
  if (!Array.isArray(values)) return false;
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v)).length >= CHART_MIN_SAMPLES;
}

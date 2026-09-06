/** Measured key widths include padding and the 44pt minimum touch target. */
export function layoutDockKeys(widths: readonly number[], available: number, gap: number): number[] {
  if (widths.length === 0) return [];

  // The dock has at most nine keys (256 possible sets of line breaks). Keep
  // reading order, minimize line count, then balance key counts and occupied
  // width. Unlike greedy wrapping, this never leaves an avoidable orphan.
  let best: number[][] = [];
  let bestScore = [Infinity, Infinity, Infinity];
  function visit(start: number, rows: number[][], countScore: number, widthScore: number) {
    if (start === widths.length) {
      const score = [rows.length, countScore, widthScore];
      const difference = score.findIndex((value, i) => value !== bestScore[i]);
      if (difference >= 0 && score[difference] < bestScore[difference]) {
        best = rows;
        bestScore = score;
      }
      return;
    }
    if (rows.length >= bestScore[0]) return;
    let occupied = 0;
    for (let end = start; end < widths.length; end++) {
      occupied += widths[end] + (end > start ? gap : 0);
      // An exceptionally wide key gets its own line, never a smaller box.
      if (occupied > available && end > start) break;
      const row = widths.slice(start, end + 1);
      visit(end + 1, [...rows, row], countScore + row.length ** 2, widthScore + occupied ** 2);
    }
  }
  visit(0, [], 0, 0);

  // Each bank fills the available width. Round DOWN so Yoga's wrapping
  // never moves the last key to another line due to floating-point excess.
  return best.flatMap((row) => {
    const occupied = row.reduce((sum, width) => sum + width, 0) + gap * (row.length - 1);
    const extra = Math.max(0, available - occupied) / row.length;
    return row.map((width) => width + Math.floor(extra * 1000) / 1000);
  });
}

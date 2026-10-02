// Whether the transcript follows the output (#138). Distance from the end
// alone is the wrong signal: new output and a list that just got shorter
// (candidate row, keyboard, rotation) both put the end out of view before the
// rescroll lands, and a scroll event caught in that gap used to drop the
// follow for good. Only the reader moving UP lets go.

/** How close to the bottom still counts as at the end. */
export const FOLLOW_SLACK_PX = 24;

export interface ScrollSample {
  /** Pixels between the viewport's bottom and the content's end. */
  readonly distance: number;
  /** This event's offset, and the previous one's. */
  readonly y: number;
  readonly lastY: number;
}

export function nextFollowing(following: boolean, { distance, y, lastY }: ScrollSample): boolean {
  if (distance <= FOLLOW_SLACK_PX) return true;
  if (y < lastY - 1) return false;
  return following;
}

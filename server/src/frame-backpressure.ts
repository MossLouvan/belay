// Backpressure for the JPEG screen stream (index.ts handleScreen/handleWindow).
//
// ws.send() returns at once and buffers, so a link slower than the capture
// rate grows the socket's write buffer without bound. The loop asks these two
// questions BEFORE capturing: a frame nobody can send yet is 30 ms of host CPU
// for nothing, and a frame that then waits in the buffer is stale on arrival.

/**
 * Send-buffer ceiling in bytes: about two frames at the default width and
 * quality. Lower than the terminal's 256 KB cap on purpose — every byte queued
 * here is glass-to-glass latency on cellular.
 */
export const FRAME_BUFFER_CAP = 64 * 1024;

/** How long to wait before re-checking a backed-up socket. */
export const FRAME_DRAIN_POLL_MS = 10;

/** Whether the next capture should be skipped until the socket drains. */
export function frameBackedUp(bufferedAmount: number): boolean {
  return bufferedAmount > FRAME_BUFFER_CAP;
}

/** At most one decode plus one newest waiting frame. Never paint out of order. */
export function latestFramePainter(decode, paint, release = () => {}) {
  let busy = false, pending = null, closed = false;
  async function run(source) {
    busy = true;
    try {
      const frame = await decode(source);
      try { if (!closed) paint(frame); } finally { frame.close?.(); }
    } catch { /* a corrupt image must not wedge the decoder */ }
    finally {
      release(source); busy = false;
      if (pending !== null && !closed) { const next = pending; pending = null; void run(next); }
    }
  }
  return {
    push(source) {
      if (closed) { release(source); return; }
      if (!busy) { void run(source); return; }
      if (pending !== null) release(pending);
      pending = source;
    },
    close() { closed = true; if (pending !== null) release(pending); pending = null; },
  };
}

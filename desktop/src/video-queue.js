/** Preserve predictive-frame order across brief IPC bursts, with bounded delay. */
export function videoQueue(deliver, requestKeyframe, now = () => performance.now()) {
  let pending = [], inFlight = null, nextId = 0, needKey = true, stopped = false;
  let lastRequest = -Infinity;
  const recover = () => {
    pending = []; needKey = true;
    if (now() - lastRequest >= 250) { lastRequest = now(); requestKeyframe(); }
  };
  const pump = () => {
    if (stopped || inFlight !== null || !pending.length) return;
    if (now() - pending[0].arrived > 50) { recover(); return; }
    const { frame } = pending.shift();
    inFlight = ++nextId;
    deliver({ ...frame, deliveryId: inFlight });
  };
  return {
    push(frame) {
      if (stopped) return;
      if (pending.length >= 2 || (pending.length && now() - pending[0].arrived > 50)) recover();
      if (needKey && !frame.keyframe) return;
      if (frame.keyframe) needKey = false;
      pending.push({ frame, arrived: now() }); pump();
    },
    ack(id) { if (id !== inFlight) return; inFlight = null; pump(); },
    recover,
    close() { stopped = true; pending = []; inFlight = null; },
  };
}

import { socketOrigin } from '../src/url.js';
import { firstPad, kindOf, standardState, encodeFrame, NEUTRAL } from '../src/gamepad-codec.js';
import { emptySender, nextSample, parseMessage, rumbleEffect, controllerLabel } from '../src/gamepad-session.js';

/** DOM/socket adapter. The host arbitrates the single controller lease across windows. */
export function attachGamepad({ host, token, indicator, toggle, onGaming }) {
  let enabled = false, disposed = false, generation = 0, opening = false;
  let socket = null, ready = false, pad = null, backend = 'unavailable', reason = '';
  let sender = emptySender(), retryAt = 0, raf = 0, interval = null;

  function render() {
    const label = !enabled ? 'Controller off · enable Gaming' : document.hidden ? 'Controller paused · return to this window' : reason ? `${controllerLabel(pad ? kindOf(pad.id) : null, backend)} · ${reason}` : controllerLabel(pad ? kindOf(pad.id) : null, backend);
    if (indicator.textContent !== label) indicator.textContent = label;
    indicator.title = reason || (enabled ? 'Press a controller button if no pad appears.' : 'Turn on Gaming to pass this controller to the computer.');
  }
  function rumble(target, low, high) {
    const effect = rumbleEffect(low, high);
    if (!effect) return;
    try { void Promise.resolve(target?.vibrationActuator?.playEffect?.('dual-rumble', effect)).catch(() => {}); }
    catch { /* browser/controller haptics are optional */ }
  }
  function disconnect() {
    generation += 1; opening = false; ready = false;
    const old = socket; socket = null;
    if (old?.readyState === WebSocket.OPEN) {
      try { old.send(encodeFrame(NEUTRAL, sender.seq)); } catch { /* close releases the lease */ }
    }
    old?.close(); rumble(pad, 0, 0); sender = emptySender();
    backend = 'unavailable';
  }
  async function open() {
    opening = true;
    const epoch = generation;
    try {
      const url = new URL(socketOrigin(host) + '/ws/gamepad');
      // Same bearer -> one-shot ticket upgrade as the display stream. The
      // gamepad endpoint is new enough to require tickets; no token URL fallback.
      const response = await fetch(host + '/ws-ticket', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: '{}', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Ticket unavailable');
      const payload = await response.json();
      if (typeof payload?.ticket !== 'string' || !payload.ticket || payload.ticket.length > 4096) throw new Error('Invalid ticket');
      if (disposed || epoch !== generation) return;
      url.searchParams.set('ticket', payload.ticket);
      const ws = new WebSocket(url); socket = ws; sender = emptySender();
      ws.binaryType = 'arraybuffer';
      const attachTimeout = setTimeout(() => { if (!ready) ws.close(); }, 5000);
      ws.addEventListener('message', event => {
        if (socket !== ws) return;
        const message = parseMessage(event.data);
        if (message?.type === 'hello') {
          clearTimeout(attachTimeout);
          ready = message.available; backend = message.backend; reason = message.reason;
          render();
        } else if (message?.type === 'rumble' && ready) rumble(pad, message.low, message.high);
      });
      ws.addEventListener('error', () => ws.close());
      ws.addEventListener('close', () => {
        clearTimeout(attachTimeout);
        if (socket !== ws) return;
        socket = null; ready = false; backend = 'unavailable';
        rumble(pad, 0, 0); retryAt = performance.now() + 1500; render();
      });
    } catch {
      if (epoch === generation) { reason = 'Controller connection failed; retrying'; retryAt = performance.now() + 1500; }
    } finally { if (epoch === generation) opening = false; }
  }
  function poll() {
    if (disposed) return;
    // Chromium stops sampling hidden pages. Repeating its cached snapshot
    // would keep movement/fire held indefinitely even after physical release.
    if (document.hidden) { if (socket || opening) disconnect(); render(); return; }
    let next = null;
    try {
      if (!navigator.getGamepads) reason = 'Controller API unavailable in this browser';
      next = firstPad(navigator.getGamepads?.());
    } catch { reason = 'Controller access blocked by this page’s permissions'; }
    if (next?.index !== pad?.index || next?.id !== pad?.id) {
      disconnect(); retryAt = 0; reason = ''; pad = next;
    } else pad = next;
    const sample = standardState(pad);
    if (pad && !sample) reason = 'This controller does not expose the browser standard mapping.';
    if (!pad && !reason) reason = 'Connect a controller and press a button in this window';
    render();
    if (!enabled || !sample || !host || !token) {
      if (socket || opening) disconnect();
      return;
    }
    const now = performance.now();
    if (!socket && !opening && now >= retryAt) void open();
    if (!ready || socket?.readyState !== WebSocket.OPEN) return;
    const nextSender = nextSample(sender, sample, now, socket.bufferedAmount);
    if (nextSender === sender) return;
    try { socket.send(encodeFrame(nextSender.sample, sender.seq)); sender = nextSender; }
    catch { socket.close(); }
  }
  function animate() { poll(); if (!disposed && !document.hidden) raf = requestAnimationFrame(animate); }
  function schedule() {
    cancelAnimationFrame(raf); clearInterval(interval); interval = null;
    if (document.hidden) poll();
    else raf = requestAnimationFrame(animate);
  }
  function change() {
    enabled = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? 'Gaming on' : 'Gaming';
    disconnect(); retryAt = 0; reason = '';
    onGaming(enabled); poll();
  }
  function dispose() {
    disposed = true; disconnect(); cancelAnimationFrame(raf); clearInterval(interval);
    document.removeEventListener('visibilitychange', schedule);
    toggle.removeEventListener('click', change);
    window.removeEventListener('beforeunload', dispose);
  }
  toggle.addEventListener('click', change);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('beforeunload', dispose);
  render(); schedule();
  return dispose;
}

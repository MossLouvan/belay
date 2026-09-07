import { SPIN_AT_REST, belugaTransform, isSpinIdle, stepSpin, tapSpin } from '../src/beluga-motion.js';

const MS_PER_SECOND = 1000;

/**
 * DOM adapter for the mascot: an rAF loop drives the idle swim, and clicks
 * (or Enter/Space when focused) wind up the spin. Reduced motion pins the
 * beluga level and ignores taps, exactly as the phone does.
 * @param {HTMLElement} element
 * @returns {() => void} dispose
 */
export function attachBeluga(element) {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let spin = SPIN_AT_REST, last = 0, raf = 0, disposed = false;

  const reduced = () => Boolean(media?.matches);
  const size = () => element.getBoundingClientRect().width || element.clientWidth || 120;

  function frame(now) {
    if (disposed) return;
    const dt = last ? (now - last) / MS_PER_SECOND : 0;
    last = now;
    if (!isSpinIdle(spin)) spin = stepSpin(spin, dt);
    element.style.transform = belugaTransform(spin, now, size(), reduced());
    raf = requestAnimationFrame(frame);
  }
  function tap() {
    if (reduced()) return;
    spin = tapSpin(spin);
  }
  function key(event) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tap(); }
  }
  function visibility() {
    // A hidden window stalls rAF; drop the clock so the first frame back
    // does not integrate the whole absence in one leap.
    if (document.hidden) { cancelAnimationFrame(raf); last = 0; }
    else raf = requestAnimationFrame(frame);
  }

  element.addEventListener('click', tap);
  element.addEventListener('keydown', key);
  document.addEventListener('visibilitychange', visibility);
  raf = requestAnimationFrame(frame);
  return () => {
    disposed = true; cancelAnimationFrame(raf);
    element.removeEventListener('click', tap);
    element.removeEventListener('keydown', key);
    document.removeEventListener('visibilitychange', visibility);
  };
}

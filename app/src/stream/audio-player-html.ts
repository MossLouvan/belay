// The Web Audio scheduler that actually makes sound, as a self-contained HTML
// document loaded into a hidden WKWebView (audio-player.tsx). This is the ONLY
// place a real speaker is touched; everything above it is pure and tested.
//
// It exposes one global, `window.__belayAudio`, that the RN side drives over
// the WebView bridge (injectJavaScript):
//   start()          — create/resume the AudioContext (must follow a user
//                      gesture on iOS; the audio toggle is that gesture) and
//                      arm a fresh playhead.
//   enqueue(b64)     — decode base64 interleaved-Float32 (48 kHz stereo) and
//                      schedule it gaplessly right after the current playhead.
//   silence()        — advance the playhead one 20 ms frame with no audio, so a
//                      concealed gap stays a gap instead of pulling later audio
//                      forward (the jitter buffer decided it was a gap).
//   stop()           — suspend the context (clean teardown on mute/background).
//
// WHY a jump-ahead cushion instead of exact scheduling: the RN 20 ms timer and
// the audio clock drift, and JS timers fire late under load. If the playhead
// falls into the past we would schedule everything "now" and stutter. Landing a
// small cushion (PREBUFFER_S) ahead of currentTime resynchronises with one
// short silence instead of a cascade of glitches. The upstream jitter buffer
// already smooths network jitter; this only guards the local clock.

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_S = 0.02; // 20 ms — one wire frame
const PREBUFFER_S = 0.08; // playhead cushion after (re)start or underrun

/** Built once, at module load, and frozen into the WebView source string. */
export const AUDIO_PLAYER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>
(function () {
  var SAMPLE_RATE = ${SAMPLE_RATE};
  var CHANNELS = ${CHANNELS};
  var FRAME_S = ${FRAME_S};
  var PREBUFFER_S = ${PREBUFFER_S};

  var ctx = null;
  var playhead = 0; // next scheduled start time on the audio clock, in seconds

  function log(msg) {
    // Surface player-side errors to RN's console without ever throwing on a
    // platform where the bridge is missing.
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(String(msg));
      }
    } catch (e) {}
  }

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { log('audio: no AudioContext'); return null; }
      // Ask for the native 48 kHz so no implicit resample runs on every buffer.
      ctx = new Ctor({ sampleRate: SAMPLE_RATE });
    } catch (e) {
      log('audio: ctx create failed ' + e);
      ctx = null;
    }
    return ctx;
  }

  // Keep the playhead at or ahead of the live clock with a small cushion.
  function floor() {
    var now = ctx.currentTime;
    if (playhead < now + FRAME_S) playhead = now + PREBUFFER_S;
    return playhead;
  }

  function decode(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var bytes = new Uint8Array(buf);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    // Interleaved Float32 (L,R,L,R…), little-endian — matches how the RN side
    // laid out Float32Array.buffer. iOS/ARM is little-endian, so this is a
    // straight view with no byte-swap.
    return new Float32Array(buf);
  }

  window.__belayAudio = {
    start: function () {
      var c = ensureCtx();
      if (!c) return;
      // resume() needs a user gesture on iOS; RN calls start() from the audio
      // toggle press, which is that gesture.
      if (c.state === 'suspended' && c.resume) c.resume().catch(function (e) { log('audio: resume ' + e); });
      playhead = c.currentTime + PREBUFFER_S;
    },
    enqueue: function (b64) {
      var c = ensureCtx();
      if (!c) return;
      try {
        var inter = decode(b64);
        var frames = (inter.length / CHANNELS) | 0;
        if (frames <= 0) return;
        var ab = c.createBuffer(CHANNELS, frames, SAMPLE_RATE);
        var L = ab.getChannelData(0);
        var R = ab.getChannelData(1);
        for (var i = 0; i < frames; i++) {
          L[i] = inter[i * 2];
          R[i] = inter[i * 2 + 1];
        }
        var src = c.createBufferSource();
        src.buffer = ab;
        src.connect(c.destination);
        var at = floor();
        src.start(at);
        playhead = at + ab.duration;
      } catch (e) {
        // A malformed frame must never wedge the player — drop it, keep going.
        log('audio: enqueue ' + e);
      }
    },
    silence: function () {
      if (!ctx) return;
      floor();
      playhead += FRAME_S;
    },
    stop: function () {
      if (ctx && ctx.state === 'running' && ctx.suspend) {
        ctx.suspend().catch(function (e) { log('audio: suspend ' + e); });
      }
    },
  };

  log('audio: player ready');
})();
</script></body></html>`;

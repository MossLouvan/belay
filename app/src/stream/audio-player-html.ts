// The Web Audio scheduler that actually makes sound, as a self-contained HTML
// document loaded into a hidden WKWebView (audio-player.tsx). This is the ONLY
// place a real speaker is touched; everything above it is pure and tested.
//
// It exposes one global, `window.__belayAudio`, that the RN side drives over
// the WebView bridge (injectJavaScript):
//   start()          — select the media playback session and create/resume the
//                      AudioContext (the WebView permits autoplay), then
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
  var active = false;
  var generation = 0;
  var sources = [];
  var reportedPlaying = false;
  var resuming = false;
  var nextResumeAt = 0;

  function report(phase, message) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'audio', phase: phase, message: message }));
      }
    } catch (e) {}
  }

  function log(msg) { report('error', String(msg)); }

  function setSession(type) {
    // Web Audio defaults to ambient on iOS, which obeys the Silent switch.
    // iOS 17+ exposes this supported way to request audible media playback.
    try {
      if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = type;
    } catch (e) { log('Could not configure system audio playback: ' + e); }
  }

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { log('audio: no AudioContext'); return null; }
      // Ask for the native 48 kHz so no implicit resample runs on every buffer.
      ctx = new Ctor({ sampleRate: SAMPLE_RATE });
      ctx.onstatechange = function () {
        if (!active) return;
        if (ctx.state === 'running') playhead = ctx.currentTime + PREBUFFER_S;
        else resumeCtx();
      };
    } catch (e) {
      log('audio: ctx create failed ' + e);
      ctx = null;
    }
    return ctx;
  }

  function discardSources() {
    var stale = sources;
    sources = [];
    stale.forEach(function (source) {
      try { source.stop(); source.disconnect(); } catch (e) {}
    });
  }

  // iOS can interrupt an already running context without changing AppState or
  // closing the socket. Recover on statechange and on incoming frames (WebKit
  // does not always emit the event). Never accumulate audio while interrupted.
  function resumeCtx() {
    var c = ctx;
    if (!active || !c || c.state === 'running' || c.state === 'closed') return;
    discardSources();
    reportedPlaying = false;
    playhead = c.currentTime + PREBUFFER_S;
    if (resuming || Date.now() < nextResumeAt || !c.resume) return;
    resuming = true;
    nextResumeAt = Date.now() + 1000;
    var run = generation;
    setSession('playback');
    c.resume().then(function () {
      resuming = false;
      if (!active && generation !== run && c.suspend) return c.suspend();
      if (c.state === 'running') nextResumeAt = 0;
    }).catch(function (e) {
      resuming = false;
      if (active && generation === run) log('Could not start system audio: ' + e);
    });
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
      active = true;
      reportedPlaying = false;
      ++generation;
      nextResumeAt = 0;
      setSession('playback');
      var c = ensureCtx();
      if (!c) return;
      resumeCtx();
      playhead = c.currentTime + PREBUFFER_S;
    },
    enqueue: function (b64) {
      var c = ctx;
      if (!active || !c) return;
      if (c.state !== 'running') { resumeCtx(); return; }
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
        sources.push(src);
        src.onended = function () {
          var index = sources.indexOf(src);
          if (index >= 0) sources.splice(index, 1);
          src.disconnect();
        };
        var at = floor();
        src.start(at);
        playhead = at + ab.duration;
        if (!reportedPlaying) { reportedPlaying = true; report('playing'); }
      } catch (e) {
        // A malformed frame must never wedge the player — drop it, keep going.
        log('audio: enqueue ' + e);
      }
    },
    silence: function () {
      if (!active || !ctx) return;
      if (ctx.state !== 'running') { resumeCtx(); return; }
      floor();
      playhead += FRAME_S;
    },
    stop: function () {
      active = false;
      generation += 1;
      discardSources();
      if (ctx && ctx.state !== 'closed' && ctx.suspend) {
        ctx.suspend().catch(function (e) { log('audio: suspend ' + e); });
      }
      setSession('auto');
    },
  };

  report('ready');
})();
</script></body></html>`;

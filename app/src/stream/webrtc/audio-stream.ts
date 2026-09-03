// The push-stream contract: how encoded audio frames enter and leave a
// transport. The transport itself is injected as a plain byte callback, so the
// exact same pair of classes rides the interim /ws/audio binary WebSocket
// today and the `audio` RTCDataChannel (channels.ts) when the libdatachannel
// peer exists — and runs fully under `node --test` with a loopback function in
// between meanwhile.
//
// AudioSender: give it encoded packets in capture order; it stamps seq +
// timestamp and frames them (audio-frames.ts). AudioReceiver: give it whatever
// bytes the transport delivers, in whatever order; it validates, feeds the
// jitter buffer (audio-jitter.ts), and answers each playout tick with exactly
// one of play / conceal / wait.

import {
  AUDIO_SAMPLES_PER_FRAME,
  decodeAudioFrame,
  encodeAudioFrame,
  nextSeq,
  type AudioCodec,
} from './audio-frames.ts';
import {
  DEFAULT_JITTER_CONFIG,
  bufferedDepth,
  createJitterState,
  insertFrame,
  popFrame,
  targetDelayMs,
  type JitterConfig,
  type JitterState,
  type JitterStats,
  type PopAction,
} from './audio-jitter.ts';

/** Where outbound wire frames go: ws.send, dataChannel.send, or a test spy. */
export type AudioByteSink = (bytes: Uint8Array) => void;

export interface AudioSenderStats {
  readonly framesSent: number;
  readonly bytesSent: number;
}

/**
 * Stamps and frames outbound packets. One instance per capture session — a new
 * session starts a new sender, whose fresh random-ish seq base is what lets the
 * receiver's reset heuristic tell "restart" from "loss".
 */
export class AudioSender {
  // Plain fields, not TS parameter properties: these modules run under Node's
  // type stripping in tests, which does not support parameter properties.
  private readonly sink: AudioByteSink;
  private readonly codec: AudioCodec;
  private seq: number;
  private timestamp = 0;
  private framesSent = 0;
  private bytesSent = 0;

  constructor(sink: AudioByteSink, codec: AudioCodec, initialSeq = 0) {
    this.sink = sink;
    this.codec = codec;
    this.seq = initialSeq & 0xffff;
  }

  /** One encoded packet, `samples` samples long at 48 kHz (960 = 20 ms). */
  pushEncodedFrame(payload: Uint8Array, samples: number = AUDIO_SAMPLES_PER_FRAME): void {
    const bytes = encodeAudioFrame({
      seq: this.seq,
      timestamp: this.timestamp,
      codec: this.codec,
      payload,
    });
    this.seq = nextSeq(this.seq);
    this.timestamp = (this.timestamp + samples) >>> 0; // wraps at u32 like RTP
    this.framesSent += 1;
    this.bytesSent += bytes.length;
    this.sink(bytes);
  }

  get stats(): AudioSenderStats {
    return { framesSent: this.framesSent, bytesSent: this.bytesSent };
  }
}

export interface AudioReceiverStats extends JitterStats {
  readonly malformed: number;
  readonly bufferedFrames: number;
  readonly targetDelayMs: number;
}

/**
 * Validates inbound bytes and drives the jitter policy. The playback loop calls
 * `tick()` every AUDIO_FRAME_MS and acts on the single answer it gets back; all
 * ordering/loss/latency decisions live in the pure policy underneath.
 */
export class AudioReceiver {
  private jitter: JitterState;
  private malformed = 0;

  constructor(config: JitterConfig = DEFAULT_JITTER_CONFIG) {
    this.jitter = createJitterState(config);
  }

  /** Bytes arrived from the transport. Returns what happened, for telemetry. */
  onWireBytes(bytes: Uint8Array, nowMs: number): 'buffered' | 'duplicate' | 'late' | 'reset' | 'malformed' {
    const decoded = decodeAudioFrame(bytes);
    if (!decoded.ok) {
      this.malformed += 1;
      return 'malformed';
    }
    const { state, verdict } = insertFrame(this.jitter, decoded.frame, nowMs);
    this.jitter = state;
    return verdict;
  }

  /** One playout tick: play / conceal / wait. */
  tick(): PopAction {
    const { state, action } = popFrame(this.jitter);
    this.jitter = state;
    return action;
  }

  get stats(): AudioReceiverStats {
    return {
      ...this.jitter.stats,
      malformed: this.malformed,
      bufferedFrames: bufferedDepth(this.jitter),
      targetDelayMs: targetDelayMs(this.jitter),
    };
  }
}

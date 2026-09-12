// One audio subscription owns its socket and retry timer. A new socket needs a
// fresh ticket and jitter receiver; disposal also invalidates in-flight tickets.
import type { AudioSupport } from './audio-capability';

export interface HostAudioStatus {
  readonly phase: 'off' | 'connecting' | 'playing' | 'error';
  readonly message?: string;
  /** What to do about it, when the host told us. Shown under the message. */
  readonly hint?: string;
  /** Fault class, for UI too small to print a sentence. See audio-capability. */
  readonly kind?: string;
}

type AudioSocket = Pick<WebSocket, 'binaryType' | 'readyState' | 'close' | 'onmessage' | 'onerror' | 'onclose'>;

interface AudioConnectionOptions {
  /**
   * Ask the host whether it can do audio at all, before opening a socket.
   *
   * Without this, a host with no /ws/audio route (one whose Belay server
   * predates system audio) failed at the upgrade and reconnected forever behind
   * the words "connection lost" — a transient-sounding message for a permanent
   * condition the user could actually fix. A definite "no" is terminal here:
   * retrying cannot change a host's installed software.
   */
  readonly probeSupport?: () => Promise<AudioSupport>;
  readonly getUrl: () => Promise<string>;
  readonly createSocket: (url: string) => AudioSocket;
  readonly isUnauthorized: (error: unknown) => boolean;
  readonly onReset: () => void;
  readonly onBytes: (bytes: Uint8Array) => void;
  readonly onStatus: (status: HostAudioStatus) => void;
  readonly schedule?: typeof setTimeout;
  readonly cancel?: typeof clearTimeout;
}

export function connectHostAudio(options: AudioConnectionOptions): () => void {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let disposed = false;
  let socket: AudioSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  const retryLater = (): void => {
    if (disposed || retry !== undefined) return;
    const delay = Math.min(1000 * 2 ** Math.min(attempts++, 3), 5000);
    retry = schedule(() => { retry = undefined; void open(); }, delay);
  };

  const open = async (): Promise<void> => {
    if (disposed) return;
    options.onStatus({ phase: 'connecting' });
    try {
      if (options.probeSupport) {
        const support = await options.probeSupport();
        if (disposed) return;
        // Only a DEFINITE refusal is terminal. 'unreachable' means we could not
        // ask — that is a network blip, and blips are what retries are for.
        if (!support.supported && support.kind !== 'unreachable') {
          options.onStatus({ phase: 'error', message: support.message, hint: support.hint, kind: support.kind });
          return;
        }
      }
      const url = await options.getUrl();
      if (disposed) return;
      const ws = options.createSocket(url);
      socket = ws;
      ws.binaryType = 'arraybuffer';
      options.onReset();
      let reportedError = false;
      const current = (): boolean => !disposed && socket === ws;
      ws.onmessage = ({ data }): void => {
        if (!current()) return;
        if (data instanceof ArrayBuffer) {
          attempts = 0;
          options.onBytes(new Uint8Array(data));
        } else if (typeof data === 'string') {
          try {
            const message: unknown = JSON.parse(data);
            if (message && typeof message === 'object' && 'type' in message && message.type === 'error'
              && 'error' in message && typeof message.error === 'string') {
              reportedError = true;
              // `hint` and `kind` are optional and only present from a host new
              // enough to classify its own failure; spread so an older host's
              // bare {type,error} still produces exactly the same status shape.
              const hint = 'hint' in message && typeof message.hint === 'string' && message.hint ? { hint: message.hint } : {};
              const kind = 'kind' in message && typeof message.kind === 'string' && message.kind ? { kind: message.kind } : {};
              options.onStatus({ phase: 'error', message: message.error, ...hint, ...kind });
            }
          } catch { /* Ignore malformed control messages. */ }
        }
      };
      ws.onclose = (): void => {
        if (!current()) return;
        socket = null;
        if (!reportedError) options.onStatus({ phase: 'connecting', message: 'Reconnecting system audio…' });
        retryLater();
      };
      ws.onerror = (): void => {
        if (!current()) return;
        options.onStatus({ phase: 'error', message: 'System audio connection lost. Reconnecting…' });
        socket = null;
        try { ws.close(); } catch { /* Already closed. */ }
        retryLater();
      };
    } catch (error: unknown) {
      if (disposed) return;
      options.onStatus({ phase: 'error', message: error instanceof Error ? error.message : 'System audio connection failed.' });
      if (!options.isUnauthorized(error)) retryLater();
    }
  };

  void open();
  return () => {
    disposed = true;
    if (retry !== undefined) cancel(retry);
    if (socket && socket.readyState <= 1) {
      try { socket.close(); } catch { /* Already closed. */ }
    }
    socket = null;
  };
}

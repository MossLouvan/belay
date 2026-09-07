// One audio subscription owns its socket and retry timer. A new socket needs a
// fresh ticket and jitter receiver; disposal also invalidates in-flight tickets.
export interface HostAudioStatus {
  readonly phase: 'off' | 'connecting' | 'playing' | 'error';
  readonly message?: string;
}

type AudioSocket = Pick<WebSocket, 'binaryType' | 'readyState' | 'close' | 'onmessage' | 'onerror' | 'onclose'>;

interface AudioConnectionOptions {
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
              options.onStatus({ phase: 'error', message: message.error });
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

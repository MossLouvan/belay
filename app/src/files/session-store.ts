// The Files session, held at module level and keyed on the host — the Files
// twin of src/terminal/session-store.ts (#90). The bottom bar unmounts the
// Files route on every tab switch; when the folder, history and open viewer
// lived in its state, every round trip to the Terminal restarted at Home
// (#141). The route reads its starting point from here and writes back as it
// moves. A different host starts fresh.

import type { FileEntry } from '../api';
import type { OpenFile } from '../files-viewer';
import { emptyHistory } from './history.ts';
import type { NavHistory } from './history.ts';

export interface FilesSession {
  readonly path: string;
  readonly entries: readonly FileEntry[];
  readonly history: NavHistory;
  readonly viewer: OpenFile | null;
  /** The list's offset, and the folder it belongs to — a stale offset must
      never be applied to a different folder. */
  readonly scroll: { readonly path: string; readonly y: number };
  /** When `entries` were read, for the "as of" stamp; 0 = never. */
  readonly asOf: number;
}

const EMPTY: FilesSession = Object.freeze({ path: '', entries: [], history: emptyHistory, viewer: null, scroll: { path: '', y: 0 }, asOf: 0 });

let key: unknown = null;
let session: FilesSession = EMPTY;

export function getFilesSession(host: unknown): FilesSession {
  return host === key ? session : EMPTY;
}

export function saveFilesSession(host: unknown, patch: Partial<FilesSession>): void {
  const base = host === key ? session : EMPTY;
  key = host;
  session = Object.freeze({ ...base, ...patch });
}

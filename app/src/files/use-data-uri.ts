// Shared loading state for viewers that fetch a file's bytes as a data URI.
// The fetch is aborted on unmount — closing the viewer mid-download must
// actually cancel the transfer, not leave it filling memory in the background.

import { useEffect, useState } from 'react';
import { fetchDataUri } from '../api';
import { messageOf } from '../files-format';

export interface DataUriState {
  readonly uri: string | null;
  readonly error: string;
  readonly loading: boolean;
}

export function useDataUri(path: string, enabled: boolean = true): DataUriState {
  const [state, setState] = useState<DataUriState>({ uri: null, error: '', loading: enabled });

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setState({ uri: null, error: '', loading: true });
    fetchDataUri(path, controller.signal)
      .then((uri) => {
        if (!controller.signal.aborted) setState({ uri, error: '', loading: false });
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setState({ uri: null, error: messageOf(e), loading: false });
      });
    return () => controller.abort();
  }, [path, enabled]);

  return state;
}

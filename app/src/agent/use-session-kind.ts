// Which kind a session id is, resolved before anything is drawn for it.
//
// The attention store already polls `/agent/sessions`, so the answer is
// usually in hand the moment a row is tapped and nothing is fetched at all.
// The fetch is the fallback for the two cases the store cannot cover: a deep
// link straight into a session, and a session created a moment ago that the
// next poll has not returned yet.
//
// `null` while unresolved is load-bearing. Guessing 'stream' would draw the
// structured feed over a live terminal — an empty history where a running
// session should be — and guessing 'pty' would attach to something that has no
// pty behind it.

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentSessionKind, AgentSessionMeta } from '../api';
import { useAgentAttention } from './attention-store';
import { sessionKind } from './session-kind';

export interface ResolvedKind {
  /** null until the host has said, one way or the other. */
  readonly kind: AgentSessionKind | null;
  /** What the list knows about it, for a title and a cwd before the socket opens. */
  readonly meta: AgentSessionMeta | null;
  /** Why it is still null, when the reason is a failure rather than a wait. */
  readonly error: string;
}

export function useSessionKind(id: string): ResolvedKind {
  const { sessions } = useAgentAttention();
  const known = sessions?.find((s) => s.id === id) ?? null;
  const [fetched, setFetched] = useState<AgentSessionMeta | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setFetched(null);
    setError('');
  }, [id]);

  useEffect(() => {
    if (!id || known) return undefined;
    let live = true;
    api.agentSnapshot(id)
      .then((snap) => { if (live) setFetched(snap); })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'could not read the session');
      });
    return () => { live = false; };
  }, [id, known]);

  const meta = known ?? fetched;
  return { kind: meta ? sessionKind(meta) : null, meta, error };
}

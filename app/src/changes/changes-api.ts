// The "what changed" request, colocated with the feature rather than added to
// api.ts: the route's response shape lives and evolves with this screen, and
// api.ts's private fetch helpers are not exported. The transport rules are
// the same ones api.ts documents — bearer header, hard deadline, abort not
// abandon — so a stalled host still surfaces as "didn't answer" here.

import { getConnection, REQUEST_TIMEOUT_MS, TimeoutError, UnauthorizedError } from '../api';

/** One changed file. Mirrors ChangedFile in server/src/changes-summary.ts. */
export interface ChangedFile {
  readonly path: string;
  readonly kind: 'new' | 'edited' | 'deleted' | 'renamed';
  readonly from?: string;
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

export interface ChangeSummary {
  readonly headline: string;
  readonly cautions: readonly string[];
}

/** Mirrors ProjectChanges in server/src/changes.ts. */
export interface ProjectChanges {
  readonly repo: boolean;
  readonly clean: boolean;
  readonly summary: ChangeSummary;
  readonly files: readonly ChangedFile[];
  readonly diff: string;
  readonly diffTruncated: boolean;
}

export async function fetchChanges(sessionId: string): Promise<ProjectChanges> {
  const conn = getConnection();
  if (!conn) throw new Error('not connected');
  const path = `/agent/sessions/${encodeURIComponent(sessionId)}/changes`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(conn.host + path, {
      headers: { Authorization: `Bearer ${conn.token}` },
      signal: controller.signal,
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') throw new TimeoutError(path);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw new UnauthorizedError();
  const body = (await res.json().catch(() => ({}))) as Partial<ProjectChanges> & { error?: string };
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);

  // The host is trusted but versions drift: default every field so a newer
  // app against an older host degrades to an honest empty view, not a crash.
  return {
    repo: body.repo === true,
    clean: body.clean === true,
    summary: {
      headline: body.summary?.headline ?? '',
      cautions: Array.isArray(body.summary?.cautions) ? body.summary.cautions : [],
    },
    files: Array.isArray(body.files) ? body.files : [],
    diff: typeof body.diff === 'string' ? body.diff : '',
    diffTruncated: body.diffTruncated === true,
  };
}

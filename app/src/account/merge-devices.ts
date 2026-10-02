// The computers list is two sources: computers paired on this phone (the
// device store) and computers linked to the account (GET /devices). A machine
// in both is one card; a machine only on the account is "linked, not yet
// paired on this phone" — it becomes reachable once the tunnel FFI lands and
// pairs over it. The phone's own registration (kind 'phone') is never a row.
// Pure, tested in gate.test.mjs.

import type { AccountDevice } from './api.ts';
import type { SavedDevice } from '../devices/model.ts';

export interface MergedComputers {
  readonly local: readonly SavedDevice[];
  readonly linkedOnly: readonly AccountDevice[];
}

export function mergeComputers(
  local: readonly SavedDevice[],
  remote: readonly AccountDevice[],
): MergedComputers {
  const localNodes = new Set(local.map((d) => d.nodeId).filter((n): n is string => Boolean(n)));
  return {
    local,
    linkedOnly: remote.filter((d) => d.kind !== 'phone' && !localNodes.has(d.nodeId)),
  };
}

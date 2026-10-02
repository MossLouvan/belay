// What POST /devices has been told about this phone: the account's device id
// and the node id it was registered under. Stored together so a changed node
// id (the stub's random placeholder giving way to the real FFI key) triggers
// a re-registration instead of leaving the account pointing at a node that
// does not exist. Pure; tested in phone-registration.test.mjs.

import { isNodeId } from './tunnel-key.ts';

export interface PhoneRegistration {
  readonly id: string;
  readonly nodeId: string;
}

/** The stub era stored a bare device id; that (and anything else malformed) reads as unregistered. */
export function parsePhoneRegistration(raw: string | null): PhoneRegistration | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value?.id !== 'string' || !value.id || !isNodeId(value.nodeId)) return null;
    return { id: value.id, nodeId: value.nodeId };
  } catch {
    return null;
  }
}

export const serializePhoneRegistration = (r: PhoneRegistration): string => JSON.stringify(r);

export function registrationNeeded(stored: PhoneRegistration | null, nodeId: string): boolean {
  return stored === null || stored.nodeId !== nodeId;
}

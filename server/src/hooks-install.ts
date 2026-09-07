// Merging Belay's hook entries into ~/.claude/settings.json — and taking
// them out again — without touching anything else in that file. Pure: the
// CLI (hooks-install-cli.ts) reads and writes the file; this file only
// decides what the new document is and what changed.
//
// A Belay entry is recognised by the script it runs, never by position, so
// re-running install after the port or the repo path moved replaces the old
// entry instead of stacking a second one; and a user's own hooks in the same
// event, even in the same matcher group, are carried through untouched.
//
// The entries themselves follow the hooks reference verbatim (exec form with
// `args`, `timeout` in seconds, `statusMessage`, `async`) — the contract is
// written up with URLs in docs/AGENT-HOOKS.md.

import { HOOK_EVENTS } from './hooks-validate.js';

/** Recognises our own entry, whatever else changed about it. */
export const HOOK_SCRIPT_NAME = 'belay-hook.mjs';

/**
 * Seconds Claude Code allows the PermissionRequest hook before cancelling
 * it — the ceiling for the host's BELAY_HOOK_WAIT_MS. Well above the host's
 * default wait; the host, not this timeout, ends every normal wait.
 */
export const PERMISSION_HOOK_TIMEOUT_S = 600;
const SIDE_HOOK_TIMEOUT_S = 15;
export const PERMISSION_STATUS_MESSAGE = 'Belay: waiting for your phone';

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };
export type JsonObject = { readonly [k: string]: Json };

export interface HookEntry {
  readonly type: 'command';
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
  readonly statusMessage?: string;
  readonly async?: boolean;
}

export interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookEntry[];
}

export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface InstallOptions {
  /** Absolute path to hooks/belay-hook.mjs. */
  readonly scriptPath: string;
  readonly port: number;
  /** The executable to spawn; process.execPath in the CLI, `node` in docs. */
  readonly node?: string;
}

export interface MergeResult {
  readonly settings: JsonObject;
  /** Human lines: "PermissionRequest: added", "Stop: replaced", "Notification: unchanged". */
  readonly changes: readonly string[];
  readonly changed: boolean;
}

/** The four groups install writes, one per event. */
export function belayHookGroups(opts: InstallOptions): Readonly<Record<HookEventName, HookGroup>> {
  const command = opts.node ?? 'node';
  const args = [opts.scriptPath, '--port', String(opts.port)];
  const side: HookEntry = { type: 'command', command, args, timeout: SIDE_HOOK_TIMEOUT_S, async: true };
  return {
    PermissionRequest: {
      hooks: [{ type: 'command', command, args, timeout: PERMISSION_HOOK_TIMEOUT_S, statusMessage: PERMISSION_STATUS_MESSAGE }],
    },
    // Only the "a prompt has been waiting" type is useful; the matcher keeps
    // auth/idle/elicitation chatter from spawning a process at all.
    Notification: { matcher: 'permission_prompt', hooks: [side] },
    Stop: { hooks: [side] },
    SessionStart: { hooks: [side] },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True for a hook entry that runs our script, in exec or shell form. */
export function isBelayHook(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const haystack = [entry.command, ...args].filter((x): x is string => typeof x === 'string');
  return haystack.some((s) => s.includes(HOOK_SCRIPT_NAME));
}

/** Strip our entries from one event's groups; groups left empty disappear. */
function withoutBelay(groups: unknown): readonly Json[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g): Json[] => {
    if (!isObject(g) || !Array.isArray(g.hooks)) return [g as Json];
    const hooks = g.hooks.filter((h) => !isBelayHook(h));
    if (hooks.length === 0) return [];
    return [{ ...(g as JsonObject), hooks: hooks as Json[] }];
  });
}

function hasBelay(groups: unknown): boolean {
  return Array.isArray(groups) && groups.some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isBelayHook));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Add (or refresh) Belay's entries. Everything else in `settings` survives byte-for-byte. */
export function mergeHooks(settings: JsonObject, opts: InstallOptions): MergeResult {
  const groups = belayHookGroups(opts);
  const existing = isObject(settings.hooks) ? settings.hooks : {};
  const nextHooks: Record<string, Json> = { ...(existing as JsonObject) };
  const changes: string[] = [];
  for (const event of HOOK_EVENTS) {
    const before = existing[event];
    const kept = withoutBelay(before);
    const after = [...kept, groups[event] as unknown as Json];
    if (same(before, after)) { changes.push(`${event}: unchanged`); continue; }
    changes.push(`${event}: ${hasBelay(before) ? 'replaced' : 'added'}`);
    nextHooks[event] = after;
  }
  const changed = changes.some((c) => !c.endsWith('unchanged'));
  return { settings: changed ? { ...settings, hooks: nextHooks } : settings, changes, changed };
}

/** Take Belay's entries out. An event, or `hooks` itself, left empty is removed. */
export function removeHooks(settings: JsonObject): MergeResult {
  const existing = isObject(settings.hooks) ? settings.hooks : {};
  const nextHooks: Record<string, Json> = { ...(existing as JsonObject) };
  const changes: string[] = [];
  for (const event of HOOK_EVENTS) {
    const before = existing[event];
    if (!hasBelay(before)) { changes.push(`${event}: nothing to remove`); continue; }
    const kept = withoutBelay(before);
    if (kept.length === 0) delete nextHooks[event]; else nextHooks[event] = kept;
    changes.push(`${event}: removed`);
  }
  const changed = changes.some((c) => c.endsWith('removed'));
  if (!changed) return { settings, changes, changed };
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _hooks, ...rest } = settings;
    return { settings: rest, changes, changed };
  }
  return { settings: { ...settings, hooks: nextHooks }, changes, changed };
}

/** Which of our events a settings document carries — the banner's answer. */
export function installedEvents(settings: unknown): readonly HookEventName[] {
  if (!isObject(settings) || !isObject(settings.hooks)) return [];
  const hooks = settings.hooks;
  return HOOK_EVENTS.filter((e) => hasBelay(hooks[e]));
}

/** "hooks installed (4 events)" / "hooks not installed — npm run hooks:install" / partial. */
export function hooksStatusLine(settings: unknown): string {
  const events = installedEvents(settings);
  if (events.length === HOOK_EVENTS.length) return `installed in ~/.claude/settings.json (${events.length} events) · terminal sessions ask the phone`;
  if (events.length === 0) return 'not installed — run `npm run hooks:install` to approve terminal sessions from the phone';
  return `partially installed (${events.join(', ')}) — run \`npm run hooks:install\` to complete`;
}

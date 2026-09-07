// The boundary between Claude Code's hook process and the Belay host. The
// hook script (hooks/belay-hook.mjs) forwards whatever Claude Code put on its
// stdin; this file decides what of that the host will believe. Same shape as
// audio.ts's validateHelperAudioFrame: a discriminated result, never a
// throw, and anything unrecognised fails whole — a payload is either one of
// the four events we handle, fully typed, or it is refused.
//
// Field names and semantics are Claude Code's own, verified against the hooks
// reference (docs/AGENT-HOOKS.md carries the URLs and the exact contract).

/** One `updatedPermissions` / `permission_suggestions` entry, addRules form only. */
export interface PermissionRuleUpdate {
  readonly type: 'addRules';
  readonly rules: readonly { readonly toolName: string; readonly ruleContent?: string }[];
  readonly behavior: 'allow' | 'deny' | 'ask';
  readonly destination: 'session' | 'localSettings' | 'projectSettings' | 'userSettings';
}

interface HookCommon {
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string;
}

export interface PermissionRequestEvent extends HookCommon {
  readonly kind: 'PermissionRequest';
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly suggestions: readonly PermissionRuleUpdate[];
}

export interface NotificationEvent extends HookCommon {
  readonly kind: 'Notification';
  readonly notificationType: string;
  readonly message: string;
  readonly title: string;
}

export interface StopEvent extends HookCommon {
  readonly kind: 'Stop';
  readonly stopHookActive: boolean;
  readonly lastAssistantMessage: string;
}

export interface SessionStartEvent extends HookCommon {
  readonly kind: 'SessionStart';
  readonly source: string;
}

export type HookEvent = PermissionRequestEvent | NotificationEvent | StopEvent | SessionStartEvent;

export type HookPayloadResult =
  | { readonly ok: true; readonly event: HookEvent }
  | { readonly ok: false; readonly error: string };

/** The event names the host handles; the hook config only registers these. */
export const HOOK_EVENTS = ['PermissionRequest', 'Notification', 'Stop', 'SessionStart'] as const;

// Claude Code session ids are UUIDs; anything else is refused rather than
// used as a map key or a path segment.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHORT_CAP = 200;
const MESSAGE_CAP = 600;
const PATH_CAP = 4096;
const TOOL_INPUT_CAP = 256 * 1024;
const DESTINATIONS = new Set(['session', 'localSettings', 'projectSettings', 'userSettings']);
const BEHAVIORS = new Set(['allow', 'deny', 'ask']);

const fail = (error: string): HookPayloadResult => ({ ok: false, error });
const str = (v: unknown, cap: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, cap) : undefined;

function ruleUpdate(v: unknown): PermissionRuleUpdate | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.type !== 'addRules' || !Array.isArray(r.rules)) return null;
  if (typeof r.behavior !== 'string' || !BEHAVIORS.has(r.behavior)) return null;
  if (typeof r.destination !== 'string' || !DESTINATIONS.has(r.destination)) return null;
  const rules: { toolName: string; ruleContent?: string }[] = [];
  for (const rule of r.rules as unknown[]) {
    if (typeof rule !== 'object' || rule === null) return null;
    const { toolName, ruleContent } = rule as Record<string, unknown>;
    if (typeof toolName !== 'string' || !toolName) return null;
    if (ruleContent !== undefined && typeof ruleContent !== 'string') return null;
    rules.push(ruleContent === undefined ? { toolName } : { toolName, ruleContent: ruleContent.slice(0, SHORT_CAP * 5) });
  }
  return {
    type: 'addRules', rules,
    behavior: r.behavior as PermissionRuleUpdate['behavior'],
    destination: r.destination as PermissionRuleUpdate['destination'],
  };
}

/** Malformed entries are dropped, not fatal: a suggestion is a nicety. */
function suggestions(v: unknown): readonly PermissionRuleUpdate[] {
  if (!Array.isArray(v)) return [];
  return v.map(ruleUpdate).filter((s): s is PermissionRuleUpdate => s !== null);
}

/** Validate one hook stdin payload. Never throws. */
export function validateHookPayload(input: unknown): HookPayloadResult {
  if (typeof input !== 'object' || input === null) return fail('hook payload is not an object');
  const p = input as Record<string, unknown>;
  const sessionId = str(p.session_id, 128);
  if (!sessionId || !SESSION_ID.test(sessionId)) return fail('session_id is missing or malformed');
  const cwd = str(p.cwd, PATH_CAP);
  if (cwd === undefined) return fail('cwd must be a string');
  const transcriptPath = str(p.transcript_path, PATH_CAP) ?? '';
  const common = { sessionId, cwd, transcriptPath };

  switch (p.hook_event_name) {
    case 'PermissionRequest': {
      const toolName = str(p.tool_name, SHORT_CAP);
      if (!toolName) return fail('tool_name is required');
      const toolInput = typeof p.tool_input === 'object' && p.tool_input !== null ? p.tool_input : {};
      if (JSON.stringify(toolInput).length > TOOL_INPUT_CAP) return fail('tool_input too large');
      return { ok: true, event: { ...common, kind: 'PermissionRequest', toolName, toolInput, suggestions: suggestions(p.permission_suggestions) } };
    }
    case 'Notification': {
      const notificationType = str(p.notification_type, SHORT_CAP);
      if (!notificationType) return fail('notification_type is required');
      return {
        ok: true,
        event: {
          ...common, kind: 'Notification', notificationType,
          message: str(p.message, MESSAGE_CAP) ?? '', title: str(p.title, SHORT_CAP) ?? '',
        },
      };
    }
    case 'Stop':
      return {
        ok: true,
        event: {
          ...common, kind: 'Stop',
          stopHookActive: p.stop_hook_active === true,
          lastAssistantMessage: str(p.last_assistant_message, MESSAGE_CAP) ?? '',
        },
      };
    case 'SessionStart':
      return { ok: true, event: { ...common, kind: 'SessionStart', source: str(p.source, SHORT_CAP) ?? '' } };
    default:
      return fail(`unsupported hook event: ${String(p.hook_event_name)}`);
  }
}

export type HookDecisionBody =
  | { readonly ok: true; readonly allow: boolean; readonly choiceId: string | undefined }
  | { readonly ok: false; readonly error: string };

/** The phone's POST /agent/hooks/:id/decide body. */
export function validateHookDecisionBody(input: unknown): HookDecisionBody {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'body must be an object' };
  const { allow, choice } = input as Record<string, unknown>;
  if (typeof allow !== 'boolean') return { ok: false, error: 'allow must be true or false' };
  if (choice !== undefined && (typeof choice !== 'string' || choice.length === 0 || choice.length > 64)) {
    return { ok: false, error: 'choice must be a short string' };
  }
  return { ok: true, allow, choiceId: choice as string | undefined };
}

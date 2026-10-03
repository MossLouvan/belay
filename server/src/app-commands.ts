// Commands Belay.app sends this host over the utilityProcess port, and the
// owner check in front of the ones that let a new phone in.
//
// Allow, "Let a phone connect" and "Pair another phone" each run only after
// `authOwner` says the person at this computer proved it is them (macOS: the
// helper's `authowner` verb — Touch ID or the login password, a system prompt
// remote input cannot fake or click through). The check runs here, in the
// host, from its own helper: no message from the app can claim it was done.
// Deny, Remove and sign-in never ask.

export interface OwnerAuth { ok: boolean; error?: string }

export interface AppCommandDeps {
  authOwner(reason: string): Promise<OwnerAuth>;
  decide(pendingId: string, allow: boolean): void;
  openFirstPhone(): void;
  showCode(): void;
  removePhone(tokenPrefix: string): void;
  link(session: unknown): void;
  /** Tells the app how a gated command went, so the window can say "Not approved". */
  reply(result: { type: 'owner-auth'; action: string; ok: boolean; error?: string }): void;
}

/** The reason macOS shows: "Belay is trying to <reason>." */
const REASONS: Record<string, string> = {
  'pair-decide': 'let a new phone use this computer',
  'open-first-phone': 'let a phone connect to this computer',
  'pair-code': 'show a code to pair another phone',
};

export function createAppCommands(deps: AppCommandDeps) {
  let asking = false;

  const gated = async (action: string, run: () => void): Promise<void> => {
    if (asking) { deps.reply({ type: 'owner-auth', action, ok: false, error: 'Already asking for your password.' }); return; }
    asking = true;
    let answer: OwnerAuth;
    try {
      answer = await deps.authOwner(REASONS[action]);
    } catch (e) {
      answer = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      asking = false;
    }
    if (answer?.ok !== true) {
      deps.reply({ type: 'owner-auth', action, ok: false, ...(typeof answer?.error === 'string' ? { error: answer.error } : {}) });
      return;
    }
    run();
    deps.reply({ type: 'owner-auth', action, ok: true });
  };

  return async (message: Record<string, unknown>): Promise<void> => {
    switch (message.type) {
      case 'pair-code': return gated('pair-code', deps.showCode);
      case 'open-first-phone': return gated('open-first-phone', deps.openFirstPhone);
      case 'pair-decide': {
        const { pendingId, allow } = message;
        if (typeof pendingId !== 'string' || typeof allow !== 'boolean') return;
        if (!allow) { deps.decide(pendingId, false); return; }
        return gated('pair-decide', () => deps.decide(pendingId, true));
      }
      case 'device-remove':
        if (typeof message.tokenPrefix === 'string') deps.removePhone(message.tokenPrefix);
        return;
      case 'link-session': deps.link(message.session); return;
    }
  };
}

// The vocabulary of scoped approvals. "Always" used to whitelist a whole
// tool for the session — one tap on "Always Bash" and every future shell
// command ran unasked. Here a grant is instead minted from the exact ask on
// the card, in one of four shapes, each no wider than what the user could
// read at the moment of granting:
//
//   exact-command  this precise shell command, byte for byte
//   exact-file     this one resolved file, for this one tool
//   folder         this tool anywhere under one folder (offered only inside
//                  the project)
//   project-reads  every use of one read-only tool, confined to the project
//
// Pure functions, no state: agent.ts owns which grants a session holds, this
// file owns what a grant *is* and — the part that makes it a security
// boundary — what it does not match. Everything unrecognised fails closed:
// an unknown scope, a missing field, a path that walks out of its folder all
// mean "ask the phone again", never "allow".

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type RiskTier = 'read' | 'edit' | 'run' | 'danger';
export type GrantScope = 'exact-command' | 'exact-file' | 'folder' | 'project-reads';

export interface ApprovalGrant {
  readonly id: string;
  readonly tool: string;
  readonly scope: GrantScope;
  /** The command for exact-command; a resolved path for the path scopes. */
  readonly value: string;
  /** The sentence shown when granting and on the revocation chip — the label IS the scope. */
  readonly label: string;
  readonly createdAt: number;
}

/** One "always allow …" option offered on the card. The id comes back on the wire. */
export interface ScopeChoice {
  readonly id: GrantScope;
  readonly label: string;
}

// Tools whose worst case is disclosure, not damage. Everything not listed
// here or in EDIT_TOOLS is treated as a run: a tool nobody classified gets
// the cautious tier, not the permissive one.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Shell patterns that mean the card should be louder and "always" should not
// exist. Matched against the whole command line, so `npm test && rm -rf x`
// is caught even though it starts innocently. A list like this can only ever
// be incomplete — it decides presentation and grantability, while the actual
// safety floor stays "every unmatched ask goes to the phone".
const DANGEROUS = [
  // The r/f flag may sit anywhere after `rm` (e.g. `rm ./dir -rf`), not only
  // immediately after it — match the whole invocation up to a command separator.
  /\brm\b[^|;&\n]*\s(-[a-z]*[rf][a-z]*\b|--recursive\b|--force\b)/i,
  /\bsudo\b/,
  /\bgit\s+push\b.*(\s--force\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b.*\s-[a-z]*f/,
  /\bchmod\s+(-[a-z]*R\b|--recursive\b)/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\|\s*(sudo\s+)?(ba)?sh\b/,
  /\bshutdown\b|\breboot\b/,
  />\s*\/dev\/(sd|disk|nvme)/,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The path field of a tool input, resolved against the session cwd; undefined when absent or malformed. */
function inputPath(input: unknown, cwd: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const p = str((input as Record<string, unknown>).file_path) ?? str((input as Record<string, unknown>).path);
  if (!p) return undefined;
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function underDir(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + sep);
}

/** A path as the user should read it on a small screen: relative to the project when inside it. */
function shortPath(path: string, cwd: string): string {
  if (underDir(path, cwd)) {
    const rel = relative(cwd, path);
    return rel === '' ? '.' : rel;
  }
  return path;
}

/**
 * How dangerous this ask is, judged from the input the user will actually be
 * approving. The tier decides how loud the card is and which grants exist —
 * danger tier gets no "always" at all, because a standing permission for a
 * destructive pattern is exactly the reflex this system exists to break.
 */
export function riskTier(tool: string, input: unknown, cwd: string): RiskTier {
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (tool === 'Bash') {
    const cmd = str(record.command) ?? '';
    return isDangerousCommand(cmd) ? 'danger' : 'run';
  }
  if (EDIT_TOOLS.has(tool)) {
    const p = inputPath(input, cwd);
    // A write whose target cannot be read, or lands outside the project, is
    // the dangerous case whatever the tool name says.
    if (!p || !underDir(p, resolve(cwd))) return 'danger';
    return 'edit';
  }
  if (READ_TOOLS.has(tool)) return 'read';
  return 'run';
}

const CMD_IN_LABEL = 60;

/**
 * The "always allow …" options for one ask, narrowest first — the first
 * entry is also what the legacy bare `always: true` wire narrows to. Every
 * label carries the exact scope in words, because the label is the entire
 * contract the user is agreeing to.
 */
export function scopeChoicesFor(tool: string, input: unknown, cwd: string): ScopeChoice[] {
  const tier = riskTier(tool, input, cwd);
  if (tier === 'danger') return [];
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

  if (tool === 'Bash') {
    const cmd = (str(record.command) ?? '').trim();
    if (!cmd) return [];
    const shown = cmd.length > CMD_IN_LABEL ? cmd.slice(0, CMD_IN_LABEL) + '…' : cmd;
    return [{ id: 'exact-command', label: `Always allow exactly “${shown}” (this session)` }];
  }

  const p = inputPath(input, cwd);
  const out: ScopeChoice[] = [];
  if (p && underDir(p, resolve(cwd))) {
    out.push({ id: 'exact-file', label: `Always allow ${tool} on ${shortPath(p, cwd)} (this session)` });
    const dir = dirname(p);
    // A folder grant for the project root would be "this tool, anywhere" —
    // the whole-tool whitelist this vocabulary exists to retire — so the
    // folder choice only appears for real subfolders.
    if (dir !== resolve(cwd) && underDir(dir, resolve(cwd))) {
      out.push({ id: 'folder', label: `Always allow ${tool} anywhere in ${shortPath(dir, cwd)}/ (this session)` });
    }
  }
  if (tier === 'read') {
    // Tool-wide is only ever offered for reads, and even then stays fenced
    // inside the project when the tool names paths.
    out.push({ id: 'project-reads', label: `Always allow every ${tool} in this project (this session)` });
  }
  return out;
}

/**
 * Mint the grant for a chosen scope — recomputed from the same input the
 * card showed, so the wire cannot ask for more than was offered. A choice
 * that scopeChoicesFor would not have listed returns null, which the caller
 * must treat as "allow once, grant nothing".
 */
export function grantForChoice(
  tool: string, input: unknown, choiceId: string, cwd: string, newId: () => string,
): ApprovalGrant | null {
  const offered = scopeChoicesFor(tool, input, cwd).find((c) => c.id === choiceId);
  if (!offered) return null;
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const base = { id: newId(), tool, label: offered.label, createdAt: Date.now() };
  switch (offered.id) {
    case 'exact-command': {
      const cmd = (str(record.command) ?? '').trim();
      return cmd ? { ...base, scope: 'exact-command', value: cmd } : null;
    }
    case 'exact-file': {
      const p = inputPath(input, cwd);
      return p ? { ...base, scope: 'exact-file', value: p } : null;
    }
    case 'folder': {
      const p = inputPath(input, cwd);
      return p ? { ...base, scope: 'folder', value: dirname(p) } : null;
    }
    case 'project-reads':
      return { ...base, scope: 'project-reads', value: resolve(cwd) };
  }
}

/**
 * Does a standing grant cover this new ask? The answer defaults to no: the
 * tool must match exactly, the scope must be one of the four known shapes,
 * and every path is resolved before comparison so `..` and relative
 * spellings cannot smuggle an ask past its fence.
 */
export function grantMatches(grant: ApprovalGrant, tool: string, input: unknown, cwd: string): boolean {
  if (grant.tool !== tool) return false;
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null;
  switch (grant.scope) {
    case 'exact-command': {
      const cmd = record ? str(record.command) : undefined;
      return cmd !== undefined && cmd.trim() === grant.value;
    }
    case 'exact-file': {
      const p = inputPath(input, cwd);
      return p !== undefined && p === grant.value;
    }
    case 'folder': {
      const p = inputPath(input, cwd);
      return p !== undefined && underDir(p, grant.value);
    }
    case 'project-reads': {
      const p = inputPath(input, cwd);
      // A read tool with no path field searches the session cwd, which is
      // the project by construction; one that names a path must stay inside.
      if (p === undefined) return true;
      return underDir(p, grant.value);
    }
    default:
      return false;
  }
}

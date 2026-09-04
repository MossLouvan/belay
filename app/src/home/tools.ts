// The tool roster behind the desktop's "Tools" drawer.
//
// Desktop-first IA: the live desktop is the app's home, and everything that
// used to be a bottom tab — Agent, Terminal, Files, System — is now a tool
// that slides up over it. This module is the pure model: which tools exist,
// in what order, what each one is called and does (one honest line a
// first-time user can act on), and where its panel lives. The drawer UI in
// tool-drawer.tsx renders exactly this list; tools.test.mjs holds it to its
// contract under node.

export type ToolId = 'agent' | 'terminal' | 'files' | 'system';

export interface ToolSpec {
  readonly id: ToolId;
  /** Short name shown beside the glyph. */
  readonly title: string;
  /** One plain-language line: what a novice gets by opening it. */
  readonly description: string;
  /** The slide-up panel's route inside the (home) stack. */
  readonly route: `/${ToolId}`;
}

/**
 * Drawer order: Agent leads because it is the product's headline act and the
 * one tool that can *ask for you* (approvals); the shell-and-disk pair follow;
 * System closes the list because it is where you check on — or forget — the
 * computer rather than drive it.
 */
export const TOOLS: readonly ToolSpec[] = [
  {
    id: 'agent',
    title: 'Agent',
    description: 'Run Claude Code on the computer and approve its work',
    route: '/agent',
  },
  {
    id: 'terminal',
    title: 'Terminal',
    description: 'A command line on the computer, keys included',
    route: '/terminal',
  },
  {
    id: 'files',
    title: 'Files',
    description: 'Browse and read the computer’s files (read-only)',
    route: '/files',
  },
  {
    id: 'system',
    title: 'System',
    description: 'CPU, memory, disk and battery — and this pairing',
    route: '/system',
  },
];

/**
 * The count chip a tool's drawer row (and the dock's Tools key) carries.
 * Only the Agent can need a human decision, so only it ever counts; zero and
 * negative counts mean "no chip", never a "0" badge.
 */
export function toolBadge(id: ToolId, waitingCount: number): number | null {
  return id === 'agent' && waitingCount > 0 ? waitingCount : null;
}

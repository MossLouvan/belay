// Pure logic behind the approval card: turning the host's preview into
// renderable diff text, the warnings that must not be missable, and how loud
// the card is per risk tier. No React and no JSX, so approval.test.mjs can
// import it straight into Node — the same split as model.ts / session-view.

import type { GeneratedDiff } from '../changes/diff-format';
import type { ApprovalPreview, ApprovalRisk, PendingApproval } from '../api';

/**
 * The diff generators, passed in rather than imported: a value import of
 * another module would break the repo's node-test arrangement (only `import
 * type` crosses files in node-tested modules), so the card hands in the real
 * editDiff/writeDiff and the test hands in the same ones.
 */
export interface DiffGenerators {
  readonly editDiff: (oldText: string, newText: string) => GeneratedDiff;
  readonly writeDiff: (content: string) => GeneratedDiff;
}

/** What the card renders for one ask, ready for DiffBody or a mono block. */
export interface ApprovalRender {
  /** Diff text for DiffBody; null when the ask has no file-shaped preview. */
  readonly diff: GeneratedDiff | null;
  /** The bare command, rendered prominently — never behind "show full input". */
  readonly command: string | null;
  /** The red line above a Write that destroys what a file already says. */
  readonly replaceWarning: string | null;
  /** The honest footnote when the host or the phone cut the preview. */
  readonly cappedNote: string | null;
  /** Whether the raw-input fallback is the only thing there is to show. */
  readonly rawOnly: boolean;
}

function replaceWarning(preview: ApprovalPreview): string | null {
  if (preview.kind !== 'write' || !preview.exists) return null;
  return preview.existingLines !== undefined
    ? `Replaces the existing file — its current ${preview.existingLines} line${preview.existingLines === 1 ? '' : 's'} will be gone.`
    : 'Replaces an existing file — its current contents will be gone.';
}

export function renderApproval(pending: PendingApproval, gen: DiffGenerators): ApprovalRender {
  const preview = pending.preview;
  if (!preview) {
    return { diff: null, command: null, replaceWarning: null, cappedNote: null, rawOnly: true };
  }
  if (preview.kind === 'command') {
    return { diff: null, command: preview.command, replaceWarning: null, cappedNote: null, rawOnly: false };
  }
  const diff = preview.kind === 'edit'
    ? gen.editDiff(preview.oldText, preview.newText)
    : gen.writeDiff(preview.content);
  const cut = preview.capped || diff.capped;
  return {
    diff,
    command: null,
    replaceWarning: replaceWarning(preview),
    cappedNote: cut ? 'The change is bigger than fits here — this is the first part of it.' : null,
    rawOnly: false,
  };
}

/** The path line above an Edit/Write diff; null when there is none to name. */
export function previewPath(pending: PendingApproval): string | null {
  const p = pending.preview;
  return p && (p.kind === 'edit' || p.kind === 'write') ? p.path : null;
}

/**
 * Danger asks get the bad band and a held Allow; everything else keeps the
 * warn band. Two levels only — a card with four colour temperatures would
 * teach nobody anything.
 */
export function isDanger(risk: ApprovalRisk | undefined): boolean {
  return risk === 'danger';
}

export function approvalHeading(risk: ApprovalRisk | undefined): string {
  return isDanger(risk) ? 'Caution — approval needed' : 'Approval needed';
}

/** The label on the always-allow disclosure; null hides it entirely. */
export function alwaysSectionLabel(pending: PendingApproval): string | null {
  const n = pending.choices?.length ?? 0;
  return n > 0 ? 'Always allow…' : null;
}

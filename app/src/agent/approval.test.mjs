// Unit tests for the approval card's pure logic — what an ask renders as,
// and which warnings are impossible to miss. The scope *matching* lives on
// the host and is tested there; this side only ever displays.
//
//   cd app && node --test src/agent/approval.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  alwaysSectionLabel, approvalHeading, isDanger, previewPath, renderApproval,
} from './approval-model.ts';
import { editDiff, writeDiff } from '../changes/diff-format.ts';

// The card injects the real generators (see DiffGenerators); so does the test.
const GEN = { editDiff, writeDiff };

const ask = (over = {}) => ({ id: 'p1', tool: 'Bash', detail: '', input: '{}', ...over });

test('a Bash ask renders its command prominently, never a diff', () => {
  const r = renderApproval(ask({ preview: { kind: 'command', command: 'npm test' } }), GEN);
  assert.equal(r.command, 'npm test');
  assert.equal(r.diff, null);
  assert.equal(r.rawOnly, false);
});

test('an Edit ask renders old→new as diff lines', () => {
  const r = renderApproval(ask({
    tool: 'Edit',
    preview: { kind: 'edit', path: 'src/a.ts', oldText: 'a\nold\nz', newText: 'a\nnew\nz', capped: false, replaceAll: false },
  }), GEN);
  assert.deepEqual(r.diff.text.split('\n'), [' a', '-old', '+new', ' z']);
  assert.equal(r.replaceWarning, null);
  assert.equal(r.cappedNote, null);
});

test('a Write over an existing file carries a warning that names the loss', () => {
  const existing = renderApproval(ask({
    tool: 'Write',
    preview: { kind: 'write', path: 'src/a.ts', content: 'new body', capped: false, exists: true, existingLines: 42 },
  }), GEN);
  assert.ok(existing.replaceWarning?.includes('42 lines'));
  assert.ok(existing.replaceWarning?.includes('gone'));
  assert.equal(existing.diff.text, '+new body');

  const unsized = renderApproval(ask({
    tool: 'Write',
    preview: { kind: 'write', path: 'x', content: 'c', capped: false, exists: true },
  }), GEN);
  assert.ok(unsized.replaceWarning, 'existence alone still warns when the size is unknown');

  const fresh = renderApproval(ask({
    tool: 'Write',
    preview: { kind: 'write', path: 'x', content: 'c', capped: false, exists: false },
  }), GEN);
  assert.equal(fresh.replaceWarning, null, 'a brand-new file is an addition, not a destruction');
});

test('a capped preview says so instead of passing a fragment off as the whole', () => {
  const r = renderApproval(ask({
    tool: 'Write',
    preview: { kind: 'write', path: 'x', content: 'c', capped: true, exists: false },
  }), GEN);
  assert.ok(r.cappedNote?.includes('first part'));
});

test('no preview means the raw-input fallback, not an empty card', () => {
  const r = renderApproval(ask({ tool: 'WebFetch' }), GEN);
  assert.equal(r.rawOnly, true);
  assert.equal(r.diff, null);
  assert.equal(r.command, null);
});

test('previewPath names the file for file-shaped asks only', () => {
  assert.equal(previewPath(ask({ preview: { kind: 'command', command: 'ls' } })), null);
  assert.equal(previewPath(ask({
    preview: { kind: 'edit', path: 'a/b.ts', oldText: '', newText: '', capped: false, replaceAll: false },
  })), 'a/b.ts');
});

test('risk decides the heading and the danger treatment; only danger is loud', () => {
  assert.equal(isDanger('danger'), true);
  assert.equal(isDanger('run'), false);
  assert.equal(isDanger(undefined), false, 'an old host without tiers gets the normal card');
  assert.ok(approvalHeading('danger').includes('Caution'));
  assert.equal(approvalHeading('read'), 'Approval needed');
});

test('the always section exists only when the host offered choices', () => {
  assert.equal(alwaysSectionLabel(ask()), null, 'no choices — no Always, not a broad fallback');
  assert.equal(alwaysSectionLabel(ask({ choices: [] })), null);
  assert.ok(alwaysSectionLabel(ask({ choices: [{ id: 'exact-command', label: 'Always allow exactly “ls”' }] })));
});

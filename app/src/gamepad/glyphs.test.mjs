import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glyphStyleOf, kindOf, labelsFor, controlLabel, glyphLayout } from './glyphs.ts';
import { gamepadLayout } from './layout.ts';

test('PlayStation controllers or saved choice select Sony labels', () => {
  for (const kind of ['dualsense', 'dualshock']) {
    const labels = labelsFor(kind, 'auto');
    assert.deepEqual(['a','b','x','y'].map(k => labels[k]), ['✕','○','□','△']);
    assert.deepEqual(['lb','rb','lt','rt','start','select'].map(k => labels[k]), ['L1','R1','L2','R2','Options','Create']);
  }
  assert.equal(labelsFor('generic', 'playstation').a, '✕');
  assert.equal(labelsFor('xbox', 'auto').a, 'A');
  assert.equal(glyphStyleOf(JSON.parse(JSON.stringify({ glyphStyle: 'playstation' })).glyphStyle), 'playstation');
});
test('Options/Create get wider targets without moving button identities or overlapping', () => {
  for (const [w,h] of [[568,320],[667,375],[844,390]]) {
    const base = gamepadLayout(w,h,'classic','fortnite',44,8);
    const controls = glyphLayout(base, labelsFor('dualsense','auto'), 76);
    assert.equal(controls.find(c => c.id === 'start').w, 76);
    assert.deepEqual(controls.map(c => c.id), base.map(c => c.id));
    for (const c of controls) for (const d of controls) if (c.id !== d.id) {
      assert.ok(c.x+c.w <= d.x || d.x+d.w <= c.x || c.y+c.h <= d.y || d.y+d.h <= c.y, c.id+' overlaps '+d.id);
    }
    assert.equal(base.find(c => c.id === 'start').w, 44);
  }
});
test('external kinds/preferences validate and labels retain layout control identities', () => {
  for (const value of [null, {}, 'PlayStation', 4]) {
    assert.equal(kindOf(value), 'generic'); assert.equal(glyphStyleOf(value), 'auto');
  }
  assert.equal(kindOf('dualsense'), 'dualsense');
  assert.equal(controlLabel('lx', labelsFor('generic', 'auto')), 'Move');
  assert.equal(controlLabel('edit', labelsFor('dualsense', 'auto')), 'EDIT');
});

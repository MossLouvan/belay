import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gamepadLayout, stickVector } from './layout.ts';
test('landscape layouts keep every control within bounds, above minimum and non-overlapping', () => {
 for (const [w,h] of [[568,320],[667,375],[844,390],[1024,768]]) for (const choice of ['classic','southpaw']) for (const preset of ['generic','roblox','fortnite']) {
  const controls = gamepadLayout(w,h,choice,preset,44,8);
  for (const c of controls) {
   assert.ok(c.x >= 0 && c.y >= 0 && c.x+c.w <= w && c.y+c.h <= h, c.id);
   assert.ok(c.w >= 44 && c.h >= 44);
   for (const d of controls) if (c.id !== d.id) assert.ok(c.x+c.w <= d.x || d.x+d.w <= c.x || c.y+c.h <= d.y || d.y+d.h <= c.y, c.id+' overlaps '+d.id);
  }
  assert.ok(controls.some(c=>c.id==='lx')); assert.ok(controls.some(c=>c.id==='rx'));
  assert.equal(controls.some(c=>c.id==='edit'),preset==='fortnite');
 }
});
test('invalid geometry is empty; sticks invert Y and clamp radially',()=>{
 assert.deepEqual(gamepadLayout(0,0,'classic','generic',44,8),[]);
 assert.deepEqual(stickVector(0,0,40),{x:0,y:0});
 assert.deepEqual(stickVector(0,-40,40),{x:0,y:1});
 const v=stickVector(80,80,40); assert.ok(Math.abs(Math.hypot(v.x,v.y)-1)<1e-9);
});
test('Fortnite center controls leave room for exit instructions and hold progress', () => {
 const controls = gamepadLayout(568, 320, 'classic', 'fortnite', 44, 8);
 for (const id of ['build', 'edit']) assert.ok(controls.find(c => c.id === id).y >= 100);
});

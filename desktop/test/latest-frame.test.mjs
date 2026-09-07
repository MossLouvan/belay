import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestFramePainter } from '../src/latest-frame.js';
const flush = () => new Promise(r => setImmediate(r));
test('slow decoder retains only newest pending image and releases discarded sources', async () => {
  const jobs=[], painted=[], released=[];
  const painter=latestFramePainter(source => new Promise(resolve => jobs.push({source,resolve})), frame => painted.push(frame.id), source => released.push(source));
  painter.push(1); painter.push(2); painter.push(3);
  assert.equal(jobs.length,1); assert.deepEqual(released,[2]);
  jobs[0].resolve({id:1}); await flush();
  assert.equal(jobs[1].source,3); jobs[1].resolve({id:3}); await flush();
  assert.deepEqual(painted,[1,3]); assert.deepEqual(released,[2,1,3]);
});
test('closing during decode never paints a late frame and frees both sources',async()=>{
  let resolve; const released=[],painted=[];
  const p=latestFramePainter(()=>new Promise(r=>resolve=r),f=>painted.push(f),s=>released.push(s));
  p.push('a');p.push('b');p.close();resolve({});await flush();
  assert.deepEqual(painted,[]);assert.deepEqual(released,['b','a']);
});

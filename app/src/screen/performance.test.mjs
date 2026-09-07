import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performanceQuality } from './performance.ts';
test('performance choices reach stream fields, auto clears fixed ceiling and JPEG stays capped',()=>{
 const base={w:1600,q:65,fps:30,bwpPreset:'high',bwpFps:60};
 assert.equal(performanceQuality(base,null),base);
 const tuned=performanceQuality(base,{fps:120,bitrateMbps:20});
 assert.equal(tuned.bwpFps,120);assert.equal(tuned.bwpPreset,'max');assert.equal(tuned.fps,30);
 assert.equal(performanceQuality(tuned,{fps:60,bitrateMbps:0}).bwpPreset,'auto');
 assert.equal(performanceQuality(base,{fps:NaN,bitrateMbps:NaN}).bwpFps,60);
});

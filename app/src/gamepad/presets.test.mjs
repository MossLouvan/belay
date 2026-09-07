import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetOf, layoutChoice, gamingQuality } from './presets.ts';
test('stored preferences are validated and presets name fallback behavior',()=>{
 assert.equal(presetOf('oops').id,'generic'); assert.equal(layoutChoice('oops'),'classic');
 assert.equal(layoutChoice('southpaw'),'southpaw');
 assert.match(presetOf('roblox').hint,/Shift/); assert.match(presetOf('fortnite').hint,/build/i);
});
test('gaming preserves motion quality without forcing data saver or 120 fps',()=>{
 assert.equal(gamingQuality(null).bwpPreset,'max'); assert.equal(gamingQuality(null).fps,30); assert.equal(gamingQuality('cpu').bwpFps,60);
 assert.equal(gamingQuality('gpu').bwpFps,60); assert.equal(gamingQuality('gpu').w,1600);
});

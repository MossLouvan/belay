import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGamepadMessage } from './messages.ts';
test('accepts only consistent hello and finite normalized rumble',()=>{
 assert.equal(parseGamepadMessage('{"type":"hello","available":true,"backend":"keymap"}').backend,'keymap');
 assert.equal(parseGamepadMessage('{"type":"rumble","low":1,"high":0}').low,1);
 for(const raw of ['null','{}','oops','{"type":"rumble","low":2,"high":0}','{"type":"hello","available":true,"backend":"unavailable"}'])assert.equal(parseGamepadMessage(raw),null);
});

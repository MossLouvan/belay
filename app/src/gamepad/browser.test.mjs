import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserState } from './browser.ts';
test('web controller maps analog triggers, all face buttons and both stick directions',()=>{
 const pad={connected:true,mapping:'standard',axes:[1,-1,-1,1],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
 pad.buttons[0]={pressed:true,value:1};pad.buttons[6]={pressed:true,value:.5};
 const s=browserState(pad);assert.equal(s.buttons,4096);assert.equal(s.lt,.5);
 assert.deepEqual([s.lx,s.ly,s.rx,s.ry],[1,1,-1,-1]);
 assert.equal(browserState({...pad,mapping:''}),null);assert.equal(browserState({...pad,axes:[NaN,0,0,0]}),null);
});

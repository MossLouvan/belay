import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptFrame, emptySession, takeFrame, helperHello } from './gamepad-session.ts';
import { NEUTRAL } from './gamepad-codec.ts';
test('newest wins, rejects stale, limits to 500 in a second and resumes after window',()=>{
 let s=emptySession();
 for(let i=0;i<500;i++) s=acceptFrame(s,{...NEUTRAL,seq:i},100);
 assert.equal(s.pending.seq,499);
 assert.equal(acceptFrame(s,{...NEUTRAL,seq:501},100),s);
 assert.equal(acceptFrame(s,{...NEUTRAL,seq:0},1200),s);
 const next=acceptFrame(s,{...NEUTRAL,seq:502},1200);
 assert.equal(next.pending.seq,502); assert.equal(takeFrame(next).pending,null);
});
test('helper status is validated, with unavailable fallback',()=>{
 assert.equal(helperHello({backend:'keymap',reason:'No driver'}).available,true);
 assert.equal(helperHello({backend:'vigem'}).backend,'vigem');
 for(const bad of [null,{}, {backend:'evil'}]) assert.equal(helperHello(bad).available,false);
});

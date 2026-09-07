import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGamepadHub } from './gamepad-channel.ts';
import { encodeGamepad, NEUTRAL } from './gamepad-codec.ts';
class Socket extends EventEmitter {
 readyState=1; bufferedAmount=0; sent=[];
 send(s){this.sent=[...this.sent,JSON.parse(s)];}
 close(){this.readyState=3;this.emit('close');}
}
test('attach, newest sample, malformed close, detach and exclusive owner',async()=>{
 let updates=[],detaches=0,tick;
 const helper={gamepadAttach:async()=>({backend:'keymap'}),gamepadDetach:async()=>{detaches++;},gamepad:state=>{updates=[...updates,state];return true;},onGamepadEvent:()=>()=>{}};
 const hub=createGamepadHub(helper,{schedule:fn=>{tick=fn;return ()=>{};},now:()=>100});
 const ws=new Socket();hub.handle(ws,'roblox');await new Promise(r=>setImmediate(r));
 assert.equal(ws.sent[0].backend,'keymap');
 const other=new Socket();hub.handle(other,'generic');assert.equal(other.sent[0].available,false);
 ws.emit('message',Buffer.from(encodeGamepad({...NEUTRAL,lx:1,seq:1})),true);
 ws.emit('message',Buffer.from(encodeGamepad({...NEUTRAL,lx:.5,seq:2})),true);
 tick();assert.equal(updates.length,1);assert.ok(Math.abs(updates[0].lx-.5)<.001);
 ws.emit('message',Buffer.alloc(16),true);await new Promise(r=>setImmediate(r));
 assert.equal(ws.readyState,3);assert.equal(detaches,1);
});
test('close during attach still detaches before a new owner, helper pushes validated rumble',async()=>{
 let resolveAttach, detached=0,listener;
 const helper={gamepadAttach:()=>new Promise(r=>{resolveAttach=r;}),gamepadDetach:async()=>{detached++;},gamepad:()=>true,onGamepadEvent:fn=>{listener=fn;return ()=>{};}};
 const hub=createGamepadHub(helper,{schedule:()=>()=>{}});const ws=new Socket();hub.handle(ws,'generic');ws.close();
 resolveAttach({backend:'vigem'});await new Promise(r=>setImmediate(r));assert.equal(detached,1);
 const next=new Socket();hub.handle(next,'generic');resolveAttach({backend:'vigem'});await new Promise(r=>setImmediate(r));
 listener({type:'rumble',low:1,high:0});listener({type:'rumble',low:NaN,high:0});
 assert.equal(next.sent.filter(m=>m.type==='rumble').length,1);next.close();
});
test('helper backpressure keeps latest sample, watchdog releases and stops ticks',async()=>{
 let tick,stopped=0,at=100,canWrite=false,updates=[];
 const helper={gamepadAttach:async()=>({backend:'vigem'}),gamepadDetach:async()=>{},gamepad:s=>{if(!canWrite)return false;updates=[...updates,s];return true;},onGamepadEvent:()=>()=>{}};
 const hub=createGamepadHub(helper,{now:()=>at,schedule:fn=>{tick=fn;return ()=>{stopped++;};}});
 const ws=new Socket();hub.handle(ws,'generic');await new Promise(r=>setImmediate(r));
 ws.emit('message',Buffer.from(encodeGamepad({...NEUTRAL,buttons:4096,seq:1})),true);tick();assert.equal(updates.length,0);
 ws.emit('message',Buffer.from(encodeGamepad({...NEUTRAL,seq:2})),true);canWrite=true;tick();assert.equal(updates[0].buttons,0);
 at=851;tick();assert.equal(ws.readyState,3);assert.equal(stopped,1);assert.deepEqual(updates.at(-1),NEUTRAL);
});
test('a helper death closes its lease and publishes unavailable',async()=>{
 let listener;
 const helper={gamepadAttach:async()=>({backend:'vigem'}),gamepadDetach:async()=>{},gamepad:()=>true,onGamepadEvent:fn=>{listener=fn;return ()=>{};}};
 const hub=createGamepadHub(helper,{schedule:()=>()=>{}});const ws=new Socket();hub.handle(ws,'generic');await new Promise(r=>setImmediate(r));
 listener({type:'gamepadstatus',backend:'unavailable',reason:'Helper exited'});
 assert.equal(ws.sent.at(-1).available,false);assert.equal(ws.readyState,3);
});
test('active rumble is refreshed so the phone can time out a lost connection',async()=>{
 let at=100,tick,listener;
 const helper={gamepadAttach:async()=>({backend:'vigem'}),gamepadDetach:async()=>{},gamepad:()=>true,onGamepadEvent:fn=>{listener=fn;return ()=>{};}};
 const hub=createGamepadHub(helper,{now:()=>at,schedule:fn=>{tick=fn;return ()=>{};}});
 const ws=new Socket();hub.handle(ws,'generic');await new Promise(r=>setImmediate(r));
 listener({type:'rumble',low:.5,high:0});at=400;tick();
 assert.equal(ws.sent.filter(m=>m.type==='rumble').length,2);
 listener({type:'rumble',low:0,high:0});at=800;tick();
 assert.equal(ws.sent.filter(m=>m.type==='rumble').length,3);ws.close();
});
test('neutral heartbeats preserve activity without masking local host input',async()=>{
 let tick,at=100,activity=[];
 const helper={gamepadAttach:async()=>({backend:'keymap'}),gamepadDetach:async()=>{},gamepad:()=>true,onGamepadEvent:()=>()=>{}};
 const hub=createGamepadHub(helper,{now:()=>at,onActivity:injected=>{activity=[...activity,injected];},schedule:fn=>{tick=fn;return ()=>{};}});
 const ws=new Socket();hub.handle(ws,'generic');await new Promise(r=>setImmediate(r));
 for(const [seq,buttons] of [[0,0],[1,4096],[2,0],[3,0]]){
  at+=100;ws.emit('message',Buffer.from(encodeGamepad({...NEUTRAL,seq,buttons})),true);tick();
 }
 assert.deepEqual(activity,[false,true,true,false]);ws.close();
});

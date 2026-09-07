import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoQueue } from '../src/video-queue.js';
const frame=(n,keyframe=false)=>({n,keyframe,data:new Uint8Array([n])});
test('brief encoded bursts retain FIFO dependencies without requesting a keyframe',()=>{
  const sent=[];let requests=0;
  const q=videoQueue(f=>sent.push(f),()=>requests++,()=>0);
  q.push(frame(0,true));q.push(frame(1));q.push(frame(2));
  assert.equal(sent.length,1);q.ack(999);assert.equal(sent.length,1);
  q.ack(sent[0].deliveryId);q.ack(sent[1].deliveryId);
  assert.deepEqual(sent.map(f=>f.n),[0,1,2]);assert.equal(requests,0);
});
test('overflow discards dependent frames and resumes only from a keyframe',()=>{
  const sent=[];let requests=0;
  const q=videoQueue(f=>sent.push(f),()=>requests++,()=>0);
  q.push(frame(0,true));for(let n=1;n<20;n++)q.push(frame(n));
  assert.equal(requests,1);q.ack(sent[0].deliveryId);assert.equal(sent.length,1);
  q.push(frame(20,true));assert.equal(sent[1].n,20);
  q.close();q.push(frame(21,true));assert.equal(sent.length,2);
});
test('a renderer stall cannot present queued old predictive frames',()=>{
  let time=0,requests=0;const sent=[];
  const q=videoQueue(f=>sent.push(f),()=>requests++,()=>time);
  q.push(frame(0,true));q.push(frame(1));time=60;q.ack(sent[0].deliveryId);
  assert.equal(sent.length,1);assert.equal(requests,1);
});

// Real Windows GPU encoder -> encrypted UDP -> desktop receiver smoke test.
// Synthetic pixels avoid recording the user's desktop; keys never leave stdin.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { reserveVideo } from '../desktop/src/video-receiver.js';
import { createSocket } from 'node:dgram';
const root=fileURLToPath(new URL('../',import.meta.url));
const token=randomBytes(32).toString('hex'),salt=randomBytes(8).toString('hex');
let frames=0,keys=0,bytes=0,path='',receiver,streamer;
const stages=[];
const errors=[];
const lossMode=process.argv.includes('--loss');
const networkMode=process.argv.includes('--network');
if(lossMode&&networkMode)throw new Error('Choose --loss for one dropped packet or --network for the sustained profile');
const durationMs=networkMode?15000:8000;
const gaps=[];let previousFrameAt,videoPackets=0,droppedPackets=0,seed=42;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const scheduled=new Set();
const forward=(data,port)=>{
 if(!networkMode){proxy.send(data,port,'127.0.0.1');return;}
 const timer=setTimeout(()=>{scheduled.delete(timer);proxy.send(data,port,'127.0.0.1');},20+Math.floor(random()*6));
 scheduled.add(timer);
};
let proxy, hostPort, clientPort, droppedAt, recoveredMs, droppedFrame;
try {
 if(lossMode||networkMode){
  proxy=createSocket('udp4');
  await new Promise((yes,no)=>{proxy.once('error',no);proxy.bind(0,'127.0.0.1',yes);});
  proxy.on('message',(data,from)=>{
   if(from.port===hostPort){
    if((data[1]&15)===3){
     videoPackets++;
     if(networkMode&&random()<0.01){droppedPackets++;return;}
    }
    // Drop one encrypted video datagram after warmup. Routing sees only the
    // public framing header, never keys or plaintext pixels.
    if(lossMode&&!droppedAt&&frames>60&&(data[1]&15)===3&&(data[2]&1)===0){
     droppedAt=performance.now();droppedFrame=data.readUInt32LE(8);return;
    }
    forward(data,clientPort);
   }else if(from.port===clientPort&&hostPort)forward(data,hostPort);
  });
 }
 receiver=await reserveVideo(resolve(root,'desktop'),'http://127.0.0.1',frame=>{
   const arrived=performance.now();
   if(previousFrameAt!==undefined)gaps.push(arrived-previousFrameAt);
   previousFrameAt=arrived;
   if(droppedAt&&recoveredMs===undefined){
    if(!frame.keyframe)errors.push('A dependent delta escaped after packet loss');
    recoveredMs=performance.now()-droppedAt;
   }
   frames++;keys+=Number(frame.keyframe);bytes+=frame.data.length;receiver.ack(frame.deliveryId);
 },()=>{});
 clientPort=receiver.port;
 streamer=spawn(resolve(root,'crates/belay-stream/target/release/belay-stream.exe'),[],{windowsHide:true});
 const ready=new Promise((yes,no)=>{
  const timeout=setTimeout(()=>no(new Error('Streamer startup timed out')),10000);
  const fail=error=>{clearTimeout(timeout);errors.push(String(error));no(error);};
  const lines=createInterface({input:streamer.stdout});
  streamer.on('error',fail);streamer.on('exit',code=>fail(new Error(`Streamer exit ${code}`)));
  lines.on('line',line=>{try{const m=JSON.parse(line);if(m.type==='stats')stages.push(m);if(m.type==='error')fail(new Error(m.error));if(m.type==='ready'){path=m.path;hostPort=m.port;receiver.configure({port:proxy?.address().port??m.port,key:token,salt},'max');clearTimeout(timeout);yes();}}catch(error){fail(error);}});
 });
 streamer.stdin.write(JSON.stringify({peer:`127.0.0.1:${proxy?.address().port??receiver.port}`,token,salt,preset:'max',fps:60,source:'synthetic'})+'\n');
 await ready;
 await new Promise(r=>setTimeout(r,durationMs));
 gaps.sort((a,b)=>a-b);
 console.log(JSON.stringify({path,frames,keyframes:keys,bytes,seconds:durationMs/1000,stages,
  frameGapP95Ms:gaps[Math.max(0,Math.ceil(gaps.length*.95)-1)],maxFrameGapMs:gaps.at(-1),
  ...(networkMode?{network:{oneWayDelayMs:'20-25',videoLoss:0.01,videoPackets,droppedPackets,seed:42}}:{}),
  ...(lossMode?{droppedFrame,recoveredMs}:{})}));
 if(errors.length)throw new Error(errors.join('; '));
 if(lossMode&&!(recoveredMs>=0&&recoveredMs<2000))throw new Error('Packet-loss recovery did not meet the two-second smoke-test ceiling');
 if(frames<30||keys<2)throw new Error('Sustained H.264 video and periodic keyframe recovery are required');
} finally {receiver?.stop();streamer?.kill();for(const timer of scheduled)clearTimeout(timer);proxy?.close();}

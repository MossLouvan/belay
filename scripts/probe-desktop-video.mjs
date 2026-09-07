// Real Windows GPU encoder -> encrypted UDP -> desktop receiver smoke test.
// Synthetic pixels avoid recording the user's desktop; keys never leave stdin.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { reserveVideo } from '../desktop/src/video-receiver.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const token=randomBytes(32).toString('hex'),salt=randomBytes(8).toString('hex');
let frames=0,keys=0,bytes=0,path='',receiver,streamer;
const stages=[];
try {
 receiver=await reserveVideo(resolve(root,'desktop'),'http://127.0.0.1',frame=>{
   frames++;keys+=Number(frame.keyframe);bytes+=frame.data.length;receiver.ack(frame.deliveryId);
 },()=>{});
 streamer=spawn(resolve(root,'crates/belay-stream/target/release/belay-stream.exe'),[],{windowsHide:true});
 const ready=new Promise((yes,no)=>{
  const lines=createInterface({input:streamer.stdout});
  streamer.on('error',no);streamer.on('exit',code=>no(new Error(`Streamer exit ${code}`)));
  lines.on('line',line=>{const m=JSON.parse(line);if(m.type==='stats')stages.push(m);if(m.type==='error')no(new Error(m.error));if(m.type==='ready'){path=m.path;receiver.configure({port:m.port,key:token,salt},'max');yes();}});
 });
 streamer.stdin.write(JSON.stringify({peer:`127.0.0.1:${receiver.port}`,token,salt,preset:'max',fps:60,source:'synthetic'})+'\n');
 await ready;
 await new Promise(r=>setTimeout(r,8000));
 console.log(JSON.stringify({path,frames,keyframes:keys,bytes,seconds:8,stages}));
 if(frames<30||keys<2)throw new Error('Sustained H.264 video and periodic keyframe recovery are required');
} finally {receiver?.stop();streamer?.kill();}

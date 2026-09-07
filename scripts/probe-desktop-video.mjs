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
let proxy, hostPort, clientPort, droppedAt, recoveredMs, droppedFrame;
try {
 if(lossMode){
  proxy=createSocket('udp4');
  await new Promise((yes,no)=>{proxy.once('error',no);proxy.bind(0,'127.0.0.1',yes);});
  proxy.on('message',(data,from)=>{
   if(from.port===hostPort){
    // Drop one encrypted video datagram after warmup. Routing sees only the
    // public framing header, never keys or plaintext pixels.
    if(!droppedAt&&frames>60&&(data[1]&15)===3&&(data[2]&1)===0){
     droppedAt=performance.now();droppedFrame=data.readUInt32LE(8);return;
    }
    proxy.send(data,clientPort,'127.0.0.1');
   }else if(from.port===clientPort&&hostPort)proxy.send(data,hostPort,'127.0.0.1');
  });
 }
 receiver=await reserveVideo(resolve(root,'desktop'),'http://127.0.0.1',frame=>{
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
 await new Promise(r=>setTimeout(r,8000));
 console.log(JSON.stringify({path,frames,keyframes:keys,bytes,seconds:8,stages,...(lossMode?{droppedFrame,recoveredMs}:{})}));
 if(errors.length)throw new Error(errors.join('; '));
 if(lossMode&&!(recoveredMs>=0&&recoveredMs<2000))throw new Error('Packet-loss recovery did not meet the two-second smoke-test ceiling');
 if(frames<30||keys<2)throw new Error('Sustained H.264 video and periodic keyframe recovery are required');
} finally {receiver?.stop();streamer?.kill();proxy?.close();}

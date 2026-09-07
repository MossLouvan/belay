import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { videoQueue } from './video-queue.js';

/** One bounded receiver per display window. Host identity comes from main. */
export async function reserveVideo(root, host, deliver, ended) {
  const name = 'belay-receiver' + (process.platform === 'win32' ? '.exe' : '');
  const path = [join(root,'native',name),join(root,'..','crates','belay-client','target','release',name)].find(existsSync);
  if (!path) throw new Error('Build the desktop video receiver first');
  const {address,family}=await lookup(new URL(host).hostname.replace(/^\[|\]$/g,''));
  const child=spawn(path,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let pending=Buffer.alloc(0), stopped=false, configured=false;
  const queue=videoQueue(deliver,()=>child.stdin.write('keyframe\n'));
  const stop=()=>{stopped=true; queue.close(); child.kill();};
  child.stdout.on('data',chunk=>{
    if(stopped)return;
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=5) {
      const length=pending.readUInt32BE(1), keyframe=pending[0]===1;
      if(length<1 || length>8*1024*1024) { stop();ended();return; }
      if(pending.length<length+5) break;
      const data=pending.subarray(5,5+length); pending=pending.subarray(5+length);
      queue.push({keyframe,data:Uint8Array.from(data)});
    }
  });
  child.on('exit',()=>{if(!stopped) ended();});
  child.stdin.on('error',()=>{});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{stop();reject(new Error('Video receiver startup timed out'));},5000);
    const lines=createInterface({input:child.stderr});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Video receiver exited'));});
    lines.on('line',line=>{try {const m=JSON.parse(line);if(m.type==='reserved'&&Number.isInteger(m.port)&&m.port>0&&m.port<=65535){clearTimeout(timer);resolve(m.port);}}catch{}});
    child.stdin.write(family===6?'6\n':'4\n');
  });
  return {port,stop,requestKeyframe(){queue.recover();},ack(id){queue.ack(id);},configure(offer,preset){
    if(configured || !Number.isInteger(offer?.port)||offer.port<1||offer.port>65535||!/^[a-f0-9]{64}$/i.test(offer.key)||!/^[a-f0-9]{16}$/i.test(offer.salt)) throw new Error('Invalid video offer');
    if(!['auto','data-saver','balanced','high','max'].includes(preset)) throw new Error('Invalid preset');
    configured=true;
    child.stdin.write(`${family===6?'['+address+']':address}:${offer.port}\n${offer.key}\n${offer.salt}\n${preset}\n`);
  }};
}

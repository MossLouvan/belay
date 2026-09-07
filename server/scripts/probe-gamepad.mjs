// Independent XInput observation of the real Windows virtual-controller path.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),work=resolve(root,'.tmp/gamepad-probe');mkdirSync(work,{recursive:true});
const source=`using System;using System.Runtime.InteropServices;
class Probe {
 [StructLayout(LayoutKind.Sequential)] public struct Pad {public ushort buttons;public byte lt,rt;public short lx,ly,rx,ry;}
 [StructLayout(LayoutKind.Sequential)] public struct State {public uint packet;public Pad pad;}
 [DllImport("xinput1_4.dll")] static extern uint XInputGetState(uint slot,out State state);
 static void Main(){for(uint i=0;i<4;i++){State s;if(XInputGetState(i,out s)==0)Console.WriteLine(i+","+s.pad.buttons+","+s.pad.lt+","+s.pad.rt+","+s.pad.lx+","+s.pad.ly+","+s.pad.rx+","+s.pad.ry);}}
}`;
writeFileSync(resolve(work,'Probe.cs'),source);
execFileSync(resolve(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/platform:x64',`/out:${resolve(work,'Probe.exe')}`,resolve(work,'Probe.cs')],{windowsHide:true});
const snapshot=()=>execFileSync(resolve(work,'Probe.exe'),{windowsHide:true,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean).map(line=>line.split(',').map(Number));
const helper=spawn(resolve(root,'native/BelayHost.exe'),[],{windowsHide:true});
const replies=new Map();let id=0;
createInterface({input:helper.stdout}).on('line',line=>{try{const m=JSON.parse(line);replies.get(m.id)?.(m);replies.delete(m.id);}catch{}});
const command=cmd=>new Promise((yes,no)=>{const serial=++id;const timer=setTimeout(()=>no(new Error('Native helper timeout')),5000);replies.set(serial,m=>{clearTimeout(timer);yes(m);});helper.stdin.write(JSON.stringify({id:serial,...cmd})+'\n');});
const state=sample=>helper.stdin.write(JSON.stringify({cmd:'gamepad',...sample})+'\n');
const neutral={buttons:0,lt:0,rt:0,lx:0,ly:0,rx:0,ry:0};
let heartbeat;
try {
 const status=await command({cmd:'gamepadattach',preset:'generic'});
 assert.equal(status.backend,'vigem',`Native Xbox input is unavailable: ${status.reason}. Run setup-controller.ps1 -InstallDriver.`);
 const sample={buttons:4096,lt:0.5,rt:1,lx:1,ly:-1,rx:-1,ry:1};
 heartbeat=setInterval(()=>state(sample),20);state(sample);
 let seen=null;
 for(let i=0;i<30;i++){seen=snapshot().find(p=>p.slice(1).join(',')==='4096,128,255,32767,-32768,-32768,32767');if(seen)break;await new Promise(r=>setTimeout(r,30));}
 assert.ok(seen,'XInput did not observe the transmitted state');
 clearInterval(heartbeat);state(neutral);await new Promise(r=>setTimeout(r,50));
 assert.deepEqual(snapshot().find(p=>p[0]===seen[0])?.slice(1),[0,0,0,0,0,0,0]);
 await command({cmd:'gamepaddetach'});await new Promise(r=>setTimeout(r,100));
 assert.equal(snapshot().some(p=>p[0]===seen[0]),false);
 console.log('PASS: native Xbox buttons, analog triggers, four axes, neutral release and detach verified through XInput.');
}finally{clearInterval(heartbeat);helper.stdin.end();setTimeout(()=>helper.kill(),1000).unref();}

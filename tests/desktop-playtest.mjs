import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from '../server/node_modules/ws/wrapper.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)), shots=resolve(root,'tests/screenshots/desktop');await mkdir(shots,{recursive:true});
const wss=new WebSocketServer({noServer:true});let streamer=null,gamepadFrames=0,lastPad=null;
const server=createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','authorization,content-type');
 if(req.method==='OPTIONS'){res.end();return;}
 const payload=req.url==='/pair'?{token:'local-test-token',name:'Gaming test host'}:req.url==='/health'?{platform:'win32'}:req.url==='/screen/info'?{screens:[{index:0,label:'Synthetic gaming display',W:1920,H:1080,primary:true}]}:req.url==='/ws-ticket'?{ticket:'local-test-ticket'}:{windows:[]};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(payload));
});
server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{
 if(req.url.startsWith('/ws/gamepad')){
  ws.send(JSON.stringify({type:'hello',available:true,backend:'vigem'}));ws.on('message',data=>{if(data.length===17){gamepadFrames++;lastPad=Buffer.from(data);}});return;
 }
 ws.on('message',raw=>{
  const msg=JSON.parse(raw.toString());
  if(msg.type==='bwpStop'){streamer?.kill();streamer=null;return;}
  if(msg.type!=='bwpStart')return;
  streamer?.kill();const child=spawn(resolve(root,'crates/belay-stream/target/release/belay-stream.exe'),[],{windowsHide:true});streamer=child;
  const token=randomBytes(32).toString('hex'),salt=randomBytes(8).toString('hex');
  createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(streamer!==child||ws.readyState!==1)return;
   if(m.type==='ready')ws.send(JSON.stringify({type:'bwpOffer',port:m.port,key:token,salt,width:m.width,height:m.height,path:m.path}));
   if(m.type==='error')ws.send(JSON.stringify({type:'bwpEnded',error:m.error}));
  });
  child.stdin.write(JSON.stringify({peer:`127.0.0.1:${msg.port}`,token,salt,preset:msg.preset,fps:msg.fps,source:'synthetic',encoder:process.env.BELAY_TEST_ENCODER==='nvenc'?'nvenc':'mf'})+'\n');
 });
 ws.on('close',()=>{streamer?.kill();streamer=null;});
}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let app;
try {
 const profile=await mkdtemp(resolve(tmpdir(),'belay-desktop-playtest-'));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:process.env.BELAY_DESKTOP_EXE||resolve(root,'desktop/node_modules/electron/dist/electron.exe'),args:[...(process.env.BELAY_DESKTOP_EXE?[]:[resolve(root,'desktop')]),`--user-data-dir=${profile}`],env});
 await app.context().addInitScript(()=>{
   const pad={connected:true,index:0,id:'DualSense test fixture',mapping:'standard',axes:[.5,-.5,0,0],buttons:Array.from({length:17},(_,i)=>({pressed:i===0,value:i===0?1:0}))};
   Object.defineProperty(navigator,'getGamepads',{value:()=>[pad]});
 });
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('#host').fill(`127.0.0.1:${server.address().port}`);await page.locator('#code').fill('123456');await page.locator('#connect').click();
 await expect(page.locator('#displays button')).toHaveCount(1);
 const opened=app.waitForEvent('window');await page.locator('#displays button').click();const display=await opened;
 display.on('pageerror',e=>errors.push(e.message));
 await expect(display.locator('#stats')).toContainText('H.264',{timeout:15000});
 await display.screenshot({path:resolve(shots,'h264.png')});
 await display.locator('#gaming').click();await expect(display.locator('#gaming')).toHaveAttribute('aria-pressed','true');
 await expect.poll(()=>gamepadFrames).toBeGreaterThan(2);
 expect(lastPad.readUInt16LE(1)).toBe(4096);expect(lastPad.readInt16LE(7)).toBe(16384);
 await expect(display.locator('#stats')).toContainText('H.264',{timeout:15000});
 await display.screenshot({path:resolve(shots,'gaming.png')});
 // Repeated mode changes exercise cancellation of pending receiver startups.
 for(let i=0;i<4;i++)await display.locator('#gaming').click();
 await expect(display.locator('#stats')).toContainText('H.264',{timeout:15000});
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('display.html'));w.setAspectRatio(0);w.setSize(500,420);});
 await display.screenshot({path:resolve(shots,'compact.png')});
 expect(await display.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await display.locator('#gaming').focus();await display.keyboard.press('Space');
 await expect(display.locator('#gaming')).toHaveAttribute('aria-pressed','false');
 await expect.poll(()=>lastPad?.readUInt16LE(1)).toBe(0);
 expect(errors).toEqual([]);
 console.log(JSON.stringify({result:'passed',checks:['pairing','H264 decode and presentation','gaming toggle','rapid toggles','compact layout','keyboard button activation'],gamepadFrames}));
} finally {await app?.close();streamer?.kill();for(const ws of wss.clients)ws.terminate();wss.close();server.close();}

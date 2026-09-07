import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachVideo } from '../renderer/video.js';
test('decoder backlog recovers on a keyframe without switching to JPEG', async () => {
  const originalDecoder=globalThis.VideoDecoder, originalChunk=globalThis.EncodedVideoChunk;
  let decoder, receive, requests=0, draws=0;const messages=[];
  globalThis.VideoDecoder=class {
    state='unconfigured';decodeQueueSize=0;
    constructor(callbacks){this.callbacks=callbacks;decoder=this;}
    configure(){this.state='configured';}
    reset(){this.state='unconfigured';this.decodeQueueSize=0;}
    close(){this.state='closed';}
    decode(){this.callbacks.output({displayWidth:100,displayHeight:100,close(){}});}
  };
  globalThis.EncodedVideoChunk=class {constructor(value){Object.assign(this,value);}};
  const bridge={stopVideo(){},reserveVideo:async()=>1234,onVideo(fn){receive=fn;},acknowledgeVideo(){},requestVideoKeyframe(){requests++;}};
  const video=attachVideo({bridge,canvas:{},context:{drawImage(){draws++;}},send:m=>messages.push(m),onFrame(){},onMode(){}});
  try {
    await video.start(true);
    const key={keyframe:true,generation:1,deliveryId:1,data:new Uint8Array([0,0,0,1,0x67,0x64,0,0x1f,0,0,0,1])};
    receive(key);assert.equal(draws,1);
    decoder.decodeQueueSize=3;receive({...key,keyframe:false});
    assert.equal(requests,1);assert.equal(decoder.state,'unconfigured');
    receive({...key,keyframe:false});assert.equal(draws,1);
    receive(key);assert.equal(draws,2);assert.equal(video.live,true);
    assert.equal(messages.filter(m=>m.type==='bwpStop').length,1);
  } finally {video.dispose();globalThis.VideoDecoder=originalDecoder;globalThis.EncodedVideoChunk=originalChunk;}
});

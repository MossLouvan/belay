/** H.264/UDP through the native receiver, decoded locally by WebCodecs. */
export function attachVideo({ bridge, canvas, context, send, onFrame, onMode }) {
  let epoch=0, decoder=null, active=false, live=false, timer=null, needKey=true, timestamp=0;
  const stop=()=>{
    epoch++;active=false;live=false;clearTimeout(timer);
    if(decoder && decoder.state!=='closed')decoder.close();decoder=null;
    void bridge?.stopVideo?.();send({type:'bwpStop'});
  };
  const fallback=()=>{stop();onMode('JPEG fallback · 30 fps limit');};
  const unframe=bridge?.onVideo?.(frame=>{
    try {
      if(!active || !frame?.data || !decoder) return;
      if(decoder.decodeQueueSize>2){
        // A short decoder stall should recover H.264, not permanently downgrade.
        decoder.reset();needKey=true;
        bridge.requestVideoKeyframe(frame.generation);
        clearTimeout(timer);const current=epoch;
        timer=setTimeout(()=>{if(current===epoch)fallback();},6000);
        return;
      }
      if(needKey&&!frame.keyframe)return;
      if(decoder.state==='unconfigured') {
        const bytes=new Uint8Array(frame.data);let codec=null;
        for(let i=0;i+7<bytes.length;i++) {
          const start=bytes[i]===0&&bytes[i+1]===0?(bytes[i+2]===1?i+3:bytes[i+2]===0&&bytes[i+3]===1?i+4:-1):-1;
          if(start>=0&&(bytes[start]&31)===7) {codec='avc1.'+Array.from(bytes.slice(start+1,start+4),b=>b.toString(16).padStart(2,'0')).join('');break;}
        }
        if(!codec)return;
        decoder.configure({codec,optimizeForLatency:true,hardwareAcceleration:'prefer-hardware'});
      }
      needKey=false;timestamp+=16667;
      decoder.decode(new EncodedVideoChunk({type:frame.keyframe?'key':'delta',timestamp,data:frame.data}));
    } catch {fallback();}
    finally {bridge.acknowledgeVideo(frame?.generation,frame?.deliveryId);}
  });
  const unend=bridge?.onVideoEnded?.(()=>{if(active)fallback();});
  return {
    get live(){return live;},
    async start(gaming) {
      stop();const current=epoch;
      if(!bridge?.reserveVideo || typeof VideoDecoder==='undefined')return;
      try {
        const port=await bridge.reserveVideo();
        if(current!==epoch)return;
        active=true;needKey=true;timestamp=0;
        decoder=new VideoDecoder({output:frame=>{
          try {if(current!==epoch)return;live=true;clearTimeout(timer);
            if(canvas.width!==frame.displayWidth||canvas.height!==frame.displayHeight){canvas.width=frame.displayWidth;canvas.height=frame.displayHeight;}
            context.drawImage(frame,0,0);onFrame();
          }finally{frame.close();}
        },error:()=>{if(current===epoch)fallback();}});
        send({type:'bwpStart',port,preset:gaming?'max':'high',fps:60});
        timer=setTimeout(()=>{if(current===epoch&&!live)fallback();},6000);
      }catch{if(current===epoch)fallback();}
    },
    handle(message,gaming) {
      if(!active)return false;
      if(message.type==='bwpOffer') {
        const current=epoch;
        void bridge.configureVideo(message,gaming?'max':'high').then(()=>{if(current===epoch)onMode(`H.264 / ${message.path==='gpu'?'GPU':'CPU'} · UDP`);}).catch(()=>{if(current===epoch)fallback();});
        return true;
      }
      if(message.type==='bwpEnded'||message.type==='bwpUnavailable'){fallback();return true;}
      return message.type==='bwpStats'||message.type==='bwpBitrate';
    },stop,
    dispose(){stop();unframe?.();unend?.();},
  };
}

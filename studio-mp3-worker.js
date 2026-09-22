self.onmessage = ({data}) => {
  try {
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js');
    const {channels,sampleRate,bitrate} = data;
    const count = Math.min(2,channels.length);
    const encoder = new lamejs.Mp3Encoder(count,sampleRate,bitrate || 192);
    const parts = [], frames = channels[0].length, block = 1152;
    const pcm = (source,start,end) => {
      const output = new Int16Array(end-start);
      for(let i=start;i<end;i++) { const x=Math.max(-1,Math.min(1,source[i])); output[i-start]=Math.round(x*(x<0?32768:32767)); }
      return output;
    };
    for(let start=0;start<frames;start+=block) {
      const end=Math.min(frames,start+block),left=pcm(channels[0],start,end);
      const bytes=count===2 ? encoder.encodeBuffer(left,pcm(channels[1],start,end)) : encoder.encodeBuffer(left);
      if(bytes.length) parts.push(new Uint8Array(bytes));
      if(start%(block*80)===0) self.postMessage({progress:start/frames});
    }
    const tail=encoder.flush(); if(tail.length) parts.push(new Uint8Array(tail));
    self.postMessage({done:true,parts},parts.map(p=>p.buffer));
  } catch(error) { self.postMessage({error:error.message || String(error)}); }
};

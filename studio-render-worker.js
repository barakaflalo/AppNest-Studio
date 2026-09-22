importScripts('studio-audio.js');
const sources = new Map();
self.onmessage = ({data}) => {
  try {
    if (data.type === 'source') {
      const {channels,sampleRate,id,name} = data;
      const buffer = {numberOfChannels:channels.length,length:channels[0].length,
        sampleRate,duration:channels[0].length/sampleRate,getChannelData:c=>channels[c]};
      sources.set(id,{buffer,name});
      return;
    }
    if (data.type === 'render') {
      const rendered = StudioAudio.render(data.clips,sources,data.options);
      // Layout contains metadata only; PCM is transferred, never copied back twice.
      self.postMessage({id:data.id,result:rendered},rendered.channels.map(c=>c.buffer));
    }
  } catch (error) { self.postMessage({id:data.id,error:error.message || String(error)}); }
};

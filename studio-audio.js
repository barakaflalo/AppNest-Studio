(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const db = value => value > 0 ? 20 * Math.log10(value) : -Infinity;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function finite(value, fallback, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(label + ' must be a finite number.');
    return value;
  }
  function inspect(buffer, label) {
    label = label || 'Audio';
    if (!buffer || typeof buffer.getChannelData !== 'function' ||
        !Number.isInteger(buffer.length) || buffer.length < 1 ||
        !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 ||
        !Number.isInteger(buffer.sampleRate) || buffer.sampleRate < 1) {
      throw new Error(label + ' is not a valid, non-empty audio buffer.');
    }
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channel = buffer.getChannelData(c);
      if (!channel || channel.length !== buffer.length) throw new Error(label + ' has an invalid channel length.');
      channels.push(channel);
    }
    return { buffer, channels, sampleRate: buffer.sampleRate, length: buffer.length, duration: buffer.length / buffer.sampleRate };
  }
  function sourceFor(sources, id) {
    const source = sources instanceof Map ? sources.get(id) : sources && Object.prototype.hasOwnProperty.call(sources, id) ? sources[id] : null;
    if (!source) throw new Error('Audio source "' + id + '" is missing.');
    return inspect(source.buffer, source.name || String(id));
  }
  function clipInfo(clip, sources, index) {
    if (!clip || typeof clip !== 'object') throw new Error('Clip ' + (index + 1) + ' is invalid.');
    const audio = sourceFor(sources, clip.sourceId);
    const from = clamp(finite(clip.in, 0, 'Clip in'), 0, audio.duration);
    const to = clamp(finite(clip.out, audio.duration, 'Clip out'), 0, audio.duration);
    const sourceStart = Math.round(from * audio.sampleRate);
    const sourceEnd = Math.round(to * audio.sampleRate);
    if (sourceEnd <= sourceStart) throw new Error('Clip "' + (clip.name || clip.id || index + 1) + '" must contain at least one audio sample.');
    const gainDb = finite(clip.gainDb, 0, 'Clip gain');
    const gain = Math.pow(10, gainDb / 20);
    if (!Number.isFinite(gain)) throw new Error('Clip gain is too large.');
    const durationFrames = sourceEnd - sourceStart;
    const fadeFrames = (value, label) => Math.min(durationFrames, Math.round(Math.max(0, finite(value, 0, label)) * audio.sampleRate));
    return {
      clip, audio, sourceStart, sourceEnd, durationFrames, gain,
      fadeInFrames: fadeFrames(clip.fadeIn, 'Fade in'),
      fadeOutFrames: fadeFrames(clip.fadeOut, 'Fade out')
    };
  }
  function buildLayout(clips, sources) {
    if (!Array.isArray(clips)) throw new Error('Clips must be an array.');
    const items = clips.map((clip, index) => clipInfo(clip, sources, index));
    let sampleRate = items.length ? items[0].audio.sampleRate : null;
    const segments = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i], previous = segments[i - 1];
      if (item.audio.sampleRate !== sampleRate) throw new Error('All audio sources must use the same sample rate. Import them through the project audio context.');
      const join = item.clip.join || {};
      const curve = !i || join.curve === undefined ? 'equalPower' : join.curve;
      if (curve !== 'linear' && curve !== 'equalPower') throw new Error('Crossfade curve must be linear or equalPower.');
      const requestedOverlap = i ? Math.max(0, finite(join.duration, 0, 'Crossfade duration')) : 0;
      const requestedOverlapFrames = Math.round(requestedOverlap * sampleRate);
      // A clip cannot spend the same sample in both incoming and outgoing joins.
      // This also prevents three sequence clips from playing simultaneously.
      const overlapFrames = previous ? Math.min(requestedOverlapFrames, item.durationFrames, previous.durationFrames - previous.overlapFrames) : 0;
      const startFrame = previous ? previous.endFrame - overlapFrames : 0;
      const endFrame = startFrame + item.durationFrames;
      segments.push({
        clip: item.clip, start: startFrame / sampleRate, end: endFrame / sampleRate,
        duration: item.durationFrames / sampleRate, overlap: overlapFrames / sampleRate,
        startFrame, endFrame, durationFrames: item.durationFrames, overlapFrames,
        sourceStart: item.sourceStart, sourceEnd: item.sourceEnd, curve,
        requestedOverlap
      });
    }
    const length = segments.length ? segments[segments.length - 1].endFrame : 0;
    return { items, segments, duration: sampleRate ? length / sampleRate : 0, length, sampleRate };
  }
  function layout(clips, sources) {
    const result = buildLayout(clips, sources);
    return { segments: result.segments, duration: result.duration, length: result.length, sampleRate: result.sampleRate };
  }
  function ramp(frame, count) {
    // A one-sample overlap uses the midpoint, keeping both signals represented.
    return count > 1 ? frame / (count - 1) : 0.5;
  }
  function render(clips, sources, options) {
    options = options || {};
    const timeline = buildLayout(clips, sources);
    let sampleRate = timeline.sampleRate, length = timeline.length;
    let backingItem = null, backingSegment = null;
    if (options.backing) {
      backingItem = clipInfo(options.backing, sources, 0);
      if (sampleRate && backingItem.audio.sampleRate !== sampleRate) throw new Error('Backing and clips must use the same sample rate.');
      sampleRate = sampleRate || backingItem.audio.sampleRate;
      const offset = finite(options.backing.offset, 0, 'Backing offset');
      if (offset < 0) throw new Error('Backing offset cannot be negative.');
      const startFrame = Math.round(offset * sampleRate);
      backingSegment = {
        clip: options.backing, start: startFrame / sampleRate,
        end: (startFrame + backingItem.durationFrames) / sampleRate,
        duration: backingItem.durationFrames / sampleRate, overlap: 0,
        startFrame, endFrame: startFrame + backingItem.durationFrames,
        durationFrames: backingItem.durationFrames, overlapFrames: 0,
        sourceStart: backingItem.sourceStart, sourceEnd: backingItem.sourceEnd
      };
      length = Math.max(length, backingSegment.endFrame);
    }
    if (!sampleRate || !length) throw new Error('Add at least one non-empty clip or backing track before rendering.');
    if (!Number.isSafeInteger(length) || length > 0x3fffffff) throw new Error('The requested audio timeline is too long.');
    const allItems = backingItem ? timeline.items.concat(backingItem) : timeline.items;
    const channelCount = Math.max(...allItems.map(item => item.audio.channels.length));
    // Mono is duplicated into every output channel; other missing channels are silent.
    const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
    function mix(item, segment, outgoing) {
      const n = item.durationFrames;
      for (let f = 0; f < n; f++) {
        let envelope = item.gain;
        if (item.fadeInFrames && f < item.fadeInFrames) envelope *= item.fadeInFrames === 1 ? 0 : ramp(f, item.fadeInFrames);
        if (item.fadeOutFrames && f >= n - item.fadeOutFrames) envelope *= item.fadeOutFrames === 1 ? 0 : 1 - ramp(f - (n - item.fadeOutFrames), item.fadeOutFrames);
        if (segment.overlapFrames && f < segment.overlapFrames) {
          const t = ramp(f, segment.overlapFrames);
          envelope *= segment.curve === 'linear' ? t : Math.sin(t * Math.PI / 2);
        }
        if (outgoing && outgoing.overlapFrames && f >= n - outgoing.overlapFrames) {
          const t = ramp(f - (n - outgoing.overlapFrames), outgoing.overlapFrames);
          envelope *= outgoing.curve === 'linear' ? 1 - t : Math.cos(t * Math.PI / 2);
        }
        for (let c = 0; c < channelCount; c++) {
          const input = item.audio.channels.length === 1 ? item.audio.channels[0] : item.audio.channels[c];
          if (!input) continue;
          const value = input[item.sourceStart + f];
          if (!Number.isFinite(value)) throw new Error('Audio source contains a non-finite sample.');
          const position = segment.startFrame + f;
          channels[c][position] += value * envelope;
          if (!Number.isFinite(channels[c][position])) throw new Error('Audio gain or mix exceeded the supported sample range.');
        }
      }
    }
    timeline.items.forEach((item, index) => mix(item, timeline.segments[index], timeline.segments[index + 1]));
    if (backingItem) mix(backingItem, backingSegment, null);
    let rawPeak = 0;
    for (const channel of channels) for (let i = 0; i < length; i++) rawPeak = Math.max(rawPeak, Math.abs(channel[i]));
    const ceilingDb = finite(options.ceilingDb, -1, 'Peak ceiling');
    if (ceilingDb > 0) throw new Error('Peak ceiling must be at or below 0 dBFS.');
    const ceiling = Math.pow(10, ceilingDb / 20);
    const scale = options.protectPeaks !== false && rawPeak > ceiling ? ceiling / rawPeak : 1;
    let peak = 0;
    for (const channel of channels) for (let i = 0; i < length; i++) {
      if (scale !== 1) channel[i] *= scale;
      peak = Math.max(peak, Math.abs(channel[i]));
    }
    return { channels, sampleRate, length, duration: length / sampleRate, segments: timeline.segments,
      backingSegment, peak, rawPeak, scale };
  }
  function range(buffer, from, to) {
    const audio = inspect(buffer);
    const start = Math.round(clamp(finite(from, 0, 'Range start'), 0, audio.duration) * audio.sampleRate);
    const end = Math.round(clamp(finite(to, audio.duration, 'Range end'), 0, audio.duration) * audio.sampleRate);
    if (end <= start) throw new Error('Analysis range must contain at least one audio sample.');
    return { audio, start, end };
  }
  function analyze(buffer, from, to) {
    const { audio, start, end } = range(buffer, from, to);
    let peak = 0, sumSquares = 0;
    for (const channel of audio.channels) for (let i = start; i < end; i++) {
      const value = channel[i];
      if (!Number.isFinite(value)) throw new Error('Audio source contains a non-finite sample.');
      peak = Math.max(peak, Math.abs(value));
      sumSquares += value * value;
    }
    const rms = Math.sqrt(sumSquares / ((end - start) * audio.channels.length));
    return { peak, rms, dbPeak: db(peak), dbRms: db(rms) };
  }
  function findSound(buffer, options) {
    options = options || {};
    const { audio, start, end } = range(buffer, options.from, options.to);
    const thresholdDb = finite(options.thresholdDb, -45, 'Silence threshold');
    const threshold = Math.pow(10, thresholdDb / 20);
    const windowMs = finite(options.windowMs, 10, 'Detection window');
    if (windowMs <= 0) throw new Error('Detection window must be positive.');
    const windowFrames = Math.max(1, Math.round(windowMs * audio.sampleRate / 1000));
    const padding = Math.round(Math.max(0, finite(options.paddingMs, 0, 'Silence padding')) * audio.sampleRate / 1000);
    let first = null, last = null;
    for (let s = start; s < end; s += windowFrames) {
      const e = Math.min(end, s + windowFrames);
      let loudestRms = 0;
      for (const channel of audio.channels) {
        let energy = 0;
        for (let i = s; i < e; i++) {
          if (!Number.isFinite(channel[i])) throw new Error('Audio source contains a non-finite sample.');
          energy += channel[i] * channel[i];
        }
        loudestRms = Math.max(loudestRms, Math.sqrt(energy / (e - s)));
      }
      if (loudestRms > threshold) { if (first === null) first = s; last = e; }
    }
    return { found: first !== null, in: (first === null ? start : Math.max(start, first - padding)) / audio.sampleRate,
      out: (last === null ? end : Math.min(end, last + padding)) / audio.sampleRate, thresholdDb };
  }
  function nearestZero(buffer, time, options) {
    const audio = inspect(buffer);
    const target = clamp(finite(time, 0, 'Cut time'), 0, audio.duration);
    if (target === 0 || target === audio.duration) return target;
    options = options || {};
    const windowMs = finite(options.windowMs, 5, 'Zero search window');
    if (windowMs < 0) throw new Error('Zero search window cannot be negative.');
    const center = Math.min(audio.length - 1, Math.round(target * audio.sampleRate));
    const radius = Math.round(windowMs * audio.sampleRate / 1000);
    let best = center, bestScore = Infinity;
    for (let i = Math.max(0, center - radius); i <= Math.min(audio.length - 1, center + radius); i++) {
      let score = 0;
      for (const channel of audio.channels) {
        if (!Number.isFinite(channel[i])) throw new Error('Audio source contains a non-finite sample.');
        score += Math.abs(channel[i]);
      }
      if (score < bestScore || (score === bestScore && Math.abs(i - center) < Math.abs(best - center))) { best = i; bestScore = score; }
    }
    return best / audio.sampleRate;
  }
  function encodeWav(input, options) {
    options = options || {};
    const bitDepth = options.bitDepth === undefined ? 24 : options.bitDepth;
    if (![16, 24, 32].includes(bitDepth)) throw new Error('WAV bit depth must be 16, 24, or 32.');
    let audio;
    if (input && Array.isArray(input.channels)) {
      audio = inspect({ sampleRate: input.sampleRate, length: input.length === undefined ? input.channels[0] && input.channels[0].length : input.length,
        numberOfChannels: input.channels.length, getChannelData: c => input.channels[c] });
    } else audio = inspect(input);
    const channelCount = audio.channels.length;
    const bytesPerSample = bitDepth / 8, blockAlign = channelCount * bytesPerSample;
    const dataSize = audio.length * blockAlign;
    // IEEE float WAV includes the required fact chunk with the sample-frame count.
    const headerSize = bitDepth === 32 ? 56 : 44;
    const padding = dataSize % 2;
    if (dataSize + padding + headerSize - 8 > 0xffffffff || blockAlign > 0xffff || audio.sampleRate * blockAlign > 0xffffffff) throw new Error('Audio is too large for a standard WAV file.');
    const bytes = new ArrayBuffer(headerSize + dataSize + padding), view = new DataView(bytes);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
    view.setUint16(22, channelCount, true); view.setUint32(24, audio.sampleRate, true);
    view.setUint32(28, audio.sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, bitDepth, true);
    if (bitDepth === 32) { text(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, audio.length, true); }
    text(headerSize - 8, 'data'); view.setUint32(headerSize - 4, dataSize, true);
    let offset = headerSize;
    for (let i = 0; i < audio.length; i++) for (const channel of audio.channels) {
      const sample = channel[i];
      if (!Number.isFinite(sample)) throw new Error('Cannot encode a non-finite audio sample.');
      const value = clamp(sample, -1, 1);
      if (bitDepth === 16) view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      else if (bitDepth === 24) {
        const pcm = Math.round(value * (value < 0 ? 8388608 : 8388607));
        view.setUint8(offset, pcm & 255); view.setUint8(offset + 1, (pcm >> 8) & 255); view.setUint8(offset + 2, (pcm >> 16) & 255);
      } else {
        view.setFloat32(offset, sample, true);
        if (!Number.isFinite(view.getFloat32(offset, true))) throw new Error('Audio sample exceeds the float32 WAV range.');
      }
      offset += bytesPerSample;
    }
    return bytes;
  }
  return Object.freeze({ layout, render, analyze, findSound, nearestZero, encodeWav });
});

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioDJAnalysis = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  // A tempo suggestion, not a beat-tracking guarantee. Polyphonic music, tempo
  // changes, intros and half/double-time rhythms need listening and manual edits.
  const MIN_BPM = 40, MAX_BPM = 240, MAX_PEAKS = 12000;
  const ANALYSIS_SECONDS = 180, ENVELOPE_HZ = 200;
  function validBpm(value) {
    if (!Number.isFinite(value) || value < MIN_BPM || value > MAX_BPM) throw new RangeError('BPM must be between 40 and 240.');
    return value;
  }
  function beatSeconds(bpm) { return 60 / validBpm(bpm); }
  function rateForBpm(sourceBpm, targetBpm) {
    const rate = validBpm(targetBpm) / validBpm(sourceBpm);
    if (rate < 0.5 || rate > 2) throw new RangeError('The required playback rate must be between 0.5 and 2.');
    return rate;
  }
  function nearestBeat(time, bpm, offset) {
    if (!Number.isFinite(time) || time < 0) throw new RangeError('Time must be a finite, nonnegative number.');
    offset = offset === undefined ? 0 : offset;
    if (!Number.isFinite(offset)) throw new RangeError('Beat offset must be finite.');
    const period = beatSeconds(bpm);
    const phase = ((offset % period) + period) % period;
    const n = Math.max(0, Math.round((time - phase) / period));
    return phase + n * period;
  }
  const median = values => {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    const half = Math.floor(values.length / 2);
    return values.length % 2 ? values[half] : (values[half - 1] + values[half]) / 2;
  };
  function phaseFor(events, period) {
    let x = 0, y = 0, weights = 0;
    for (const event of events) {
      const angle = 2 * Math.PI * event.time / period;
      x += event.weight * Math.cos(angle); y += event.weight * Math.sin(angle); weights += event.weight;
    }
    const angle = (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
    return { offset: angle * period / (2 * Math.PI), coherence: weights ? Math.hypot(x, y) / weights : 0 };
  }
  function refinePeriod(events, initial) {
    const intervals = [];
    for (let i = 0; i < events.length; i++) {
      for (let j = Math.max(0, i - 8); j < i; j++) {
        const delta = events[i].time - events[j].time, beats = Math.round(delta / initial);
        if (beats >= 1 && beats <= 8 && Math.abs(delta - beats * initial) < initial * 0.08) intervals.push(delta / beats);
      }
    }
    let period = intervals.length >= 4 ? median(intervals) : initial;
    // Fit only onsets near the proposed beat grid. Off-beat subdivisions must
    // not pull the grid away from stronger pulse onsets.
    for (let pass = 0; pass < 2; pass++) {
      const phase = phaseFor(events, period).offset;
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, count = 0;
      for (const e of events) {
        const n = Math.round((e.time - phase) / period);
        if (Math.abs(e.time - phase - n * period) > period * 0.15) continue;
        const w = e.weight;
        sw += w; sx += w * n; sy += w * e.time; sxx += w * n * n; sxy += w * n * e.time; count++;
      }
      const denominator = sw * sxx - sx * sx;
      if (count < 5 || denominator <= 1e-12) break;
      const fitted = (sw * sxy - sx * sy) / denominator;
      if (!Number.isFinite(fitted) || Math.abs(fitted / initial - 1) > 0.06) break;
      period = fitted;
    }
    return period;
  }
  function analyze(channels, sampleRate) {
    if (!Array.isArray(channels) || !channels.length || channels.length > 32 || !channels.every(c => c instanceof Float32Array)) {
      throw new TypeError('Audio channels must be an array of Float32Array values (1–32 channels).');
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) throw new RangeError('Unsupported sample rate.');
    const length = Math.max(...channels.map(c => c.length));
    const bucket = Math.max(1, Math.ceil(length / MAX_PEAKS));
    const peaks = new Float32Array(Math.ceil(length / bucket));
    const result = { bpm: null, confidence: 0, beatOffset: 0, peaks, peakStep: bucket / sampleRate, alternatives: [] };
    if (!length) return result;
    const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ));
    const analyzedLength = Math.min(length, Math.floor(sampleRate * ANALYSIS_SECONDS));
    const envelope = new Float32Array(Math.ceil(analyzedLength / hop));
    let energy = 0, frames = 0, envelopeIndex = 0;
    // Waveform covers the entire file; tempo is intentionally bounded to its
    // first three minutes. This pass is O(samples * channels), with bounded
    // waveform output and no quadratic comparisons of audio samples.
    for (let i = 0; i < length; i++) {
      let maximum = 0, square = 0;
      for (const channel of channels) {
        const sample = channel[i];
        if (!Number.isFinite(sample)) continue;
        const absolute = Math.abs(sample);
        if (absolute > maximum) maximum = absolute;
        if (i < analyzedLength) square += sample * sample;
      }
      const bin = Math.floor(i / bucket);
      if (maximum > peaks[bin]) peaks[bin] = Math.min(1, maximum);
      if (i < analyzedLength) {
        energy += square / channels.length; frames++;
        if (frames === hop || i === analyzedLength - 1) {
          envelope[envelopeIndex++] = Math.sqrt(energy / frames); energy = 0; frames = 0;
        }
      }
    }
    if (analyzedLength / sampleRate < 4 || envelope.length < 8) return result;
    const onset = new Float32Array(envelope.length);
    let onsetMaximum = 0, sum = 0;
    for (let i = 0; i < envelope.length; i++) {
      const previous = i ? envelope[i - 1] : 0;
      const older = i > 1 ? envelope[i - 2] : previous;
      const value = Math.max(0, envelope[i] - 0.75 * previous - 0.25 * older);
      onset[i] = value; sum += value; onsetMaximum = Math.max(onsetMaximum, value);
    }
    if (onsetMaximum < 0.00001) return result;
    const frameSeconds = hop / sampleRate;
    const threshold = Math.max(onsetMaximum * 0.08, sum / onset.length * 1.25);
    const events = [];
    for (let i = 0; i < onset.length; i++) {
      if (onset[i] < threshold || (i && onset[i] < onset[i - 1]) || (i + 1 < onset.length && onset[i] <= onset[i + 1])) continue;
      const event = { time: i * frameSeconds, weight: onset[i] / onsetMaximum };
      const previous = events[events.length - 1];
      if (previous && event.time - previous.time < 0.075) { if (event.weight > previous.weight) events[events.length - 1] = event; }
      else events.push(event);
    }
    if (events.length < 5) return result;
    // Mean-centering prevents a steady noisy envelope from looking periodic
    // merely because all onset values are positive.
    const mean = sum / onset.length;
    let totalEnergy = 0;
    for (let i = 0; i < onset.length; i++) { onset[i] -= mean; totalEnergy += onset[i] * onset[i]; }
    if (totalEnergy < 1e-12) return result;
    const hz = 1 / frameSeconds;
    const minLag = Math.floor(hz * 60 / 180), maxLag = Math.ceil(hz * 60 / 70);
    const maxCorrelationLag = Math.min(onset.length - 2, maxLag * 4 + 2);
    const correlations = new Float32Array(maxCorrelationLag + 1);
    for (let lag = minLag - 1; lag <= maxCorrelationLag; lag++) {
      let cross = 0, left = 0, right = 0;
      for (let i = lag; i < onset.length; i++) {
        const a = onset[i], b = onset[i - lag]; cross += a * b; left += a * a; right += b * b;
      }
      correlations[lag] = left && right ? Math.max(0, cross / Math.sqrt(left * right)) : 0;
    }
    const correlation = lag => {
      const lower = Math.floor(lag), fraction = lag - lower;
      return lower < 0 || lower + 1 >= correlations.length ? 0 : correlations[lower] * (1 - fraction) + correlations[lower + 1] * fraction;
    };
    const score = lag => correlation(lag) + 0.4 * correlation(2 * lag) + 0.2 * correlation(3 * lag) + 0.1 * correlation(4 * lag);
    const candidates = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      const value = score(lag);
      if (value >= score(lag - 1) && value >= score(lag + 1)) candidates.push({ lag, score: value, primary: correlation(lag) });
    }
    candidates.sort((a, b) => b.score - a.score || a.lag - b.lag);
    const best = candidates[0];
    if (!best || best.primary < 0.13 || best.score < 0.2) return result;
    const period = refinePeriod(events, best.lag / hz);
    const rawBpm = 60 / period;
    if (rawBpm < 69.5 || rawBpm > 180.5) return result;
    const phase = phaseFor(events, period);
    const bpm = Math.round(Math.max(70, Math.min(180, rawBpm)) * 10) / 10;
    result.bpm = bpm;
    result.beatOffset = phase.offset;
    result.confidence = Math.max(0, Math.min(1, 0.65 * Math.min(1, best.score / 1.5) + 0.35 * phase.coherence));
    const alternatives = [];
    for (const value of [bpm / 2, bpm * 2]) if (value >= MIN_BPM && value <= MAX_BPM) alternatives.push(Math.round(value * 10) / 10);
    for (const candidate of candidates.slice(1, 4)) {
      const other = Math.round(60 * hz / candidate.lag * 10) / 10;
      if (candidate.score >= best.score * 0.8 && other >= 70 && other <= 180 && Math.abs(other - bpm) > 3 && alternatives.every(v => Math.abs(v - other) > 3)) alternatives.push(other);
    }
    result.alternatives = alternatives.slice(0, 3);
    return result;
  }
  return Object.freeze({ analyze, nearestBeat, beatSeconds, rateForBpm });
});

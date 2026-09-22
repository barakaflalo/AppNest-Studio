(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(() => require('./studio-projects.js'));
  else root.StudioDJSession = factory(() => root.StudioProjects);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getProjects) {
  'use strict';
  const MAX_BYTES = 512 * 1024 * 1024, MAX_HEADER_BYTES = 4 * 1024 * 1024;
  const DECKS = ['A', 'B'], MAGIC = [65, 80, 80, 78, 69, 83, 84, 49];
  const fail = message => { throw new Error('AppNest DJ session: ' + message); };
  function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object.'); }
  function number(value, label, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label + ' is out of range.'); return value; }
  function integer(value, label, min, max) { number(value, label, min, max); if (!Number.isSafeInteger(value)) fail(label + ' must be an integer.'); return value; }
  function name(value, label) { if (typeof value !== 'string' || value.length > 1024) fail(label + ' must be text of at most 1024 characters.'); return value; }
  function api(value) { const result = value || getProjects(); if (!result || typeof result.exportProject !== 'function' || typeof result.importProject !== 'function') fail('The portable-project module is unavailable. Reload the complete app.'); return result; }
  function dimensions(buffer, label) {
    object(buffer, label + ' audio');
    if (buffer.sampleRate !== 48000) fail(label + ' audio must be decoded at 48000 Hz.');
    integer(buffer.numberOfChannels, label + ' channels', 1, 2);
    integer(buffer.length, label + ' frames', 1, MAX_BYTES / 4);
    integer(buffer.length * buffer.numberOfChannels * 4, label + ' audio size', 4, MAX_BYTES);
    return buffer.length / buffer.sampleRate;
  }
  function deckConfig(deck, label, duration) {
    object(deck, label);
    if (deck.bpm !== null) number(deck.bpm, label + ' BPM', 40, 240);
    object(deck.eq, label + ' EQ');
    return {
      bpm: deck.bpm,
      beatOffset: number(deck.beatOffset, label + ' beat offset', 0, duration),
      cue: number(deck.cue, label + ' cue', 0, duration),
      rate: number(deck.rate, label + ' playback rate', .5, 2),
      gain: number(deck.gain, label + ' gain', -60, 12),
      eq: { low: number(deck.eq.low, label + ' low EQ', -24, 12), mid: number(deck.eq.mid, label + ' mid EQ', -24, 12), high: number(deck.eq.high, label + ' high EQ', -24, 12) }
    };
  }
  function config(value, durations) {
    object(value, 'session'); object(value.decks, 'decks'); object(value.transition, 'transition');
    const decks = {}, t = value.transition;
    for (const id of DECKS) {
      if (durations.has(id)) decks[id] = deckConfig(value.decks[id], 'Deck ' + id, durations.get(id));
      else { if (value.decks[id] != null) fail('Deck ' + id + ' has settings without audio.'); decks[id] = null; }
    }
    if (!durations.size) fail('Load audio into at least one deck before saving.');
    if (!['linear', 'equalPower'].includes(t.curve)) fail('The transition curve must be linear or equalPower.');
    return {
      name: name(value.name, 'Session name'), decks,
      transition: { targetBpm: number(t.targetBpm, 'Transition BPM', 40, 240), bars: integer(t.bars, 'Transition bars', 1, 32), preRoll: number(t.preRoll, 'Pre-roll', 0, 30), postRoll: number(t.postRoll, 'Post-roll', 0, 30), curve: t.curve },
      crossfader: number(value.crossfader, 'Crossfader', -1, 1), master: number(value.master, 'Master gain', -60, 0)
    };
  }
  function exportSession(value, projectsAPI) {
    object(value, 'session'); object(value.decks, 'decks');
    const sources = new Map(), durations = new Map(), inputDecks = {};
    for (const id of DECKS) {
      const deck = value.decks[id];
      if (deck == null || (typeof deck === 'object' && !Array.isArray(deck) && deck.buffer == null)) { inputDecks[id] = null; continue; }
      object(deck, 'Deck ' + id); const duration = dimensions(deck.buffer, 'Deck ' + id);
      if (typeof deck.buffer.getChannelData !== 'function') fail('Deck ' + id + ' has no decoded audio.');
      sources.set(id, { name: name(deck.name, 'Deck ' + id + ' name'), buffer: deck.buffer }); durations.set(id, duration); inputDecks[id] = deck;
    }
    const clean = config({ name: value.name, decks: inputDecks, transition: value.transition, crossfader: value.crossfader, master: value.master }, durations);
    const project = { version: 1, id: 'appnest-dj-session-v1', name: clean.name, clips: [], activeId: null,
      selection: { a: 0, b: 0 }, master: { protectPeaks: true }, backing: null,
      dj: { version: 1, decks: clean.decks, transition: clean.transition, crossfader: clean.crossfader, master: clean.master } };
    return new Blob([api(projectsAPI).exportProject(project, sources)], { type: 'application/vnd.appnest.dj-session' });
  }
  function fromHeader(header, fileSize, headerBytes) {
    object(header, 'file header');
    if (header.format !== 'appnest-project' || header.version !== 1 || !header.project || !header.project.dj || header.project.dj.version !== 1) fail('This is not a supported AppNest DJ session. Open an .appnest-dj file, not a regular .appnest editing project.');
    if (!Array.isArray(header.sources) || header.sources.length < 1 || header.sources.length > 2) fail('A DJ session must contain one or two audio sources.');
    const durations = new Map(); let offset = 0;
    for (const source of header.sources) {
      object(source, 'audio descriptor');
      if (!DECKS.includes(source.id) || durations.has(source.id)) fail('The DJ audio deck IDs must be unique A and B.');
      name(source.name, 'Audio name'); const duration = dimensions(source, 'Deck ' + source.id), bytes = source.numberOfChannels * source.length * 4;
      if (source.byteOffset !== offset || source.byteLength !== bytes) fail('The DJ audio offsets or lengths are invalid.');
      offset += bytes; if (offset > MAX_BYTES) fail('Audio exceeds 512 MiB.'); durations.set(source.id, duration);
    }
    if (12 + headerBytes + offset !== fileSize) fail('The DJ session is truncated or contains unexpected audio.');
    const dj = header.project.dj;
    return config({ name: header.project.name, decks: dj.decks, transition: dj.transition, crossfader: dj.crossfader, master: dj.master }, durations);
  }
  async function importSession(blob, createBufferFn, projectsAPI) {
    if (!blob || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') fail('Choose a portable .appnest-dj session file.');
    integer(blob.size, 'File size', 14, MAX_BYTES);
    if (typeof createBufferFn !== 'function') fail('An audio buffer factory is required.');
    const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (prefix.length !== 12 || !MAGIC.every((value, index) => prefix[index] === value)) fail('This is not an AppNest DJ session file.');
    const headerBytes = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(8, true);
    integer(headerBytes, 'Header size', 2, MAX_HEADER_BYTES);
    if (12 + headerBytes > blob.size) fail('The session metadata is truncated.');
    let header;
    try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await blob.slice(12, 12 + headerBytes).arrayBuffer())); }
    catch (_) { fail('The session metadata is not valid UTF-8 JSON.'); }
    // Reject wrong format and out-of-range DJ settings before allocating any audio buffers.
    fromHeader(header, blob.size, headerBytes);
    const loaded = await api(projectsAPI).importProject(blob, createBufferFn), durations = new Map(), decks = {};
    for (const id of DECKS) {
      const source = loaded.sources.get(id);
      if (source) durations.set(id, dimensions(source.buffer, 'Deck ' + id));
    }
    if (loaded.sources.size !== durations.size) fail('The session contains unknown audio sources.');
    const dj = loaded.project.dj, clean = config({ name: loaded.project.name, decks: dj.decks, transition: dj.transition, crossfader: dj.crossfader, master: dj.master }, durations);
    for (const id of DECKS) { const source = loaded.sources.get(id); decks[id] = source ? { buffer: source.buffer, name: source.name, ...clean.decks[id] } : null; }
    return { ...clean, decks };
  }
  return Object.freeze({ exportSession, importSession });
});

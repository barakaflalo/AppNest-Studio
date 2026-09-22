(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioProjects = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_BYTES = 512 * 1024 * 1024;
  const MAX_HEADER_BYTES = 4 * 1024 * 1024;
  const MAX_SOURCES = 1000;
  const MAX_CLIPS = 10000;
  const SAMPLE_RATE = 48000;
  const MAGIC = new Uint8Array([65, 80, 80, 78, 69, 83, 84, 49]); // APPNEST1
  const PREFIX_BYTES = 12;
  const DB_NAME = 'appnest-studio-projects-v1';
  const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const encoder = new TextEncoder();
  let databasePromise;
  let saveQueue = Promise.resolve();
  let storedBuffers = new Map();
  let storedRevision = null;

  function fail(message) { throw new Error('AppNest project: ' + message); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object.');
  }
  function string(value, label, max, allowEmpty) {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) fail(label + ' is invalid.');
  }
  function number(value, label, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label + ' is out of range.');
  }
  function integer(value, label, min, max) {
    number(value, label, min, max);
    if (!Number.isSafeInteger(value)) fail(label + ' must be an integer.');
  }
  function jsonCopy(value) {
    const ancestors = new Set();
    function check(item, depth) {
      if (depth > 32) fail('metadata is nested too deeply.');
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number') {
        if (!Number.isFinite(item)) fail('metadata contains a non-finite number.');
        return;
      }
      if (!item || typeof item !== 'object') fail('metadata must contain JSON values only.');
      if (ancestors.has(item)) fail('metadata contains a cycle.');
      const proto = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) fail('metadata contains an unsupported object.');
      ancestors.add(item);
      for (const key of Object.keys(item)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail('metadata contains an unsafe key.');
        check(item[key], depth + 1);
      }
      ancestors.delete(item);
    }
    check(value, 0);
    const json = JSON.stringify(value);
    if (encoder.encode(json).byteLength > MAX_HEADER_BYTES) fail('metadata exceeds 4 MiB.');
    return JSON.parse(json);
  }
  function validateSourceDescriptor(source, ids) {
    object(source, 'source');
    string(source.id, 'source ID', 256, false);
    if (ids.has(source.id)) fail('duplicate source ID.');
    ids.add(source.id);
    string(source.name, 'source name', 1024, true);
    integer(source.numberOfChannels, 'source channels', 1, 32);
    integer(source.length, 'source frames', 1, MAX_BYTES / 4);
    if (source.sampleRate !== SAMPLE_RATE) fail('sources must be decoded at 48000 Hz.');
    const bytes = source.numberOfChannels * source.length * 4;
    integer(bytes, 'source size', 4, MAX_BYTES);
    return bytes;
  }
  function validateRegion(region, sources, label) {
    object(region, label);
    string(region.sourceId, label + ' source ID', 256, false);
    const source = sources.get(region.sourceId);
    if (!source) fail(label + ' references a missing source.');
    const duration = source.length / source.sampleRate;
    number(region.in, label + ' start', 0, duration);
    number(region.out, label + ' end', 0, duration);
    if (region.out <= region.in) fail(label + ' must have positive duration.');
    number(region.gainDb, label + ' gain', -96, 24);
    number(region.fadeIn, label + ' fade in', 0, region.out - region.in);
    number(region.fadeOut, label + ' fade out', 0, region.out - region.in);
  }
  function validateProject(project, descriptors) {
    object(project, 'project');
    if (project.version !== 1) fail('unsupported project version.');
    string(project.id, 'project ID', 256, false);
    string(project.name, 'project name', 1024, true);
    if (!Array.isArray(project.clips) || project.clips.length > MAX_CLIPS) fail('invalid clip list.');
    const sources = new Map(descriptors.map(source => [source.id, source]));
    const clipIds = new Set();
    for (const clip of project.clips) {
      validateRegion(clip, sources, 'clip');
      string(clip.id, 'clip ID', 256, false);
      if (clipIds.has(clip.id)) fail('duplicate clip ID.');
      clipIds.add(clip.id);
      string(clip.name, 'clip name', 1024, true);
      if (clip.join !== undefined) {
        object(clip.join, 'clip join');
        // Preserve requested overlap; the audio layout limits actual overlap to available audio.
        number(clip.join.duration, 'join duration', 0, 86400);
        if (!['linear', 'equalPower', 'equal-power'].includes(clip.join.curve)) fail('unsupported join curve.');
      }
    }
    if (project.activeId != null && !clipIds.has(project.activeId)) fail('active clip is missing.');
    if (project.selection !== undefined) {
      object(project.selection, 'selection');
      number(project.selection.a, 'selection start', 0, Number.MAX_SAFE_INTEGER);
      number(project.selection.b, 'selection end', project.selection.a, Number.MAX_SAFE_INTEGER);
    }
    if (project.master !== undefined) {
      object(project.master, 'master');
      if (typeof project.master.protectPeaks !== 'boolean') fail('peak protection must be a boolean.');
    }
    if (project.backing != null) {
      validateRegion(project.backing, sources, 'backing');
      number(project.backing.offset, 'backing offset', 0, Number.MAX_SAFE_INTEGER);
    }
  }
  function snapshot(project, sources) {
    if (!(sources instanceof Map) || sources.size > MAX_SOURCES) fail('invalid source map.');
    const copied = jsonCopy(project);
    const descriptors = [];
    const buffers = new Map();
    const ids = new Set();
    let byteOffset = 0;
    for (const [id, source] of sources) {
      object(source, 'source');
      const buffer = source.buffer;
      if (!buffer || typeof buffer.getChannelData !== 'function') fail('source has no decoded audio.');
      const descriptor = { id, name: source.name, sampleRate: buffer.sampleRate,
        numberOfChannels: buffer.numberOfChannels, length: buffer.length, byteOffset,
        byteLength: buffer.numberOfChannels * buffer.length * 4 };
      byteOffset += validateSourceDescriptor(descriptor, ids);
      if (byteOffset > MAX_BYTES) fail('audio exceeds 512 MiB.');
      descriptors.push(descriptor);
      buffers.set(id, buffer);
    }
    validateProject(copied, descriptors);
    return { project: copied, descriptors, buffers, audioBytes: byteOffset };
  }
  function channel(buffer, index, length) {
    const data = buffer.getChannelData(index);
    if (Object.prototype.toString.call(data) !== '[object Float32Array]' || data.length !== length) fail('invalid audio channel.');
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) fail('audio contains non-finite samples.');
    return data;
  }
  function metadata(state) {
    const header = encoder.encode(JSON.stringify({ format: 'appnest-project', version: 1,
      project: state.project, sources: state.descriptors }));
    if (header.byteLength > MAX_HEADER_BYTES) fail('metadata exceeds 4 MiB.');
    if (PREFIX_BYTES + header.byteLength + state.audioBytes > MAX_BYTES) fail('project exceeds 512 MiB.');
    return header;
  }
  function exportProject(project, sources) {
    const state = snapshot(project, sources);
    const header = metadata(state);
    const prefix = new Uint8Array(PREFIX_BYTES);
    prefix.set(MAGIC);
    new DataView(prefix.buffer).setUint32(8, header.byteLength, true);
    const parts = [prefix, header];
    for (const source of state.descriptors) {
      const buffer = state.buffers.get(source.id);
      for (let c = 0; c < source.numberOfChannels; c++) {
        const data = channel(buffer, c, source.length);
        if (LITTLE_ENDIAN) parts.push(data);
        else {
          const bytes = new ArrayBuffer(data.length * 4);
          const view = new DataView(bytes);
          for (let i = 0; i < data.length; i++) view.setFloat32(i * 4, data[i], true);
          parts.push(bytes);
        }
      }
    }
    return new Blob(parts, { type: 'application/vnd.appnest.project' });
  }
  function validateHeader(header, availableBytes) {
    object(header, 'header');
    if (header.format !== 'appnest-project' || header.version !== 1) fail('unsupported file format.');
    if (!Array.isArray(header.sources) || header.sources.length > MAX_SOURCES) fail('invalid source list.');
    const ids = new Set();
    let expectedOffset = 0;
    for (const source of header.sources) {
      const bytes = validateSourceDescriptor(source, ids);
      integer(source.byteOffset, 'audio offset', 0, MAX_BYTES);
      integer(source.byteLength, 'audio length', 4, MAX_BYTES);
      if (source.byteOffset !== expectedOffset || source.byteLength !== bytes) fail('invalid audio dimensions or offsets.');
      expectedOffset += bytes;
      if (expectedOffset > MAX_BYTES) fail('audio exceeds 512 MiB.');
    }
    if (expectedOffset !== availableBytes) fail('truncated file or unexpected trailing audio.');
    validateProject(header.project, header.sources);
  }
  function allocateSources(project, descriptors, getSamples, createBufferFn) {
    if (typeof createBufferFn !== 'function') fail('an audio buffer factory is required.');
    const sources = new Map();
    for (const source of descriptors) {
      const buffer = createBufferFn(source.numberOfChannels, source.length, source.sampleRate);
      if (!buffer || buffer.numberOfChannels !== source.numberOfChannels || buffer.length !== source.length ||
        buffer.sampleRate !== source.sampleRate || typeof buffer.getChannelData !== 'function') fail('audio buffer factory returned invalid dimensions.');
      for (let c = 0; c < source.numberOfChannels; c++) {
        const target = buffer.getChannelData(c);
        if (Object.prototype.toString.call(target) !== '[object Float32Array]' || target.length !== source.length) fail('invalid destination audio channel.');
        target.set(getSamples(source, c));
      }
      sources.set(source.id, { name: source.name, buffer });
    }
    return { project, sources };
  }
  async function importProject(blob, createBufferFn) {
    if (!blob || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') fail('a project file is required.');
    integer(blob.size, 'file size', PREFIX_BYTES, MAX_BYTES);
    const prefix = new Uint8Array(await blob.slice(0, PREFIX_BYTES).arrayBuffer());
    if (prefix.length !== PREFIX_BYTES || !MAGIC.every((value, i) => prefix[i] === value)) fail('not an AppNest project file.');
    const headerBytes = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(8, true);
    integer(headerBytes, 'header size', 2, MAX_HEADER_BYTES);
    if (PREFIX_BYTES + headerBytes > blob.size) fail('truncated metadata.');
    let header;
    try {
      header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await blob.slice(PREFIX_BYTES, PREFIX_BYTES + headerBytes).arrayBuffer()));
    } catch (_) { fail('metadata is not valid UTF-8 JSON.'); }
    header = jsonCopy(header);
    validateHeader(header, blob.size - PREFIX_BYTES - headerBytes);
    const audio = await blob.slice(PREFIX_BYTES + headerBytes).arrayBuffer();
    const view = new DataView(audio);
    // Reject invalid PCM anywhere before creating an AudioBuffer or returning partial audio.
    for (let i = 0; i < audio.byteLength; i += 4) if (!Number.isFinite(view.getFloat32(i, true))) fail('audio contains non-finite samples.');
    return allocateSources(header.project, header.sources, (source, c) => {
      const offset = source.byteOffset + c * source.length * 4;
      if (LITTLE_ENDIAN) return new Float32Array(audio, offset, source.length);
      const data = new Float32Array(source.length);
      for (let i = 0; i < source.length; i++) data[i] = view.getFloat32(offset + i * 4, true);
      return data;
    }, createBufferFn);
  }
  function database() {
    if (!globalThis.indexedDB) return Promise.reject(new Error('AppNest project: browser storage is unavailable.'));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(DB_NAME, 1);
        let blocked = false;
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
          if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
        };
        request.onerror = () => { databasePromise = undefined; reject(request.error || new Error('Could not open project storage.')); };
        request.onblocked = () => { blocked = true; databasePromise = undefined; reject(new Error('AppNest project: storage upgrade is blocked by another tab.')); };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) { db.close(); return; }
          db.onversionchange = () => { db.close(); databasePromise = undefined; storedBuffers.clear(); storedRevision = null; };
          resolve(db);
        };
      });
      // A synchronous open failure (for example, a denied storage policy) is retryable.
      databasePromise = databasePromise.catch(error => { databasePromise = undefined; throw error; });
    }
    return databasePromise;
  }
  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('AppNest project: storage transaction was aborted.'));
      transaction.onerror = () => {}; // Abort is the final transaction result, including quota failures.
    });
  }
  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('AppNest project: storage request failed.'));
    });
  }
  function save(project, sources) {
    let state;
    try { state = snapshot(project, sources); metadata(state); }
    catch (error) { return Promise.reject(error); }
    const task = saveQueue.then(async () => {
      const db = await database();
      const changed = new Map();
      for (const source of state.descriptors) {
        const buffer = state.buffers.get(source.id);
        if (storedBuffers.get(source.id) !== buffer) {
          const channels = [];
          for (let c = 0; c < source.numberOfChannels; c++) channels.push(new Float32Array(channel(buffer, c, source.length)).buffer);
          changed.set(source.id, { ...source, channels });
        }
      }
      const tx = db.transaction(['projects', 'sources'], 'readwrite');
      const done = transactionDone(tx);
      const sourceStore = tx.objectStore('sources');
      const keysRequest = sourceStore.getAllKeys();
      const latestRequest = tx.objectStore('projects').get('latest');
      const revision = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      const savedAt = Date.now();
      let keysReady = false;
      let latestReady = false;
      let callbackError;
      function writeSnapshot() {
        if (!keysReady || !latestReady) return;
        try {
          const previousIds = new Set(keysRequest.result);
          const previousRevision = latestRequest.result && latestRequest.result.revision;
          const cacheMatches = (previousRevision || null) === storedRevision;
          for (const id of previousIds) if (!state.buffers.has(id)) sourceStore.delete(id);
          for (const source of state.descriptors) {
            if (changed.has(source.id)) sourceStore.put(changed.get(source.id));
            else if (!cacheMatches || !previousIds.has(source.id)) {
              // Another tab may have imported different audio with the same IDs.
              const buffer = state.buffers.get(source.id);
              const channels = [];
              for (let c = 0; c < source.numberOfChannels; c++) channels.push(new Float32Array(channel(buffer, c, source.length)).buffer);
              sourceStore.put({ ...source, channels });
            }
          }
          tx.objectStore('projects').put({ project: state.project, sources: state.descriptors, audioBytes: state.audioBytes, savedAt, revision }, 'latest');
        } catch (error) {
          callbackError = error;
          tx.abort();
        }
      }
      keysRequest.onsuccess = () => { keysReady = true; writeSnapshot(); };
      latestRequest.onsuccess = () => { latestReady = true; writeSnapshot(); };
      await done.catch(error => { throw callbackError || error; });
      storedBuffers = new Map(state.buffers);
      storedRevision = revision;
      return { savedAt, sourceCount: state.descriptors.length };
    });
    saveQueue = task.catch(() => {});
    return task;
  }
  async function loadLatest(createBufferFn) {
    await saveQueue;
    const db = await database();
    const tx = db.transaction(['projects', 'sources'], 'readonly');
    const done = transactionDone(tx);
    const requests = Promise.all([requestResult(tx.objectStore('projects').get('latest')), requestResult(tx.objectStore('sources').getAll())]);
    const [[record, rows]] = await Promise.all([requests, done]);
    if (!record) return null;
    const header = jsonCopy({ format: 'appnest-project', version: 1, project: record.project, sources: record.sources });
    integer(record.audioBytes, 'stored audio size', 0, MAX_BYTES);
    validateHeader(header, record.audioBytes);
    const byId = new Map();
    for (const row of rows) {
      if (byId.has(row.id)) fail('duplicate stored source.');
      byId.set(row.id, row);
    }
    const channels = new Map();
    for (const source of header.sources) {
      const row = byId.get(source.id);
      if (!row || row.sampleRate !== source.sampleRate || row.length !== source.length || row.numberOfChannels !== source.numberOfChannels ||
        !Array.isArray(row.channels) || row.channels.length !== source.numberOfChannels) fail('stored source is missing or invalid.');
      const data = row.channels.map(bytes => {
        if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || bytes.byteLength !== source.length * 4) fail('invalid stored audio size.');
        const samples = new Float32Array(bytes);
        for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) fail('stored audio contains non-finite samples.');
        return samples;
      });
      channels.set(source.id, data);
    }
    const result = allocateSources(header.project, header.sources, (source, c) => channels.get(source.id)[c], createBufferFn);
    storedBuffers = new Map(Array.from(result.sources, ([id, source]) => [id, source.buffer]));
    storedRevision = typeof record.revision === 'string' ? record.revision : null;
    return result;
  }

  return Object.freeze({ exportProject, importProject, save, loadLatest,
    limits: Object.freeze({ maxBytes: MAX_BYTES, maxHeaderBytes: MAX_HEADER_BYTES, maxSources: MAX_SOURCES,
      maxClips: MAX_CLIPS, sampleRate: SAMPLE_RATE, maxChannels: 32 }) });
});

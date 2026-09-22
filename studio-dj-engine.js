/* AppNest Studio DJ engine — native Web Audio, no network dependencies.
 * Playback rate changes tempo AND pitch. This engine does not time-stretch.
 * Deck meters are after EQ/gain and before the crossfader; master is post-fader.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudioDJEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var IDS = ['A', 'B'];
  var EPSILON = 0.000001;
  function fail(code, message, details) {
    var error = new Error(message);
    error.name = 'StudioDJError'; error.code = code;
    if (details) error.details = details;
    throw error;
  }
  function number(value, name, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      fail('invalid-' + name, name + ' must be a finite number between ' + min + ' and ' + max + '.');
    }
    return value;
  }
  function optional(value, fallback) { return value === undefined ? fallback : value; }
  function dbGain(db) { return Math.pow(10, db / 20); }
  function faderValues(value) {
    var angle = (value + 1) * Math.PI / 4;
    return { A: value === 1 ? 0 : Math.cos(angle), B: value === -1 ? 0 : Math.sin(angle) };
  }
  function setNow(param, value, time) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, time);
  }
  function smoothNow(param, value, time) {
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
    else param.cancelScheduledValues(0);
    if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, time, 0.008);
    else param.setValueAtTime(value, time);
  }
  function disconnect(node) { if (node) { try { node.disconnect(); } catch (_) {} } }
  function graph(context, output, settings) {
    var low = context.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 200;
    var mid = context.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8;
    var high = context.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 5000;
    low.gain.value = settings.eq.low; mid.gain.value = settings.eq.mid; high.gain.value = settings.eq.high;
    var gain = context.createGain(); gain.gain.value = dbGain(settings.gainDb);
    var analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.75;
    var crossGain = context.createGain(); crossGain.gain.value = 0;
    low.connect(mid); mid.connect(high); high.connect(gain); gain.connect(analyser); analyser.connect(crossGain); crossGain.connect(output);
    return { filters: { low: low, mid: mid, high: high }, gain: gain, analyser: analyser, crossGain: crossGain };
  }
  function disconnectGraph(g) {
    Object.keys(g.filters).forEach(function (key) { disconnect(g.filters[key]); });
    disconnect(g.gain); disconnect(g.analyser); disconnect(g.crossGain);
  }
  function envelope(param, deckId, startTime, transitionTime, duration, curve) {
    var before = deckId === 'A' ? 1 : 0;
    param.cancelScheduledValues(0);
    if (transitionTime > startTime) param.setValueAtTime(before, startTime);
    if (curve === 'linear') {
      param.setValueAtTime(before, transitionTime);
      param.linearRampToValueAtTime(1 - before, transitionTime + duration);
    } else {
      var values = new Float32Array(1025);
      for (var i = 0; i < values.length; i++) {
        var phase = i / (values.length - 1);
        values[i] = deckId === 'A' ? Math.cos(phase * Math.PI / 2) : Math.sin(phase * Math.PI / 2);
      }
      values[0] = before; values[values.length - 1] = 1 - before;
      param.setValueCurveAtTime(values, transitionTime, duration);
    }
  }
  function Engine(context, options) {
    if (!context || typeof context.createGain !== 'function' || typeof context.createBufferSource !== 'function') {
      fail('invalid-context', 'A native AudioContext is required.');
    }
    if (context.state === 'closed') fail('context-closed', 'The audio context has closed. Create a new audio engine.');
    this.context = this.ctx = context;
    this.options = options || {};
    this.masterDb = -6; this.crossfader = 0;
    this._disposed = false; this._transportToken = 0; this._preview = null; this._pendingTransition = null; this._rendering = false;
    this.masterGain = context.createGain(); this.masterGain.gain.value = dbGain(this.masterDb);
    this.masterAnalyser = context.createAnalyser(); this.masterAnalyser.fftSize = 2048; this.masterAnalyser.smoothingTimeConstant = 0.75;
    this.masterGain.connect(this.masterAnalyser); this.masterAnalyser.connect(context.destination);
    this.decks = {};
    var self = this;
    IDS.forEach(function (id) {
      var settings = { gainDb: 0, eq: { low: 0, mid: 0, high: 0 } };
      self.decks[id] = Object.assign(graph(context, self.masterGain, settings), settings, {
        id: id, buffer: null, rate: 1, source: null, playing: false, offset: 0, startedAt: 0, stopAt: null, generation: 0
      });
    });
    this._restoreFader(false);
  }
  Engine.prototype._assert = function () {
    if (this._disposed) fail('disposed', 'This audio engine has been disposed.');
    if (this.context.state === 'closed') fail('context-closed', 'The audio context has closed. Create a new audio engine.');
  };
  Engine.prototype._deck = function (id, requireBuffer) {
    this._assert();
    if (IDS.indexOf(id) === -1) fail('invalid-deck', 'Deck must be A or B.');
    var deck = this.decks[id];
    if (requireBuffer && !deck.buffer) fail('missing-audio', 'Load an audio file into deck ' + id + ' first.', { deck: id });
    return deck;
  };
  Engine.prototype.unlock = function () {
    this._assert();
    // resume() happens before returning a Promise, while the click gesture is live.
    var result;
    try { result = this.context.state === 'running' ? undefined : this.context.resume(); }
    catch (error) { return Promise.reject(error); }
    var self = this;
    return Promise.resolve(result).then(function () {
      self._assert();
      if (self.context.state !== 'running') fail('audio-blocked', 'Audio is still suspended. Press Play again and allow audio in your browser.');
      return true;
    });
  };
  Engine.prototype.load = function (id, buffer) {
    var deck = this._deck(id, false);
    if (!buffer || typeof buffer.getChannelData !== 'function' || !Number.isFinite(buffer.duration) || buffer.duration <= 0 ||
        !Number.isInteger(buffer.length) || buffer.length < 1 || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 ||
        !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0) fail('invalid-buffer', 'Load a decoded AudioBuffer with playable audio.');
    this._manualAction(); this._stopDeck(deck, 0);
    deck.buffer = buffer;
    return this.getState(id);
  };
  Engine.prototype._position = function (deck) {
    if (!deck.buffer) return 0;
    var time = this.context.currentTime;
    if (deck.stopAt !== null) time = Math.min(time, deck.stopAt);
    var position = deck.offset + (deck.playing ? Math.max(0, time - deck.startedAt) * deck.rate : 0);
    return Math.max(0, Math.min(deck.buffer.duration, position));
  };
  Engine.prototype.position = function (id) { return this._position(this._deck(id, false)); };
  Engine.prototype.getState = function (id) {
    var d = this._deck(id, false);
    return { loaded: !!d.buffer, playing: d.playing, position: this._position(d), duration: d.buffer ? d.buffer.duration : 0,
      rate: d.rate, gainDb: d.gainDb, eq: Object.assign({}, d.eq), scheduled: d.playing && this.context.currentTime < d.startedAt };
  };
  Engine.prototype._stopDeck = function (deck, offset) {
    var position = offset === undefined ? this._position(deck) : offset;
    var source = deck.source;
    deck.generation++; deck.source = null; deck.playing = false; deck.startedAt = 0; deck.stopAt = null;
    deck.offset = deck.buffer ? Math.min(deck.buffer.duration, Math.max(0, position)) : 0;
    if (source) { source.onended = null; try { source.stop(); } catch (_) {} disconnect(source); }
  };
  Engine.prototype._startDeck = function (deck, offset, when, stopAt) {
    if (offset >= deck.buffer.duration) { deck.offset = deck.buffer.duration; return; }
    var source = this.context.createBufferSource();
    source.buffer = deck.buffer; source.playbackRate.setValueAtTime(deck.rate, this.context.currentTime);
    source.connect(deck.filters.low);
    deck.source = source; deck.offset = offset; deck.startedAt = when; deck.playing = true; deck.stopAt = stopAt === undefined ? null : stopAt;
    var generation = deck.generation;
    var self = this;
    source.onended = function () {
      if (deck.source !== source || deck.generation !== generation || self._disposed) return;
      var endPosition = deck.stopAt === null ? deck.buffer.duration : offset + Math.max(0, deck.stopAt - when) * deck.rate;
      deck.offset = Math.min(deck.buffer.duration, endPosition); deck.source = null; deck.playing = false; deck.startedAt = 0; deck.stopAt = null;
      disconnect(source);
      if (self._preview && deck.id === 'B' && self._preview.sourceB === source) {
        self._preview = null;
        self._stopDeck(self.decks.A);
        self._restoreFader(false);
      }
    };
    try { source.start(when, offset); if (stopAt !== undefined) source.stop(stopAt); }
    catch (error) { this._stopDeck(deck, offset); throw error; }
  };
  Engine.prototype._restoreFader = function (smooth) {
    var values = faderValues(this.crossfader); var now = this.context.currentTime;
    IDS.forEach(function (id) {
      (smooth ? smoothNow : setNow)(this.decks[id].crossGain.gain, values[id], now);
    }, this);
  };
  Engine.prototype._manualAction = function () {
    this._transportToken++; this._pendingTransition = null;
    if (this._preview) {
      this._preview = null;
      this._stopDeck(this.decks.A); this._stopDeck(this.decks.B);
      this._restoreFader(false);
    }
  };
  Engine.prototype.play = async function (id, offset) {
    var deck = this._deck(id, true);
    if (offset !== undefined) number(offset, 'offset', 0, deck.buffer.duration);
    this._manualAction();
    var position = offset === undefined ? this._position(deck) : offset;
    if (position >= deck.buffer.duration) position = 0;
    this._stopDeck(deck, position);
    var generation = deck.generation;
    var resume = this.unlock();
    await resume;
    if (deck.generation !== generation || this._disposed) return this._disposed ? null : this.getState(id);
    this._startDeck(deck, position, this.context.currentTime + 0.005);
    return this.getState(id);
  };
  Engine.prototype.pause = function (id) {
    var deck = this._deck(id, false);
    this._manualAction(); this._stopDeck(deck);
    return this.getState(id);
  };
  Engine.prototype.seek = function (id, seconds) {
    var deck = this._deck(id, true); number(seconds, 'seek', 0, deck.buffer.duration);
    var wasPlaying = deck.playing && !this._preview;
    this._manualAction(); this._stopDeck(deck, seconds);
    if (wasPlaying && seconds < deck.buffer.duration) this._startDeck(deck, seconds, this.context.currentTime);
    return this.getState(id);
  };
  Engine.prototype.setRate = function (id, rate) {
    var deck = this._deck(id, false); number(rate, 'rate', 0.5, 2);
    var wasPlaying = deck.playing && !this._preview;
    this._manualAction();
    var position = this._position(deck);
    this._stopDeck(deck, position); deck.rate = rate;
    if (wasPlaying && deck.buffer && position < deck.buffer.duration) this._startDeck(deck, position, this.context.currentTime);
    return this.getState(id);
  };
  Engine.prototype.setGain = function (id, db) {
    var deck = this._deck(id, false); number(db, 'gain', -60, 12);
    deck.gainDb = db; smoothNow(deck.gain.gain, dbGain(db), this.context.currentTime);
    return db;
  };
  Engine.prototype.setEQ = function (id, values) {
    var deck = this._deck(id, false);
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail('invalid-eq', 'EQ values must be an object.');
    var keys = Object.keys(values);
    keys.forEach(function (key) {
      if (['low', 'mid', 'high'].indexOf(key) === -1) fail('invalid-eq', 'EQ supports low, mid and high only.');
      number(values[key], 'eq-' + key, -24, 12);
    });
    keys.forEach(function (key) {
      deck.eq[key] = values[key]; smoothNow(deck.filters[key].gain, values[key], this.context.currentTime);
    }, this);
    return Object.assign({}, deck.eq);
  };
  Engine.prototype.setCrossfader = function (value) {
    this._assert(); number(value, 'crossfader', -1, 1);
    this._manualAction(); this.crossfader = value; this._restoreFader(true);
    return value;
  };
  Engine.prototype.setMaster = function (db) {
    this._assert(); number(db, 'master', -60, 0);
    this.masterDb = db; smoothNow(this.masterGain.gain, dbGain(db), this.context.currentTime);
    return db;
  };
  Engine.prototype.cancelTransition = function () {
    this._assert(); this._manualAction(); return true;
  };
  Object.defineProperty(Engine.prototype, 'isTransitionPlaying', { get: function () { return !!this._preview; } });
  Engine.prototype.stopAll = function () {
    this._assert(); this._manualAction();
    this._stopDeck(this.decks.A); this._stopDeck(this.decks.B); this._restoreFader(false);
  };
  Engine.prototype.computePlan = function (config) {
    var a = this._deck('A', true); var b = this._deck('B', true);
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid-plan', 'Transition settings are required.');
    var aCue = number(config.aCue, 'a-cue', 0, a.buffer.duration);
    var bCue = number(config.bCue, 'b-cue', 0, b.buffer.duration);
    var bpmA = number(config.bpmA, 'bpm-a', 30, 300);
    var bpmB = number(config.bpmB, 'bpm-b', 30, 300);
    var targetBpm = number(config.targetBpm, 'target-bpm', 30, 300);
    var bars = number(config.bars, 'bars', 1, 64);
    if (!Number.isInteger(bars)) fail('invalid-bars', 'Transition length must be a whole number of 4-beat bars.');
    var preRoll = number(optional(config.preRoll, 4), 'pre-roll', 0, 120);
    var postRoll = number(optional(config.postRoll, 4), 'post-roll', 0, 120);
    var curve = optional(config.curve, 'equalPower');
    if (curve !== 'equalPower' && curve !== 'linear') fail('invalid-curve', 'Transition curve must be equalPower or linear.');
    var rateA = targetBpm / bpmA; var rateB = targetBpm / bpmB;
    if (rateA < 0.5 || rateA > 2 || rateB < 0.5 || rateB > 2) fail('tempo-range', 'Tempo matching would exceed the supported 0.5×–2× playback range.');
    var duration = bars * 4 * 60 / targetBpm;
    var startA = aCue - preRoll * rateA;
    if (startA < -EPSILON) fail('insufficient-a-preroll', 'Deck A does not have enough audio before its cue. Move cue A later or reduce pre-roll.', { available: aCue / rateA, required: preRoll });
    if (aCue + duration * rateA > a.buffer.duration + EPSILON) fail('insufficient-a-overlap', 'Deck A ends before the transition finishes. Move cue A earlier or choose fewer bars.', { available: (a.buffer.duration - aCue) / rateA, required: duration });
    if (bCue + duration * rateB > b.buffer.duration + EPSILON) fail('insufficient-b-overlap', 'Deck B ends before the transition finishes. Move cue B earlier or choose fewer bars.', { available: (b.buffer.duration - bCue) / rateB, required: duration });
    if (bCue + (duration + postRoll) * rateB > b.buffer.duration + EPSILON) fail('insufficient-b-postroll', 'Deck B does not have enough audio after the transition. Reduce post-roll or move cue B earlier.', { available: (b.buffer.duration - bCue) / rateB - duration, required: postRoll });
    var previewDuration = preRoll + duration + postRoll;
    var fullTransitionAt = aCue / rateA;
    var fullDuration = fullTransitionAt + (b.buffer.duration - bCue) / rateB;
    return { rateA: rateA, rateB: rateB, aCue: aCue, bCue: bCue, bpmA: bpmA, bpmB: bpmB, targetBpm: targetBpm, bars: bars,
      curve: curve, preRoll: preRoll, postRoll: postRoll, transitionDuration: duration, startA: Math.max(0, startA), startB: bCue,
      transitionAt: preRoll, previewDuration: previewDuration, fullTransitionAt: fullTransitionAt, fullDuration: fullDuration,
      segments: { A: { sourceStart: Math.max(0, startA), timelineStart: 0, timelineEnd: preRoll + duration },
        B: { sourceStart: bCue, timelineStart: preRoll, timelineEnd: previewDuration } } };
  };
  Engine.prototype.previewTransition = async function (config) {
    var plan = this.computePlan(config);
    this.stopAll();
    var request = ++this._transportToken; this._pendingTransition = request;
    var resume = this.unlock();
    await resume;
    if (this._disposed || request !== this._transportToken || this._pendingTransition !== request) return Object.assign({}, plan, { cancelled: true });
    this._pendingTransition = null;
    var now = this.context.currentTime; var start = now + 0.025;
    var transitionAt = start + plan.preRoll; var end = start + plan.previewDuration;
    this.decks.A.rate = plan.rateA; this.decks.B.rate = plan.rateB;
    plan.startedAt = start;
    try {
      envelope(this.decks.A.crossGain.gain, 'A', now, transitionAt, plan.transitionDuration, plan.curve);
      envelope(this.decks.B.crossGain.gain, 'B', now, transitionAt, plan.transitionDuration, plan.curve);
      this._startDeck(this.decks.A, plan.startA, start, transitionAt + plan.transitionDuration);
      this._startDeck(this.decks.B, plan.startB, transitionAt, end);
      this._preview = { plan: plan, sourceB: this.decks.B.source, endTime: end };
    } catch (error) { this.stopAll(); throw error; }
    return plan;
  };
  Engine.prototype.renderTransition = async function (config, options) {
    this._assert();
    var plan = this.computePlan(config); options = options || {};
    if (options.full !== undefined && typeof options.full !== 'boolean') fail('invalid-export', 'full must be true or false.');
    if (this._rendering) fail('render-in-progress', 'Wait for the current audio export to finish.');
    var full = options.full !== false;
    var duration = full ? plan.fullDuration : plan.previewDuration;
    var sampleRate = number(optional(options.sampleRate, 48000), 'sample-rate', 8000, 96000);
    if (!Number.isInteger(sampleRate)) fail('invalid-sample-rate', 'Sample rate must be an integer.');
    var frames = Math.ceil(duration * sampleRate);
    var maxBytes = optional(this.options.maxRenderBytes, 512 * 1024 * 1024);
    number(maxBytes, 'memory-limit', 1024, Number.MAX_SAFE_INTEGER);
    // Reserve room for the stereo render and a second output/encoding buffer.
    var estimatedBytes = frames * 2 * 4 * 2;
    if (!Number.isSafeInteger(frames) || frames < 1 || estimatedBytes > maxBytes) {
      fail('render-too-large', 'This export is too long for the browser memory limit. Export the transition preview or shorten the audio.', { estimatedBytes: estimatedBytes, maxBytes: maxBytes });
    }
    var Offline = this.options.OfflineAudioContext || root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (typeof Offline !== 'function') fail('offline-unsupported', 'This browser does not support offline audio export.');
    var offline = new Offline(2, frames, sampleRate);
    var master = offline.createGain(); master.gain.value = dbGain(this.masterDb); master.connect(offline.destination);
    var graphs = {}; var sources = [];
    var transitionAt = full ? plan.fullTransitionAt : plan.preRoll;
    var self = this;
    this._rendering = true;
    try {
      IDS.forEach(function (id) {
        var deck = self.decks[id]; var rate = id === 'A' ? plan.rateA : plan.rateB;
        var start = id === 'A' ? 0 : transitionAt;
        var sourceOffset = id === 'A' ? (full ? 0 : plan.startA) : plan.bCue;
        var stop = id === 'A' ? transitionAt + plan.transitionDuration : duration;
        var g = graphs[id] = graph(offline, master, { gainDb: deck.gainDb, eq: Object.assign({}, deck.eq) });
        envelope(g.crossGain.gain, id, 0, transitionAt, plan.transitionDuration, plan.curve);
        var source = offline.createBufferSource(); source.buffer = deck.buffer; source.playbackRate.value = rate;
        source.connect(g.filters.low); source.start(start, sourceOffset); source.stop(stop); sources.push(source);
      });
      return await offline.startRendering();
    } finally {
      this._rendering = false;
      sources.forEach(disconnect); Object.keys(graphs).forEach(function (id) { disconnectGraph(graphs[id]); }); disconnect(master);
    }
  };
  Engine.prototype.dispose = function () {
    if (this._disposed) return;
    this._transportToken++; this._pendingTransition = null; this._preview = null;
    this._stopDeck(this.decks.A); this._stopDeck(this.decks.B);
    IDS.forEach(function (id) { disconnectGraph(this.decks[id]); this.decks[id].buffer = null; }, this);
    disconnect(this.masterGain); disconnect(this.masterAnalyser);
    this._disposed = true;
    // The injected context belongs to the caller; do not close a shared context.
  };
  return { Engine: Engine };
});

'use strict';
importScripts('./studio-dj-analysis.js');
self.onmessage = function (event) {
  const message = event.data || {};
  try {
    const analysis = self.StudioDJAnalysis.analyze(message.channels, message.sampleRate);
    self.postMessage({ id: message.id, analysis }, [analysis.peaks.buffer]);
  } catch (error) {
    self.postMessage({ id: message.id, error: error && error.message ? error.message : 'Audio analysis failed.' });
  }
};

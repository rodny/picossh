// Worker for the large-file search in sftp.js: decodes blocks of the file and
// runs the query on them, off the main thread, so a slow regular expression
// cannot stall the terminals and can be stopped by terminating the worker.
const { parentPort, workerData } = require('worker_threads');
const TextSearch = require('../public/text-search');

const { re } = TextSearch.compile(workerData);
const decoder = new TextDecoder('utf-8');

parentPort.on('message', ({ bytes, base, limit }) => {
  const text = decoder.decode(bytes);
  const found = TextSearch.findAll(text, re, { limit });
  let matches;
  if (text.length === bytes.length) {
    matches = found.map(([s, e]) => [base + s, base + e]); // ASCII: indices are bytes
  } else {
    const offsets = TextSearch.byteOffsets(bytes, found.flat());
    matches = found.map((_, i) => [base + offsets[2 * i], base + offsets[2 * i + 1]]);
  }
  parentPort.postMessage(matches);
});

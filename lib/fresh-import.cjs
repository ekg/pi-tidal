// Load this bootstrap with Node's createRequire, NOT the TS loader. Jiti strips
// query strings from import() and can reuse stale native ESM exports on reload.
// A real Node module supplies the native dynamic-import callback absent in its VM.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

exports.importFreshModule = function (filename) {
  const digest = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  return import(`${pathToFileURL(filename).href}?sha256=${digest}`);
};

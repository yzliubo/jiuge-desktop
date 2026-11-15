'use strict';
const fs = require('fs');
window.readPdf = async function () {
  const buf = fs.readFileSync(process.env.PROBE_PDF);
  return Array.from(buf);
};

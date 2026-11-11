'use strict';
// 诊断：数清 .cell 到底渲染了几处、分别在哪
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const userData = 'G:/workbuddy/tmp-build/diag-cell-userdata';
delete process.env.ELECTRON_RUN_AS_NODE;

(async function () {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(root, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: userData, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(900);
  const info = await page.evaluate(function () {
    const all = Array.from(document.querySelectorAll('.cell'));
    return all.map(function (el) {
      const p = [];
      let n = el.parentElement;
      for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
        p.push(n.className ? String(n.className).split(' ')[0] : n.tagName.toLowerCase());
      }
      return { cell: el.getAttribute('data-cell') || '(none)', label: (el.textContent || '').trim().slice(0, 10), path: p.join('<') };
    });
  });
  console.log(JSON.stringify(info, null, 1));
  console.log('grid rows:', await page.evaluate(function () {
    return getComputedStyle(document.querySelector('.workbench')).gridTemplateRows;
  }));
  await app.close();
})().catch(function (e) { console.error('failed', e && e.message); process.exitCode = 1; });

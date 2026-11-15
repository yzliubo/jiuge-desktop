// 成果截图：图书馆「书架整理」与阅读窗「本机字体」。一次性脚本，跑完可删。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const OUT = 'G:/workbuddy/2026-11-08-09-57-53/jiuge-redesign/评估-20261114/shots-library';
const EPUB = 'C:/Users/yzliu/Downloads/小强升职记.epub';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-shot-'));
  const app = await electron.launch({
    executablePath: path.join(P, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(P, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(700);
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await page.evaluate(() => { try { window.resizeTo(1440, 900); } catch (e) {} });
  await page.waitForTimeout(400);

  // 一本真书（带封面）+ 两本手登记，让书架有层次
  await page.evaluate(async (p) => {
    await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.addFiles', args: [[p], ''] });
    const add = window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.addBook', args: [{ title: '污水处理厂运行管理', author: '老刘', total: 320 }] });
    await add;
    await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.addBook', args: [{ title: '给水排水设计手册', author: '', total: 680 }] });
  }, EPUB);

  await page.locator('.reading-btn').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '01-书架-搜索与排序.png') });

  // 编辑弹窗
  await page.locator('.rd-shelf .rd-book').filter({ hasText: '污水处理厂运行管理' }).first()
    .locator('.rd-mini', { hasText: '编辑' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '02-编辑书籍信息.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 阅读窗：本机字体
  const id = await page.evaluate(async () => {
    const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
    const b = (r.data.books || []).find((x) => x.filePath) || {};
    return b.id;
  });
  await page.evaluate(async (bid) => {
    await window.jiugeBridge.invoke('v1/reader:open', { bookId: bid, mode: 'leisure' });
  }, id);
  await new Promise((r) => setTimeout(r, 2600));
  const rw = app.windows().find((w) => w.url().indexOf('reader') >= 0);
  await rw.waitForSelector('#rrPage', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2400));
  // 打开字体下拉的清单（懒加载）并选「仿宋」
  await rw.evaluate(() => { document.getElementById('rrTypeface').dispatchEvent(new Event('focus')); });
  await new Promise((r) => setTimeout(r, 3200));
  await rw.evaluate(() => {
    const grp = document.getElementById('rrSystemFonts');
    const want = Array.from(grp.children).map((o) => o.value).find((v) => v.indexOf('仿宋') >= 0) || grp.children[0].value;
    const sel = document.getElementById('rrTypeface');
    sel.value = want;
    sel.dispatchEvent(new Event('change'));
  });
  await new Promise((r) => setTimeout(r, 900));
  // 翻到正文一章（封面页看不出字形）
  await rw.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#rrTocList li, .rr-toc-item, #rrTocBody a'));
    const t = items.find((n) => (n.textContent || '').indexOf('第一章') >= 0) || items[3];
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 1800));
  await rw.screenshot({ path: path.join(OUT, '03-阅读窗-本机字体.png') });
  console.log('OK');
  await app.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });

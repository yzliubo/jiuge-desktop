// 临时真窗口探针：阅读窗「本机字体」这一档是否真的换掉了正文字形。
// 用磁盘上现成的 epub 建一本真书，开独立阅读窗，在「字体」下拉里选一个本机族名，
// 最后读 iframe 里 body 的 computedStyle.fontFamily 核对。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const EPUB = 'C:/Users/yzliu/Downloads/小强升职记.epub';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  if (!fs.existsSync(EPUB)) throw new Error('样本 epub 不在：' + EPUB);
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-font-'));
  const app = await electron.launch({
    executablePath: path.join(P, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(P, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(600);

  // 1) 登记真书
  const info = await page.evaluate(async (p) => {
    const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.addFiles', args: [[p], ''] });
    const b = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
    const bk = (b.data.books || [])[0] || null;
    return { code: r.code, added: r.data && r.data.added, id: bk && bk.id, title: bk && bk.title };
  }, EPUB);
  console.log('[1] 登记 ok =', info.code, '| added =', info.added, '| 书 =', info.title);

  // 2) 开独立阅读窗
  const opened = await page.evaluate(async (id) => {
    const r = await window.jiugeBridge.invoke('v1/reader:open', { bookId: id, mode: 'leisure' });
    return r.data || { ok: false };
  }, info.id);
  console.log('[2] 开窗 =', JSON.stringify(opened));
  await new Promise((r) => setTimeout(r, 1800));

  // 2b) 开窗应打上「最近在读」
  const touched = await page.evaluate(async (id) => {
    const b = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
    const hit = (b.data.books || []).find((x) => x.id === id) || {};
    return { lastReadAt: hit.lastReadAt || 0, now: Date.now() };
  }, info.id);
  console.log('[2b] lastReadAt 距今 =', touched.now - touched.lastReadAt, 'ms（应为正且很小）');

  const wins = app.windows();
  const rw = wins.find((w) => w.url().indexOf('reader') >= 0) || wins[wins.length - 1];
  await rw.waitForSelector('#rrPage', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2500));

  const before = await rw.evaluate(() => {
    const sel = document.getElementById('rrTypeface');
    const d = document.getElementById('rrPage').contentDocument;
    return {
      n: sel.options.length,
      groups: Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label),
      sysCount: document.getElementById('rrSystemFonts').children.length,
      bodyFamily: d && d.body ? getComputedStyle(d.body).fontFamily : '(no body)'
    };
  });
  console.log('[3] 未展开时选项 =', before.n, '| 分组 =', JSON.stringify(before.groups), '| 本机组 =', before.sysCount);
  console.log('[3b] 默认正文族 =', before.bodyFamily);

  // 3) 触发懒加载（展开下拉时才读清单）
  await rw.evaluate(() => { document.getElementById('rrTypeface').dispatchEvent(new Event('focus')); });
  await new Promise((r) => setTimeout(r, 3500));
  const loaded = await rw.evaluate(() => ({
    n: document.getElementById('rrSystemFonts').children.length,
    sample: Array.from(document.getElementById('rrSystemFonts').children).slice(0, 4).map((o) => o.value)
  }));
  console.log('[4] 懒加载后本机组 =', loaded.n, '| 样例 =', JSON.stringify(loaded.sample));

  // 4) 挑一个明确不同的族，核对正文真的换了
  const pick = await rw.evaluate(() => {
    const grp = document.getElementById('rrSystemFonts');
    const want = Array.from(grp.children).map((o) => o.value).find((v) => /楷|隶|仿宋/.test(v)) || grp.children[0].value;
    const sel = document.getElementById('rrTypeface');
    sel.value = want;
    sel.dispatchEvent(new Event('change'));
    return want;
  });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await rw.evaluate(() => {
    const d = document.getElementById('rrPage').contentDocument;
    const h = d.querySelector('h1,h2,h3');
    return {
      typeface: d.body.getAttribute('data-typeface'),
      bodyFamily: getComputedStyle(d.body).fontFamily,
      headFamily: h ? getComputedStyle(h).fontFamily : '(本章无标题)',
      rule: (d.getElementById('rr-device-font') || {}).textContent || '(无规则)',
      pref: JSON.parse(localStorage.getItem('jiuge-reader-pref') || '{}')
    };
  });
  console.log('[5] 选中 =', pick);
  console.log('[5b] data-typeface =', after.typeface, '| 正文族 =', after.bodyFamily);
  console.log('[5c] 标题族 =', after.headFamily);
  console.log('[5d] 注入规则 =', after.rule.slice(0, 70));
  console.log('[5e] 已存偏好 =', JSON.stringify({ typeface: after.pref.typeface, family: after.pref.family }));

  await rw.screenshot({ path: path.join(P, 'tests/e2e/.reader-font-device.png') });

  // 5) 关掉阅读窗再开一次：偏好是否恢复（重开走的是 loadPrefs）
  await rw.close();
  await new Promise((r) => setTimeout(r, 800));
  const reopened = await page.evaluate(async (id) => {
    const r = await window.jiugeBridge.invoke('v1/reader:open', { bookId: id, mode: 'leisure' });
    return r.data || { ok: false };
  }, info.id);
  await new Promise((r) => setTimeout(r, 2600));
  const rw2 = app.windows().find((w) => w.url().indexOf('reader') >= 0);
  const restored = await rw2.evaluate(() => {
    const d = document.getElementById('rrPage').contentDocument;
    return {
      value: document.getElementById('rrTypeface').value,
      typeface: d.body.getAttribute('data-typeface'),
      bodyFamily: getComputedStyle(d.body).fontFamily
    };
  });
  console.log('[6] 重开 =', JSON.stringify(reopened), '| 恢复值 =', restored.value,
    '| typeface =', restored.typeface, '| 正文族 =', restored.bodyFamily);

  await app.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });

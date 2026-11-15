// 临时真窗口探针：验证「书架整理」与「本机字体」两条新链路真的通。
// 只做一次性核对，不进任何门禁；跑完即可删。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

function log() {
  console.log.apply(console, Array.prototype.slice.call(arguments));
}

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-lib-'));
  const app = await electron.launch({
    executablePath: path.join(P, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(P, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(800);

  // [1] 进图书馆
  await page.locator('.reading-btn').click();
  await page.waitForTimeout(600);
  log('[1] 图书馆在场 =', await page.locator('.rd-view').count());

  // [2] 手工建三本书（不依赖本机电子书）
  const names = ['探针甲', '探针乙', '探针丙'];
  for (let i = 0; i < names.length; i += 1) {
    await page.locator('.rd-add .rd-name').fill(names[i]);
    await page.locator('.rd-add .rd-primary').click();
    await page.waitForTimeout(320);
  }
  log('[2] 书架行数 =', await page.locator('.rd-shelf .rd-book').count(),
    '| 工具栏在 =', await page.locator('.rd-tools').count(),
    '| 拖动手柄数 =', await page.locator('.rd-grip').count());

  // [3] 搜索：只在渲染层过滤，不动库
  await page.locator('.rd-search').fill('乙');
  await page.waitForTimeout(250);
  log('[3] 搜「乙」可见 =', await page.locator('.rd-shelf .rd-book').count(),
    '| 计数文案 =', (await page.locator('.rd-tools .rd-hint').innerText()).replace(/\s+/g, ''),
    '| 搜索态可拖 =', await page.locator('.rd-shelf .rd-book').first().getAttribute('draggable'));
  await page.locator('.rd-search').fill('');
  await page.waitForTimeout(250);

  // [4] 排序切「最近在读」，刷新后是否记住
  await page.locator('.rd-sort .rd-mini').nth(1).click();
  await page.waitForTimeout(250);
  const remembered = await page.evaluate(() => localStorage.getItem('jiuge.reading.sortMode'));
  log('[4] 排序记忆 =', remembered, '| 最近在读态可拖 =',
    await page.locator('.rd-shelf .rd-book').first().getAttribute('draggable'));

  // [5] 领域层拖动排序：走真实 IPC，看顺序是否真落库
  const before = await page.evaluate(async () => {
    const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
    return r.data.books.map((b) => b.title).join(',');
  });
  const order = await page.evaluate(async () => {
    const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
    const ids = r.data.books.map((b) => b.id);
    ids.reverse();
    const w = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.reorder', args: [ids] });
    const r2 = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
    return { ok: w.code === 'OK', after: r2.data.books.map((b) => b.title).join(',') };
  });
  log('[5] 排序前 =', before, '| 倒序写入 ok =', order.ok, '| 排序后 =', order.after);

  // [6] 编辑弹窗：改书名 + 标记读完 + 再读一遍
  await page.locator('.rd-shelf .rd-book').first().locator('.rd-mini', { hasText: '编辑' }).click();
  await page.waitForTimeout(350);
  log('[6] 弹窗在 =', await page.locator('.rd-modal').count(),
    '| 模态 =', await page.locator('.rd-modal').getAttribute('aria-modal'));
  await page.locator('#rdEditTitle').fill('探针甲·改名');
  await page.locator('.rd-modal .rd-primary').click();
  await page.waitForTimeout(500);
  log('[6b] 改名后弹窗 =', await page.locator('.rd-modal').count(),
    '| 书架里有「探针甲·改名」=', await page.locator('.rd-shelf .rd-book', { hasText: '探针甲·改名' }).count());

  await page.locator('.rd-shelf .rd-book').first().locator('.rd-mini', { hasText: '编辑' }).click();
  await page.waitForTimeout(300);
  await page.locator('.rd-modal .rd-mini', { hasText: '标记读完' }).click();
  await page.waitForTimeout(500);
  log('[6c] 标记读完后有「已读完」=', await page.locator('.rd-shelf', { hasText: '读完' }).count() > 0,
    '| 弹窗已关 =', await page.locator('.rd-modal').count());

  // [7] 本机字体：走真实 IPC 白名单
  const fonts = await page.evaluate(async () => {
    const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.systemFonts', args: [] });
    const list = (r && r.data) || [];
    return { code: r && r.code, n: list.length, zh: list.filter((x) => /[\u4e00-\u9fa5]/.test(x)).slice(0, 4) };
  });
  log('[7] systemFonts code =', fonts.code, '| 数量 =', fonts.n, '| 中文族名 =', JSON.stringify(fonts.zh));

  // [8] 截图留档
  await page.locator('.rd-shelf .rd-book').first().locator('.rd-mini', { hasText: '编辑' }).click();
  await page.waitForTimeout(400);
  log('[7b] 弹窗打开后焦点 =', await page.evaluate(() => document.activeElement && document.activeElement.id));
  await page.screenshot({ path: path.join(P, 'tests/e2e/.lib-shelf-edit.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  log('[8] Esc 关闭弹窗后 =', await page.locator('.rd-modal').count());
  await page.screenshot({ path: path.join(P, 'tests/e2e/.lib-shelf.png') });
  log('[8b] 截图已落盘');

  await app.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });

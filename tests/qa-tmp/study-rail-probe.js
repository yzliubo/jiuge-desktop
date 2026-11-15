'use strict';
// V3.6 学习成长右栏「目前在读的图书 / 主题学习」真窗口探针
// 自带夹具：图书馆书架两本在读书 + 一本已读完（验过滤），主题书单两本在读书（验跨源合并），
// 两个主题（验多行状态）。跑完清理，不留数据。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const OUT = 'G:/workbuddy/2026-11-08-09-57-53/jiuge-redesign/评估-20261114/shots-library';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

function say(k, v) { console.log('[' + k + ']', JSON.stringify(v)); }

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-study-rail-'));
  const app = await electron.launch({
    executablePath: path.join(P, 'node_modules/electron/dist/electron.exe'),
    args: [path.join(P, 'src/main/main-v2.js')],
    env: Object.assign({}, process.env, { JIUGE_V2_USERDATA: ud, JIUGE_V2_PROBE: '1' }),
    timeout: 60000
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });
  await page.waitForSelector('.workbench', { timeout: 30000 });
  await page.waitForTimeout(700);

  const invoke = (name, args) => page.evaluate(
    (p) => window.jiugeBridge.invoke('v1/domain:call', { name: p.name, args: p.args }),
    { name, args }
  );
  const rawOf = async (name) => (await invoke(name, [])).data;
  const day = 24 * 60 * 60 * 1000;
  const themeIds = [];
  const shelfIds = [];

  // 图书馆书架：两本在读（带最近读过时间）+ 一本已读完（不该进「目前在读」）
  const shelf = [
    { title: '给水排水设计手册 · 第 3 册', author: '中国建筑工业出版社', total: 860, done: 312, status: 'reading', lastReadAt: Date.now() - day },
    { title: '污水处理厂工艺设计', author: '张自杰', total: 420, done: 95, status: 'reading', lastReadAt: Date.now() - 3 * day },
    { title: '活性污泥法简明教程', author: '顾夏声', total: 260, done: 260, status: 'done' }
  ];
  for (const b of shelf) {
    await invoke('reading.addBook', [b]);
    const s = await rawOf('reading.read');
    const hit = (s.books || []).find((x) => x.title === b.title);
    if (hit) shelfIds.push(hit.id);
  }

  // 主题书单：两个主题，各一本在读书
  const themes = [
    { title: 'MBBR 工艺专题', book: '移动床生物膜反应器', total: 240, delta: 60 },
    { title: '注册给排水备考', book: '专业考试规范汇编', total: 500, delta: 120 }
  ];
  for (const t of themes) {
    await invoke('growth.addTheme', [{ title: t.title, note: '真窗口探针夹具' }]);
    const s = await rawOf('growth.read');
    const th = (s.themes || []).find((x) => x.title === t.title);
    if (!th) continue;
    themeIds.push(th.id);
    await invoke('growth.addBook', [th.id, { title: t.book, total: t.total }]);
    const s2 = await rawOf('growth.read');
    const th2 = (s2.themes || []).find((x) => x.id === th.id);
    const bk = th2 && (th2.books || []).find((x) => x.title === t.book);
    if (bk) await invoke('growth.advanceBook', [th.id, bk.id, t.delta]);
  }

  // 重新 mount 右栏：回今天 → 双击学习成长格
  await page.locator('.nav-item').first().click();
  await page.waitForTimeout(300);
  await page.locator('.cell[data-cell="growth"] .cell-label').dblclick();
  await page.waitForTimeout(900);
  say('growthView', await page.locator('.growth-view').count());
  const nowCard = page.locator('.gc-now[aria-label="目前在读的图书"]');
  const topicCard = page.locator('.gc-topic[aria-label="主题学习状态"]');
  say('nowRows', await nowCard.locator('.gc-now-row').count());
  say('nowText', (await nowCard.innerText()).replace(/\n/g, ' | '));
  say('topicRows', await topicCard.locator('.gc-topic-row').count());
  say('topicText', (await topicCard.innerText()).replace(/\n/g, ' | '));
  say('bars', await page.locator('.gc-bar i').count());
  await page.screenshot({ path: path.join(OUT, '11-学习成长右栏-在读书与主题学习.png') });

  // 点主题行：中栏与右栏详情联动
  await topicCard.locator('.gc-topic-row', { hasText: 'MBBR 工艺专题' }).click();
  await page.waitForTimeout(500);
  say('topicOn', await topicCard.locator('.gc-topic-on').count());
  say('detailTag', await page.locator('.growth-ctx > section').first().locator('.ctx-tag').innerText());
  await page.screenshot({ path: path.join(OUT, '12-学习成长右栏-主题选中联动.png') });

  // 快捷访问：未关联文件的书 → 跳图书馆
  await nowCard.locator('.gc-now-row', { hasText: '给水排水设计手册' }).locator('.gc-now-go').click();
  await page.waitForTimeout(800);
  say('jumpToLibrary', await page.locator('.rd-view').count());
  say('pageErrors', errors.slice(0, 5));

  for (const id of themeIds) await invoke('growth.removeTheme', [id]);
  for (const id of shelfIds) await invoke('reading.removeBook', [id]);
  await app.close();
  console.log('PROBE_DONE');
})().catch(function (e) { console.error('PROBE_FAIL', e.stack || e.message); process.exit(1); });

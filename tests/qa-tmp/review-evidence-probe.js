'use strict';
// V3.7 复盘证据面板真窗口探针：Check 五格派生 / 上期一句回显 / Act 落成下一步
// 自带夹具，独立 userData，跑完清理，不留数据。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const OUT = 'G:/workbuddy/2026-11-08-09-57-53/jiuge-redesign/评估-20261114/shots-library';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

function say(k, v) { console.log('[' + k + ']', JSON.stringify(v)); }
function pad(n) { return String(n).padStart(2, '0'); }
function dayText(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-review-ev-'));
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
  const rawOf = async (name, args) => (await invoke(name, args || [])).data;

  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const thisKey = dayText(monday);
  const todayKey = dayText(now);
  const prev = new Date(monday);
  prev.setDate(prev.getDate() - 7);
  const prevKey = dayText(prev);

  const taskIds = [];
  const bookIds = [];
  const dreamIds = [];

  // GTD：三条任务，勾掉两条 → 本周完成有数
  const titles = ['复核 MBBR 池填料投加比', '整理注册给排水报名材料', '回看二沉池排泥记录'];
  for (const t of titles) {
    await invoke('gtd.add', [{ title: t, status: 'next', context: '@电脑' }]);
    const g = await rawOf('gtd.board', [todayKey]);
    const hit = (g.groups.next || []).find((x) => x.title === t);
    if (hit) taskIds.push(hit.id);
  }
  for (const id of taskIds.slice(0, 2)) await invoke('gtd.complete', [id]);

  // 图书馆：两本在读书 + 一本已读完
  const books = [
    { title: '给水排水设计手册 · 第 3 册', total: 860, done: 312, status: 'reading' },
    { title: '污水处理厂工艺设计', total: 420, done: 95, status: 'reading' },
    { title: '活性污泥法简明教程', total: 260, done: 260, status: 'done' }
  ];
  for (const b of books) {
    await invoke('reading.addBook', [b]);
    const s = await rawOf('reading.read');
    const hit = (s.books || []).find((x) => x.title === b.title);
    if (hit) bookIds.push(hit.id);
  }

  // 梦想：一条在推目标，关联上面那条未完成任务
  await invoke('dream.add', [{ title: '注册给排水工程师取证', status: 'doing', area: 'study' }]);
  const ds = await rawOf('dream.read');
  const dm = (ds.dreams || []).find((x) => x.title === '注册给排水工程师取证');
  if (dm) {
    dreamIds.push(dm.id);
    if (taskIds[2]) await invoke('dream.linkTask', [dm.id, taskIds[2]]);
  }

  // 上期留的一句 + 本期三问预填（只填 1、2 问，第 3 问留给 Act 截图）
  await invoke('saveReview', ['week', prevKey, [
    '', '', '下期只改一条：每天先清收件箱，再打开图纸'
  ]]);
  await invoke('saveReview', ['week', thisKey, [
    '六条挑得比上周准，两条图纸复核当天就收口了。',
    '把「能动手的下一步」先拆出来，六条才不虚胖；剩下一条挂在梦想上，一直没排进今天。',
    ''
  ]]);

  await page.locator('.nav-item').nth(2).click();
  await page.waitForTimeout(1000);
  const ev = page.locator('.rv-evidence');
  say('evidenceCards', await ev.count());
  say('evidenceCells', await ev.locator('.rv-ev-cell').count());
  say('evidenceText', (await ev.innerText()).replace(/\n/g, ' | '));
  say('prevText', (await page.locator('.rv-prev').innerText()).replace(/\n/g, ' | '));
  say('questions', await page.locator('.rv-q-title').allInnerTexts());
  await page.screenshot({ path: path.join(OUT, '13-复盘-本期证据与三问.png') });

  // Act：填第 3 问 → 落成下一步
  const ACT = '把「注册给排水」拆成每天一条可动手的下一步';
  await page.locator('.rv-field textarea').nth(2).fill(ACT);
  await page.locator('.btn', { hasText: '保存复盘三问' }).click();
  await page.waitForTimeout(300);
  const focusBefore = await rawOf('gtd.focus', [todayKey]);
  await page.locator('.rv-act-btn').click();
  await page.waitForTimeout(800);
  say('actMsg', await page.locator('.rv-act-msg').innerText());
  const g1 = await rawOf('gtd.board', [todayKey]);
  const made = (g1.groups.next || []).find((x) => x.title === ACT);
  say('actCreated', !!made);
  if (made) taskIds.push(made.id);
  const focusAfter = await rawOf('gtd.focus', [todayKey]);
  say('focusBeforeAfter', [focusBefore.count, focusAfter.count]);
  await page.screenshot({ path: path.join(OUT, '14-复盘-第3问落成下一步.png') });

  say('pageErrors', errors.slice(0, 5));

  for (const id of taskIds) await invoke('gtd.remove', [id]);
  for (const id of bookIds) await invoke('reading.removeBook', [id]);
  for (const id of dreamIds) await invoke('dream.remove', [id]);
  await invoke('saveReview', ['week', prevKey, ['', '', '']]);
  await invoke('saveReview', ['week', thisKey, ['', '', '']]);
  await app.close();
  console.log('PROBE_DONE');
})().catch(function (e) { console.error('PROBE_FAIL', e.stack || e.message); process.exit(1); });

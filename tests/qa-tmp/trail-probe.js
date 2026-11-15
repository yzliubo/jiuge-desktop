'use strict';
// V3.8 今天页右栏「成长主线」+ 数据中心「成效侧」真窗口探针
// 自带夹具：三条不同证据状态的目标（有完成证据 / 只有存款证据 / 零证据）、
// 一本在读的书、一件可执行的下一步、一次复盘落成（顺带验证成效侧指标真的在记）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = '<仓库根>';
const OUT = '<文档根>/评估-20261114/shots-library';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

function say(k, v) { console.log('[' + k + ']', JSON.stringify(v)); }

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-trail-'));
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
  const pad = (n) => String(n).padStart(2, '0');
  const due = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  const dreamIds = [];
  let taskId = '', bookId = '';

  // ① 有完成证据的目标：挂一件今天完成的任务
  await invoke('dream.add', [{ title: '每周运动 3 次（V38）', area: 'health', horizon: 'short', progress: 40, dueDate: due(5) }]);
  // ② 只有存款证据的目标
  await invoke('dream.add', [{ title: '攒下 8 万存款（V38）', area: 'career', horizon: 'mid', progress: 25, dueDate: due(20) }]);
  // ③ 零证据的目标（刚建，不该被判成「挂着」）
  await invoke('dream.add', [{ title: '考取注册给排水（V38）', area: 'growth', horizon: 'mid', progress: 10, dueDate: due(60) }]);
  const ds = await rawOf('dream.read');
  ['每周运动 3 次（V38）', '攒下 8 万存款（V38）', '考取注册给排水（V38）'].forEach(function (t) {
    const hit = (ds.dreams || []).find((x) => x.title === t);
    if (hit) dreamIds.push(hit.id);
  });
  const [goalRun, goalFund] = dreamIds;

  await invoke('gtd.add', [{ title: '今天跑 5 公里', status: 'next' }]);
  await invoke('gtd.add', [{ title: '写本周周报', status: 'next' }]);
  const gs = await rawOf('gtd.read');
  const runTask = (gs.tasks || []).find((x) => x.title === '今天跑 5 公里');
  if (runTask) {
    taskId = runTask.id;
    await invoke('dream.linkTask', [goalRun, taskId]);
    await invoke('gtd.complete', [taskId]);
  }
  // 存款：先定价再存一笔（两笔都会记 outcome_dream_move）
  await invoke('dream.setFund', [goalFund, 8000000]);
  await invoke('dream.deposit', [goalFund, 1200000, due(0), '本月第一笔', 'money']);
  // 目标进度再推一格 → outcome_dream_move(progress)
  await invoke('dream.update', [goalFund, { progress: 32 }]);

  // ④ 在读的书
  await invoke('reading.addBook', [{ title: '污水处理厂工艺设计', author: '张自杰', total: 420, done: 168, status: 'reading' }]);
  const rs = await rawOf('reading.read');
  const book = (rs.books || []).find((x) => x.title === '污水处理厂工艺设计');
  if (book) { bookId = book.id; await invoke('reading.touch', [bookId, Date.now()]); }

  // ⑤ 复盘落成一次（成效侧第三类）
  const wKey = await invoke('reviewPeriodKey', ['week']);
  await invoke('saveReview', ['week', wKey.data, ['这周每天都有翻书，比上周稳', '', '']]);

  // 回今天页（先切走再回来，强制右栏重取三源）
  await page.locator('.nav-item').nth(1).click();
  await page.waitForTimeout(350);
  await page.locator('.nav-item').first().click();
  await page.waitForTimeout(1000);

  const card = page.locator('section[aria-label="成长主线"]');
  say('trailCard', await card.count());
  say('trailText', (await card.innerText()).replace(/\n/g, ' | '));
  say('goalRows', await card.locator('.tc-goal').count());
  say('bars', await card.locator('.tc-bar i').count());
  await card.screenshot({ path: path.join(OUT, '17-成长主线卡特写.png') });
  await page.screenshot({ path: path.join(OUT, '15-今天右栏-成长主线.png') });

  // 点目标行 → 梦想页
  await card.locator('.tc-goal', { hasText: '每周运动 3 次（V38）' }).click();
  await page.waitForTimeout(800);
  say('jumpDream', await page.locator('.dream-view').count());

  // 数据中心：成效侧应已有事件（gtd.complete / dream.deposit / dream.update / reading / review）
  await page.locator('.nav-item', { hasText: '数据中心' }).click();
  await page.waitForTimeout(900);
  const outcomeHead = page.locator('.outcome-head');
  say('outcomeHead', await outcomeHead.count());
  const gridText = await page.locator('.metric-grid').last().innerText();
  say('outcomeText', gridText.replace(/\n/g, ' | '));
  await page.evaluate(function () {
    const el = document.querySelector('.outcome-head');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '16-数据中心-成效侧指标.png') });
  say('pageErrors', errors.slice(0, 5));

  // 收尾：夹具全部收走
  const finalGtd = await rawOf('gtd.read');
  for (const t of (finalGtd.tasks || [])) {
    if (t.title === '今天跑 5 公里' || t.title === '写本周周报') await invoke('gtd.remove', [t.id]);
  }
  if (bookId) await invoke('reading.removeBook', [bookId]);
  for (const id of dreamIds) await invoke('dream.remove', [id]);
  await invoke('saveReview', ['week', wKey.data, ['', '', '']]);
  await app.close();
  console.log('PROBE_DONE');
})().catch(function (e) { console.error('PROBE_FAIL', e.stack || e.message); process.exit(1); });

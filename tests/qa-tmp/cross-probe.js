'use strict';
// V3.10 跨期对照真窗口探针：上期那句 → 后来怎么样了（已勾掉 / 还没动 / 没落成），
// 以及「连续 N 期说同一件事」与「前几期」列表。自带夹具，跑完截三张到 shots-library/21-23。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const OUT = 'G:/workbuddy/2026-11-08-09-57-53/jiuge-redesign/评估-20261114/shots-library';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

function say(k, v) { console.log('[' + k + ']', JSON.stringify(v)); }

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-cross-'));
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
  const shift = (key, days) => {
    const d = new Date(key + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

  const cur = await rawOf('reviewPeriodKey', ['week']);
  const prev = shift(cur, -7);
  const prev2 = shift(cur, -14);
  say('keys', { cur: cur, prev: prev, prev2: prev2 });

  // ---------- 夹具：连续三期说同一件事（标点不同，算同一句） ----------
  const promise = '每天 23 点前关灯，手机放客厅';
  await invoke('saveReview', ['week', cur, ['本周把复盘挪到周一', '因为周日晚上容易被打断', promise]]);
  await invoke('saveReview', ['week', prev, ['上周想早睡', '总是刷手机到十二点', '每天 23 点前关灯 手机放客厅']]);
  await invoke('saveReview', ['week', prev2, ['两周前也想早睡', '没有把手机拿出卧室', '每天23点前关灯，手机放客厅']]);

  // 上期承诺落成过一条任务，并且已经勾掉（老 source 口径：source='review'，键在 note 里）
  await invoke('gtd.add', [{
    title: '把手机充电器挪到客厅（V310）',
    status: 'next',
    note: '来自 ' + prev + ' 周复盘的第 3 问',
    source: 'review'
  }]);
  const g1 = await rawOf('gtd.read');
  const t1 = g1.tasks.filter((t) => t.title === '把手机充电器挪到客厅（V310）')[0];
  await invoke('gtd.complete', [t1.id]);

  // ---------- 打开回顾 ----------
  await page.locator('.nav-item', { hasText: '回顾' }).first().click();
  await page.waitForTimeout(1400);

  const card = page.locator('.rv-cross');
  say('cardCount', await card.count());
  say('prevText', (await card.locator('.rv-prev-text').innerText()).trim());
  say('linkKind', await card.locator('.rv-cross-link').getAttribute('class'));
  say('linkText', (await card.locator('.rv-cross-link').innerText()).trim());
  say('streak', await card.locator('.rv-cross-repeat').innerText());
  say('histRows', await card.locator('.rv-hist-row').allInnerTexts());
  say('histSame', await card.locator('.rv-hist-same').count());
  say('note', (await card.locator('.rv-cross-note').innerText()).trim());
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, '21-跨期对照-已勾掉.png') });

  // ---------- 情形二：落成了但还没动 ----------
  await invoke('gtd.add', [{
    title: '把手机充电器挪到客厅（V310-未动）',
    status: 'next',
    dueDate: day(-2),
    note: '来自 ' + prev + ' 周复盘的第 3 问',
    source: 'review:' + 'week:' + prev
  }]);
  await invoke('gtd.remove', [t1.id]);
  await page.locator('.seg', { hasText: '周复盘' }).first().click();
  await page.waitForTimeout(1200);
  say('openKind', await card.locator('.rv-cross-link').getAttribute('class'));
  say('openText', (await card.locator('.rv-cross-link').innerText()).trim());
  await card.screenshot({ path: path.join(OUT, '22-跨期对照-还没动.png') });

  // ---------- 情形三：上期没落成（没有痕迹 ≠ 没做到） ----------
  const g2 = await rawOf('gtd.read');
  for (const t of g2.tasks) {
    if (String(t.title).indexOf('（V310') >= 0) await invoke('gtd.remove', [t.id]);
  }
  await page.locator('.seg', { hasText: '周复盘' }).first().click();
  await page.waitForTimeout(1200);
  say('noneKind', await card.locator('.rv-cross-link').getAttribute('class'));
  say('noneText', (await card.locator('.rv-cross-link').innerText()).trim());
  await card.screenshot({ path: path.join(OUT, '23-跨期对照-没落成.png') });

  // ---------- 情形四：上期没写第 3 问（对照链断了，但再上期还在） ----------
  await invoke('saveReview', ['week', prev, ['上周想早睡', '总是刷手机到十二点', '']]);
  await page.locator('.seg', { hasText: '周复盘' }).first().click();
  await page.waitForTimeout(1200);
  say('breakTitle', await card.locator('h2').first().innerText());
  say('breakEmpty', (await card.locator('.rv-cross-empty').innerText()).trim());
  say('breakHasLink', await card.locator('.rv-cross-link').count());
  say('breakHist', await card.locator('.rv-hist-row').allInnerTexts());
  await card.screenshot({ path: path.join(OUT, '24-跨期对照-上期断了.png') });

  say('jsErrors', errors);
  await app.close();
})().catch(function (e) { console.error('PROBE FAIL', e); process.exit(1); });

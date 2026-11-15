'use strict';
// V3.9 练习反馈真窗口探针：技能卡点（挂 27 天）/ 下次提高 / 考试错因与历次作答 /
// 阅读笔记 #行动 回显。自带夹具，跑完截图三张到 shots-library/18-20。
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = 'G:/workbuddy/2026-11-07-09-44-09/jiuge-desktop';
const OUT = 'G:/workbuddy/2026-11-08-09-57-53/jiuge-redesign/评估-20261114/shots-library';
const { _electron: electron } = require(path.join(P, 'tests/e2e/node_modules/playwright'));
delete process.env.ELECTRON_RUN_AS_NODE;

function say(k, v) { console.log('[' + k + ']', JSON.stringify(v)); }

(async function () {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuge-practice-'));
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
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  // ---------- 夹具 ----------
  await invoke('growth.addSkill', [{ title: 'Python 数据处理（V39）' }]);
  const g = await rawOf('growth.read');
  const sk = g.skills.filter((s) => s.title === 'Python 数据处理（V39）')[0];
  await invoke('growth.addMilestone', [sk.id, '能独立清洗一份脏表']);
  await invoke('growth.addMilestone', [sk.id, '能按业务口径做同比']);
  await invoke('growth.toggleMilestone', [sk.id, (await rawOf('growth.read')).skills[0].milestones[0].id]);
  await invoke('growth.addPractice', [sk.id, { date: day(-1), minutes: 60 }]);
  await invoke('growth.addPractice', [sk.id, { date: day(-3), minutes: 45 }]);
  // 卡点：挂 27 天（超过 14 天的阈值，该报警）
  await invoke('growth.setSkillBlocker', [sk.id, '看不懂 groupby 的返回结构', day(-26)]);
  await invoke('growth.setSkillNextUp', [sk.id, '手写一遍三种聚合的差别']);

  await invoke('growth.addExam', [{ title: '一级建造师 · 市政（V39）', examDate: day(40) }]);
  const g2 = await rawOf('growth.read');
  const ex = g2.exams.filter((e) => e.title === '一级建造师 · 市政（V39）')[0];
  await invoke('growth.setExamResult', [ex.id, 58, 60, ['calc', 'time']]);
  await invoke('growth.setExamCauses', [ex.id, ['calc', 'misread']]);
  await invoke('growth.retakeExam', [ex.id]);

  // 阅读笔记 #行动：建一本书 + 两条笔记，其中一条打「行动」标签
  await invoke('reading.addBook', [{ title: '高效能人士的七个习惯（V39）', total: 300, status: 'reading' }]);
  const rb = await rawOf('reading.read');
  const book = rb.books.filter((b) => b.title === '高效能人士的七个习惯（V39）')[0];
  await invoke('reading.addNote', [{
    bookId: book.id, mode: 'leisure', bookTitle: book.title, type: 'idea',
    quote: '要事第一', text: '把每周的三个关键结果写进日历，而不是待办清单', page: 88, tags: ['行动']
  }]);
  await invoke('reading.addNote', [{
    bookId: book.id, mode: 'leisure', bookTitle: book.title, type: 'note',
    quote: '以终为始', text: '这条只是想法，没打行动标签', page: 52, tags: []
  }]);

  // ---------- 打开学习格 ----------
  await page.locator('.cell[data-cell="growth"] .cell-label').click();
  await page.waitForTimeout(1200);
  // 默认停在「考试考证」tab，先切技能
  await page.locator('.g-tab', { hasText: '技能学习' }).click();
  await page.waitForTimeout(400);
  say('skillBadge', await page.locator('.g-row .g-badge-warn').allInnerTexts());
  say('chips', await page.locator('.chip-row .chip').allInnerTexts());

  // 选中技能 → 右栏详情
  await page.locator('.g-row', { hasText: 'Python 数据处理（V39）' }).click();
  await page.waitForTimeout(900);
  const rail = page.locator('#rail-drawer');
  say('blockerAge', await rail.locator('.gc-age').allInnerTexts());
  say('stuckBox', await rail.locator('.gc-stuck').allInnerTexts());
  say('blkInput', await rail.locator('input[aria-label="当前卡点"]').inputValue());
  say('nextInput', await rail.locator('input[aria-label="下次提高一点什么"]').inputValue());
  await page.screenshot({ path: path.join(OUT, '18-学习右栏-卡点与下次提高.png') });

  // 切到考试 tab，选中考试
  await page.locator('.g-tab', { hasText: '考试考证' }).click();
  await page.waitForTimeout(400);
  await page.locator('.g-row', { hasText: '一级建造师 · 市政（V39）' }).click();
  await page.waitForTimeout(900);
  say('causeChips', await rail.locator('.gc-cause').count());
  say('causeOn', await rail.locator('.gc-cause-on').allInnerTexts());
  say('causeHint', await rail.locator('.gc-hint').allInnerTexts());
  say('attemptRows', await rail.locator('.gc-list .gc-item').allInnerTexts());
  await page.screenshot({ path: path.join(OUT, '19-学习右栏-考试错因与历次成绩.png') });

  // 阅读里的行动卡
  const act = rail.locator('.gc-act');
  await act.scrollIntoViewIfNeeded();
  say('actRows', await act.locator('.gc-act-row').allInnerTexts());
  say('actTag', await act.locator('.ctx-tag').innerText());
  await page.screenshot({ path: path.join(OUT, '20-学习右栏-阅读里的行动.png') });

  // 交互：清掉卡点 → 留档
  await page.locator('.g-tab', { hasText: '技能学习' }).click();
  await page.waitForTimeout(400);
  await page.locator('.g-row', { hasText: 'Python 数据处理（V39）' }).click();
  await page.waitForTimeout(700);
  await rail.locator('button', { hasText: '已过去' }).first().click();
  await page.waitForTimeout(1000);
  const after = await rawOf('growth.read');
  const sk2 = after.skills.filter((s) => s.title === 'Python 数据处理（V39）')[0];
  say('afterClear', { blocker: sk2.blocker, cleared: sk2.cleared.length, since: sk2.cleared[0] && sk2.cleared[0].since });

  say('jsErrors', errors);
  await app.close();
})().catch(function (e) { console.error('PROBE FAIL', e); process.exit(1); });

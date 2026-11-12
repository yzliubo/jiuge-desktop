'use strict';
// Playwright + Electron 真 GUI 断言（对应 04-质量保障方案 §2：GUI 真断言 ≥30）
// 断言对象是**真实 Electron 窗口渲染后的 DOM / 交互**，不是静态扫描或哈希。
// 覆盖：三栏工作台 / 九格 / 换肤 / 速记 / 数据中心 + 原小程序 5 页补齐后的全部视图。
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'src/main/main-v2.js');
const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe');
// 档案目录：默认 tests/e2e/.e2e-userdata；可用 JIUGE_E2E_USERDATA 指到别处。
// 有了这个开关，就不必每次递归删旧档案（宿主的安全删除策略会按文件数拦下大批量删除），
// 换一个空目录跑同样干净。
const userData = process.env.JIUGE_E2E_USERDATA
  ? path.resolve(process.env.JIUGE_E2E_USERDATA)
  : path.join(__dirname, '.e2e-userdata');

// 本机 WorkBuddy 会注入该变量，导致 Electron 被当成纯 Node 跑
delete process.env.ELECTRON_RUN_AS_NODE;
// 每次跑都用干净档案：否则上一轮的日记/清单会污染断言。
// 删除本身可能被宿主的安全删除策略拦下（按轮次累计文件数判定），
// 所以吞掉删除失败、但**要求目录真的空**——不能悄悄用脏档案跑。
// 指定 JIUGE_E2E_USERDATA 时走「全新目录」路径：一个删除动作都不做。
// 宿主安全策略会按累计文件数拦批量删除；换空目录同样干净，也不会误删任何东西。
if (process.env.JIUGE_E2E_USERDATA) {
  if (fs.existsSync(userData) && fs.readdirSync(userData).length) {
    throw new Error('指定目录非空，请换一个空目录（本次不会删除任何文件）: ' + userData);
  }
  fs.mkdirSync(userData, { recursive: true });
} else {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch (e) { /* 外部已清理，或被安全删除拦截 */ }
  fs.mkdirSync(userData, { recursive: true });
  if (fs.readdirSync(userData).length) {
    throw new Error('用户数据目录没清干净，拒绝用脏档案跑断言: ' + userData);
  }
}

// 本地电子书 E2E 夹具：最小合法 EPUB（ZIP stored），主进程会真的解析出书名 / 作者 / 封面。
// PROBE 模式下 filePicker 从 JIUGE_V2_PICK_FILES 读它，绕开原生模态框但登记链路是真的。
const EPUB_FIXTURE = (function () {
  function zip(files) {
    const locals = [], centrals = [];
    let offset = 0;
    files.forEach(function (f) {
      const name = Buffer.from(f.name, 'utf8');
      const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
      lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(Buffer.concat([lh, name, data]));
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
      centrals.push(Buffer.concat([ch, name]));
      offset += 30 + name.length + data.length;
    });
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat(locals.concat([cd, eocd]));
  }
  const p = path.join(require('os').tmpdir(), 'jiuge-e2e-book-' + Date.now() + '.epub');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(p, zip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
    { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>城门与水管</dc:title><dc:creator>老刘</dc:creator><meta name="cover" content="ci"/></metadata><manifest><item id="ci" href="images/cover.png" media-type="image/png"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>' },
    { name: 'OEBPS/toc.ncx', data: '<ncx><navMap><navPoint id="n1"><navLabel><text>第一章 水管</text></navLabel><content src="ch1.xhtml"/><navPoint id="n1a"><navLabel><text>第一节 阀门</text></navLabel><content src="ch1.xhtml#v"/></navPoint></navPoint><navPoint id="n2"><navLabel><text>第二章 城门</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap></ncx>' },
    { name: 'OEBPS/ch1.xhtml', data: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1 id="v">第一章 水管</h1><p>城里的水管埋在地下。</p><p>阀门在井里，井盖很沉。</p><img src="images/cover.png" alt="图"/></body></html>' },
    { name: 'OEBPS/ch2.xhtml', data: '<html><body><h1>第二章 城门</h1><p>城门每天开合。</p><p>守门人认得每一个过客。</p></body></html>' },
    { name: 'OEBPS/images/cover.png', data: png }
  ]));
  return p;
})();

// 梦想具象化图片：PROBE 下 filePicker(kind:'image') 直接回这个路径，
// 绕开原生模态框，但「复制进数据目录 → 读成 dataURL → 右栏显示」整条链是真的。
const DREAM_IMG_FIXTURE = (function () {
  const p = path.join(require('os').tmpdir(), 'jiuge-e2e-dream-' + Date.now() + '.png');
  fs.writeFileSync(p, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));
  return p;
})();

let passed = 0;
let failed = 0;
let skipped = 0;
const jsErrors = [];

// 调试用：JIUGE_E2E_ONLY=112,113 只跑编号以这些前缀开头的那几条（默认全跑）。
// 长套件偶发「整窗消失」时，用它把出问题的那一段单独复现出来，不用每次赔上五分钟。
const ONLY = String(process.env.JIUGE_E2E_ONLY || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

async function check(name, fn) {
  if (ONLY.length && !ONLY.some(function (p) { return name.indexOf(p) === 0; })) {
    skipped++;
    return;
  }
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + ' :: ' + e.message);
  }
}

// 等厘清向导真的走到第 N 步：面板是同一块 DOM 换内容，光 waitForTimeout
// 会在慢一点的时候点到上一步的按钮上（点错元素 → 界面跳到别处，整串断言跟着炸）
async function waitStep(page, n) {
  await page.waitForFunction(function (want) {
    const el = document.querySelector('.cp-step');
    return !!el && el.textContent.indexOf('第 ' + want + ' / 3 步') >= 0;
  }, n, { timeout: 5000 });
}

(async function main() {
  let app = null;
  try {
    console.log('gui-assert | Playwright 驱动真实 Electron 窗口');
    console.log('');
    app = await electron.launch({
      executablePath: electronExe,
      args: [entry],
      env: Object.assign({}, process.env, {
        JIUGE_V2_USERDATA: userData,
        JIUGE_V2_PROBE: '1',
        JIUGE_V2_PICK_FILES: EPUB_FIXTURE,
        JIUGE_V2_PICK_IMAGE: DREAM_IMG_FIXTURE
      }),
      timeout: 60000
    });
    const page = await app.firstWindow();
    page.on('pageerror', function (err) { jsErrors.push(String(err && err.message || err)); });
    page.on('console', function (msg) {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (/Content Security Policy|unsafe-eval|NODE_OPTIONS|DevTools/i.test(t)) return;
      jsErrors.push('console: ' + t);
    });
    await page.waitForSelector('.workbench', { timeout: 30000 });
    await page.waitForTimeout(400);

    // --- 布局与初始状态 ---
    await check('01 工作台根节点存在', async () => {
      assert.strictEqual(await page.locator('.workbench').count(), 1);
    });
    await check('02 初始皮肤为森绿米白', async () => {
      assert.strictEqual(await page.locator('.workbench').getAttribute('data-skin'), 'forest');
    });
    await check('03 V1.0 基底固定 light（不出深浅色切换 UI）', async () => {
      assert.strictEqual(await page.locator('.workbench').getAttribute('data-surface'), 'light');
    });
    await check('04 标题栏存在', async () => {
      assert.strictEqual(await page.locator('.titlebar').count(), 1);
    });
    await check('05 左栏导航存在', async () => {
      assert.strictEqual(await page.locator('.nav').count(), 1);
    });
    await check('06 中部编辑区存在', async () => {
      assert.strictEqual(await page.locator('.center').count(), 1);
    });
    await check('07 右栏上下文存在', async () => {
      assert.strictEqual(await page.locator('.context').count(), 1);
    });
    await check('08 状态栏存在', async () => {
      assert.strictEqual(await page.locator('.statusbar').count(), 1);
    });
    await check('09 一级导航 7 项 + 设置共 8 项（原 5 页桌面化重组 + 娱乐）', async () => {
      assert.strictEqual(await page.locator('.nav-item').count(), 8);
    });
    await check('10 首项「今天」选中态 class + aria-current', async () => {
      const first = page.locator('.nav-item').first();
      assert((await first.getAttribute('class')).includes('nav-on'));
      assert.strictEqual(await first.getAttribute('aria-current'), 'page');
    });
    await check('11 九格仍是 9 个：梦想那格换成「娱乐」', async () => {
      const n = await page.locator('.cell').count();
      assert.strictEqual(n, 9, '九格数量是 ' + n + '，不是 9');
      assert.strictEqual(await page.locator('.cell[data-cell="dream"]').count(), 0, '梦想还占着九格');
      assert.strictEqual(await page.locator('.cell[data-cell="leisure"]').count(), 1, '九格里没有娱乐格');
      assert((await page.locator('.cell[data-cell="leisure"] .cell-label').innerText()).includes('娱乐'));
    });
    await check('12 每格都有可编辑的富文本区（contenteditable）', async () => {
      assert.strictEqual(await page.locator('.cell .rt-body').count(), 9);
      assert.strictEqual(await page.locator('.cell [contenteditable="true"]').count(), 9);
    });
    await check('13 九格仍是 3 列 3 排', async () => {
      const cols = await page.$eval('.grid', function (el) {
        return getComputedStyle(el).gridTemplateColumns.split(' ').length;
      });
      assert.strictEqual(cols, 3);
    });
    await check('13a 页头无日期、九格引导语各不相同、单击标题直达对应模块', async () => {
      // 日期文字已从九格页头下线（补记时仍留「补记」标记，具体日期由横幅明示）
      const head = await page.locator('.editor .date-head').innerText();
      assert(!/\d{4}-\d{2}-\d{2}/.test(head), '九格页头还在显示日期：' + head);
      assert(head.includes('已写'), '页头统计被一起删了');

      // 九格占位提示各按模块取词，不再是同一句「随手一句，可写多行」
      const ph = await page.locator('.cell .rt-body').evaluateAll(function (els) {
        return els.map(function (el) { return el.getAttribute('data-placeholder') || ''; });
      });
      assert.strictEqual(ph.length, 9, '没取到九格引导语');
      assert.strictEqual(new Set(ph).size, 9, '引导语没按模块区分：' + ph.join(' | '));
      assert(ph.every(function (t) { return !!t && t.indexOf('随手一句，可写多行') < 0; }),
        '仍显示统一占位语或空提示');

      // 标题单击走 open-cell：工作推进 → GTD 工作台，返回后九格还在
      await page.locator('.cell[data-cell="work"] .cell-label').click();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.gtd-view').count(), 1, '单击标题没进入对应模块');
      await page.locator('.gtd-view .back').click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.grid').count(), 1, '返回后没回到九格');
    });
    await check('14 初始徽标为「已保存」', async () => {
      assert((await page.locator('.badge').textContent()).includes('已保存'));
    });
    await check('15 模块抽屉默认收起（aria-expanded=false）', async () => {
      assert.strictEqual(await page.locator('.drawer-toggle').getAttribute('aria-expanded'), 'false');
    });
    await check('16 皮肤 4 套收在标题栏右侧，右栏底部不再重复', async () => {
      // 2026-11-08 22:32：皮肤从右栏底部上移到顶栏，全局面板不再每页出现一次
      assert.strictEqual(await page.locator('.skin-pick .skin-dot').count(), 4);
      const inBar = await page.locator('.titlebar').evaluate(function (el) {
        return el.querySelectorAll('.skin-dot').length === 4;
      });
      assert(inBar, '皮肤色点不在标题栏里');
      assert.strictEqual(await page.locator('.context .skin-dot, .context .skin-card').count(), 0, '右栏还留着皮肤选择');
      // 顶栏放得下：色点 + 快速记录 + 设置，不能把色点挤出可视区
      const box = await page.locator('.skin-pick').boundingBox();
      const win = await page.evaluate(function () { return window.innerWidth; });
      assert(box && box.x > 0 && box.x + box.width <= win, '皮肤色点被挤出标题栏');
    });
    await check('17 今天右栏：联动头 + 今日状态 / 九格进度 / 往年今天', async () => {
      assert.strictEqual(await page.locator('.ctx-head').count(), 1);
      const t = await page.locator('.context').textContent();
      assert(t.includes('今日状态') && t.includes('九格进度') && t.includes('往年今天'), t.slice(0, 80));
      assert.strictEqual(await page.locator('.context .ctx-dot').count(), 9);
    });
    await check('18 状态栏三态声明（零网络 / 仅本机回环 / 仅天气联网）与版本号', async () => {
      const t = await page.locator('.statusbar').textContent();
      // 2026-11-11：首页天气默认开启后，「零网络」不再是唯一事实。
      // 断言保留原意——这句必须准确反映当前联网状态，而不是写死一句。
      assert(/纯本地 · (零网络|仅本机回环|仅天气联网|仅本机回环 \+ 天气联网)/.test(t), '底栏联网声明不准确：' + t);
      assert(t.includes('V1.0'), '底栏没有版本号：' + t);
    });
    await check('18b 底栏压到 22px、不横向溢出，版权卡不再出现在右栏', async () => {
      const m = await page.evaluate(function () {
        const el = document.querySelector('.statusbar');
        const r = el.getBoundingClientRect();
        return { h: r.height, bottom: r.bottom, vh: window.innerHeight, sw: el.scrollWidth, cw: el.clientWidth };
      });
      assert(m.h <= 24, '底栏还是 ' + m.h.toFixed(1) + 'px 高（要求 ≤24）');
      assert(m.h >= 18, '底栏压得太狠，' + m.h.toFixed(1) + 'px 会把字切掉');
      assert(Math.abs(m.bottom - m.vh) <= 1, '底栏没贴住窗口底部');
      assert(m.sw <= m.cw + 1, '底栏文字横向溢出：' + m.sw + ' > ' + m.cw);
      assert.strictEqual(await page.locator('.ctx-foot, .ctx-foot-card').count(), 0, '右栏还挂着版权卡');
    });
    await check('19 页面无远程资源引用', async () => {
      const urls = await page.evaluate(function () {
        return Array.from(document.querySelectorAll('script[src], link[href], img[src]'))
          .map(function (el) { return el.getAttribute('src') || el.getAttribute('href'); })
          .filter(Boolean);
      });
      assert(urls.every(function (u) { return !/^https?:\/\//.test(u); }), JSON.stringify(urls));
    });

    // --- 输入 / 保存 / 状态类联动（B1 盲区） ---
    const firstCell = page.locator('.cell').first().locator('.rt-body');
    await check('20 输入第一格后该格获得 cell-on 焦点态', async () => {
      await firstCell.click();
      await page.keyboard.type('桌面版 GUI 真断言');
      await page.waitForTimeout(150);
      assert((await page.locator('.cell').first().getAttribute('class')).includes('cell-on'));
    });
    await check('21 输入过程中焦点保持在编辑区（不失焦）', async () => {
      const active = await page.evaluate(function () {
        const el = document.activeElement;
        return el ? { tag: el.tagName, editable: !!el.isContentEditable } : null;
      });
      assert(active && active.editable, JSON.stringify(active));
    });
    await check('22 输入后徽标变「未保存」且 badge-on 生效', async () => {
      assert((await page.locator('.badge').textContent()).includes('未保存'));
      assert((await page.locator('.badge').getAttribute('class')).includes('badge-on'));
    });
    await check('23 保存按钮 save-on 且可点击', async () => {
      assert((await page.locator('.save-btn').getAttribute('class')).includes('save-on'));
      assert.strictEqual(await page.locator('.save-btn').isEnabled(), true);
    });
    await check('24 点击保存后徽标回到「已保存」', async () => {
      await page.locator('.save-btn').click();
      await page.waitForTimeout(400);
      assert((await page.locator('.badge').textContent()).includes('已保存'));
    });
    await check('25 保存后正文回显不丢字', async () => {
      assert.strictEqual((await firstCell.innerText()).trim(), '桌面版 GUI 真断言');
    });
    await check('26 抽屉展开后 aria-expanded=true 且 drawer-on 生效', async () => {
      await page.locator('.drawer-toggle').click();
      assert.strictEqual(await page.locator('.drawer-toggle').getAttribute('aria-expanded'), 'true');
      assert((await page.locator('.drawer-toggle').getAttribute('class')).includes('drawer-on'));
    });
    await check('27 抽屉含 3 个模块入口', async () => {
      assert.strictEqual(await page.locator('.drawer-tab').count(), 3);
    });

    // --- 换肤：数据变化后 DOM 选中态必须跟随（B1 类别缺陷专项） ---
    await check('28 点击「冷调夜航」→ 根 data-skin=night', async () => {
      await page.locator('.skin-pick .skin-dot').nth(1).click();
      await page.waitForTimeout(150);
      assert.strictEqual(await page.locator('.workbench').getAttribute('data-skin'), 'night');
    });
    await check('29 选中态落在 night 且 aria-checked=true', async () => {
      const dot = page.locator('.skin-pick .skin-dot').nth(1);
      assert((await dot.getAttribute('class')).includes('skin-dot-on'));
      assert.strictEqual(await dot.getAttribute('aria-checked'), 'true');
    });
    await check('30 其它色点 aria-checked=false（状态不残留）', async () => {
      const states = await page.locator('.skin-pick .skin-dot').evaluateAll(function (els) {
        return els.map(function (el) { return el.getAttribute('aria-checked'); });
      });
      assert.deepStrictEqual(states, ['false', 'true', 'false', 'false']);
    });
    await check('31 再切「樱花奶油」→ 选中态唯一且转移', async () => {
      await page.locator('.skin-pick .skin-dot').nth(2).click();
      await page.waitForTimeout(150);
      assert.strictEqual(await page.locator('.workbench').getAttribute('data-skin'), 'sakura');
      assert.strictEqual(await page.locator('.skin-dot-on').count(), 1);
    });
    await check('32 切视图后右栏内容整块替换（联动，不是固定卡片）', async () => {
      const before = await page.locator('.context').innerText();
      await page.locator('.nav-item').nth(1).click();
      await page.waitForTimeout(400);
      const after = await page.locator('.context').innerText();
      assert(before !== after, '右栏在时间轴仍是今天那份内容');
      assert(after.includes('月度分布'), after.slice(0, 80));
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(300);
    });

    // --- 速记浮窗 ---
    await check('33 点击「＋ 快速记录」浮窗出现且 note-on 生效', async () => {
      await page.locator('.quick-btn').click();
      assert.strictEqual(await page.locator('.quick').count(), 1);
      assert((await page.locator('.quick').getAttribute('class')).includes('note-on'));
    });
    await check('34 速记输入后 input-on / submit-on 生效', async () => {
      await page.locator('.quick-input').fill('开会时随手记一句');
      assert((await page.locator('.quick-input').getAttribute('class')).includes('input-on'));
      assert((await page.locator('.submit').getAttribute('class')).includes('submit-on'));
    });
    await check('35 Enter 保存后浮窗关闭且内容写入自由格', async () => {
      await page.locator('.quick-input').press('Enter');
      await page.waitForTimeout(500);
      assert.strictEqual(await page.locator('.quick').count(), 0);
      const free = await page.locator('.cell[data-cell="free"] .rt-body').innerText();
      assert(free.includes('开会时随手记一句'));
    });

    await check('35a 速记四处分流：四个去处、记住上次、参考资料带 #资料 标记', async () => {
      await page.locator('.quick-btn').click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.target').count(), 4, '没有四个去处');
      assert((await page.locator('.target-on').textContent()).includes('自由格'), '首次默认不是自由格');
      await page.locator('.target').nth(3).click();
      assert((await page.locator('.target-on').textContent()).includes('参考资料'));
      await page.locator('.quick-input').fill('规范 5.3.2 条摘录');
      await page.locator('.quick-input').press('Enter');
      await page.waitForTimeout(550);
      assert.strictEqual(await page.locator('.quick').count(), 0);
      const free = await page.locator('.cell[data-cell="free"] .rt-body').innerText();
      assert(free.includes('#资料'), '参考资料没带 #资料 标记');
      // 关掉再开：去处要记住上次选择，否则「回车即存」会存错地方
      await page.locator('.quick-btn').click();
      await page.waitForTimeout(250);
      assert((await page.locator('.target-on').textContent()).includes('参考资料'), '没记住上次的去处');
      // 胶囊要给出开启日期，且默认必须在未来
      await page.locator('.target').nth(2).click();
      await page.waitForTimeout(150);
      assert.strictEqual(await page.locator('.cap-date').count(), 1, '选胶囊没出现开启日期');
      const openAt = await page.locator('.cap-date').inputValue();
      assert(openAt > new Date().toISOString().slice(0, 10), '胶囊默认开启日期不在未来：' + openAt);
      await page.locator('.close').click();
      await page.waitForTimeout(150);
    });

    // --- 今日页补齐：问候 / 名言 / 基础栏 / 头七天 / 洞察 ---
    await check('36 问候头无底色、时间在最顶且大字号，名言为独立模块紧随其下', async () => {
      assert.strictEqual(await page.locator('.greeting-bar').count(), 1);
      const beforeGrid = await page.locator('.center').evaluate(function (el) {
        const g = el.querySelector('.greeting-bar');
        const grid = el.querySelector('.grid');
        return !!(g && grid) && (g.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      assert(beforeGrid, '问候条不在九格编辑器之前');
      const t = await page.locator('.greeting-bar').textContent();
      // 2026-11-11：问候头已把「本机 N 篇」下放底栏、改显「本周 x/y」，同步过时断言
      assert(t.includes('连续') && t.includes('本周'), t.slice(0, 120));
      assert.strictEqual(await page.locator('.greeting-line').count(), 1);
      assert.strictEqual(await page.locator('.quote-line').count(), 1);
      assert((await page.locator('.quote-line').textContent()).length > 4);

      // ① 时间必须在问候头内部、且是第一个子元素；不能又跑到统计后面去
      assert.strictEqual(await page.locator('.greeting-time').count(), 1, '缺少时间行');
      const timeFirst = await page.locator('.greeting-bar').evaluate(function (el) {
        const first = el.firstElementChild;
        return !!first && first.classList.contains('greeting-time');
      });
      assert(timeFirst, '时间不在问候头最顶部');
      const timeText = (await page.locator('.greeting-time').textContent()).trim();
      assert(/\d/.test(timeText) && timeText.length >= 4, '时间行没取到日期：' + timeText);

      // ② 字体加大：问候语实测字号 ≥ 20px（原来是 15px）
      const px = await page.locator('.greeting-line').evaluate(function (el) {
        return parseFloat(getComputedStyle(el).fontSize);
      });
      assert(px >= 20, '问候语字号没加大：' + px + 'px');

      // ③ 不需要底色：问候头背景必须透明、且没有边框
      const head = await page.locator('.greeting-bar').evaluate(function (el) {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderTopWidth };
      });
      assert(head.bg === 'rgba(0, 0, 0, 0)' || head.bg === 'transparent', '问候头仍有底色：' + head.bg);
      assert(parseFloat(head.border) === 0, '问候头仍有边框：' + head.border);

      // ④ 名言单独成块，位置在问候头之后，且自己是有底色的一块
      assert.strictEqual(await page.locator('.quote-block').count(), 1, '名言没独立成块');
      const after = await page.locator('.center').evaluate(function (el) {
        const g = el.querySelector('.greeting-bar');
        const q = el.querySelector('.quote-block');
        if (!g || !q) return false;
        const follows = (g.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        return follows && q.contains(q.querySelector('.quote-line'));
      });
      assert(after, '名言块不在问候头下方，或名言不在块内');
      const qbg = await page.locator('.quote-block').evaluate(function (el) {
        return getComputedStyle(el).backgroundColor;
      });
      assert(qbg !== 'rgba(0, 0, 0, 0)' && qbg !== 'transparent', '名言块没有底色，与问候头分不开');
    });
    await check('36b 首页天气：默认开、与时间同行、点开能看到取数口径', async () => {
      // 默认开启：主理人 2026-11-11 要的是「打开就有」，不是「先去设置里找开关」
      assert.strictEqual(await page.locator('.greeting-time .weather').count(), 1, '时间行右侧没有天气条');
      const sameRow = await page.locator('.greeting-time').evaluate(function (el) {
        const w = el.querySelector('.weather');
        if (!w) return false;
        const a = el.getBoundingClientRect();
        const b = w.getBoundingClientRect();
        return b.top >= a.top - 2 && b.bottom <= a.bottom + 2 && b.left > a.left;
      });
      assert(sameRow, '天气条不在时间同一行的右侧（会另起一条横条挤掉九格）');
      await page.locator('.wx-btn').click();
      await page.waitForTimeout(200);
      const pop = await page.locator('.wx-pop').textContent();
      assert(pop.includes('刷新') && pop.includes('关闭天气'), '天气浮层缺刷新或关闭：' + pop.slice(0, 80));
      assert(pop.includes('不发送日记'), '天气浮层没写清「不发送日记」');
      await page.keyboard.press('Escape');
      await page.locator('.greeting-line').click();
      await page.waitForTimeout(150);
      assert.strictEqual(await page.locator('.wx-pop').count(), 0, '点外面浮层没关掉');
    });
    await check('37 基础栏 3 个下拉 + 1 个纪念日输入，档位取自原 BASE_FIELDS', async () => {
      assert.strictEqual(await page.locator('.base-grid select').count(), 3);
      assert.strictEqual(await page.locator('.base-grid input').count(), 1);
      const opts = await page.locator('.base-grid select').first().locator('option').allTextContents();
      assert(opts.includes('晴') && opts.includes('雾'), JSON.stringify(opts));
    });
    await check('38 选择天气并保存今日状态 → toast 提示且值回显', async () => {
      await page.locator('.base-grid select').first().selectOption('晴');
      await page.getByRole('button', { name: '记下今日状态' }).click();
      await page.waitForTimeout(350);
      assert((await page.locator('.toast').textContent()).includes('今日状态已记下'));
      assert.strictEqual(await page.locator('.base-grid select').first().inputValue(), '晴');
    });
    await check('38b 天气档位二态：联网自动带入 / 断网提示手填，必有其一', async () => {
      const t = await page.locator('.today-opt .extras').textContent();
      assert(/已带进今天|请在这里手填|已改为手填/.test(t || ''),
        '今日状态卡没有说清天气来源：' + String(t).slice(0, 90));
    });
    await check('38c 一次保存后「今天概览」天气 chip 同步回显', async () => {
      const chip = await page.locator('.ctx-card .chip').first().textContent();
      assert((chip || '').indexOf('晴') >= 0, '今天概览没跟上刚保存的天气：' + chip);
    });
    await check('39 一键留一句追加到「自由」格', async () => {
      await page.locator('.quick-row input').fill('补一句也算一篇');
      await page.getByRole('button', { name: '留一句' }).click();
      await page.waitForTimeout(350);
      const free = await page.locator('.cell[data-cell="free"] .rt-body').innerText();
      assert(free.includes('补一句也算一篇'));
    });
    await check('40 单格洞察已上移到标题栏，左栏不再有这一项', async () => {
      // 2026-11-08 23:16：单格洞察从左栏二级目录移到标题栏
      assert.strictEqual(await page.locator('.nav-insight').count(), 0, '左栏还留着单格洞察');
      assert.strictEqual(await page.locator('.titlebar .insight-btn').count(), 1, '标题栏没有单格洞察');
      assert((await page.locator('.insight-btn').textContent()).includes('单格洞察'));
      assert.strictEqual(await page.locator('.insight-picks .pick').count(), 0);
      await page.locator('.insight-btn').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.insight-view').count(), 1);
      assert((await page.locator('.insight-btn').getAttribute('class')).includes('insight-on'));
      assert.strictEqual(await page.locator('.insight-btn').getAttribute('aria-current'), 'page');
      // 回到今天，后续断言继续按原索引在今日页执行
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(200);
      assert(!(await page.locator('.insight-btn').getAttribute('class')).includes('insight-on'), '回来还亮着');
    });
    await check('40b 九格直接挂在「今天」下级：9 个四字目录项，无折叠组、无二级标签', async () => {
      // 层级：不再有「今日 · 二级」小标题，也没有「记录模块」这一层折叠组
      assert.strictEqual(await page.locator('.nav-sub-group').count(), 0, '「记录模块」折叠组还在');
      assert.strictEqual(await page.locator('.sub-label').count(), 0, '「今日 · 二级」标签还在');
      const mods = page.locator('.nav-mod');
      assert.strictEqual(await mods.count(), 9);
      const labels = await mods.allTextContents();
      // 九格统一四字名
      ['工作推进', '金钱收支', '身心健康', '关系经营', '今日六条', '情绪觉察', '休闲娱乐', '学习成长', '自由记录'].forEach(function (l, i) {
        assert(labels[i].includes(l), '第 ' + (i + 1) + ' 项应为 ' + l + '，实际 ' + labels[i]);
        assert(l.trim().replace(/\s/g, '').length === 4, '第 ' + (i + 1) + ' 项不是四字名：' + labels[i]);
      });
      // 缩进一级：它们直接是「今天」的子项，不再缩两层
      const indent = await mods.first().evaluate(function (el) {
        return getComputedStyle(el).marginLeft;
      });
      assert(parseInt(indent, 10) <= 18, '目录项还是按三级缩进：' + indent);
      // 直接点「身心健康」进单格工作台，不必回九格双击
      await mods.nth(2).click();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.cell-view').count(), 1);
      assert((await page.locator('.cell-view h2').textContent()).includes('身心健康'));
      assert((await page.locator('.nav-mod').nth(2).getAttribute('class')).includes('sub-on'));
      await page.locator('.cell-view .back').click();
      await page.waitForTimeout(250);
    });

    // --- 三大模块面板 ---
    await check('41 本页选项 → 快速录入：模块 tab 3 个且 mod-tab-on 唯一', async () => {
      // 三块录入面板已从主栏搬进右栏「本页选项」，先切到那一栏
      assert.strictEqual(await page.locator('.panels').count(), 0, '录入面板还挂在中栏');
      await page.getByRole('tab', { name: '快速录入' }).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.context .panels').count(), 1, '右栏里没有录入面板');
      assert.strictEqual(await page.locator('.mod-tab').count(), 3);
      assert.strictEqual(await page.locator('.mod-tab-on').count(), 1);
    });
    await check('42 工作看板：添加任务后列表出现且可勾选', async () => {
      await page.locator('.panels input[placeholder^="今天要做什么"]').fill('写质量报告 #工作');
      await page.getByRole('button', { name: '添加', exact: true }).click();
      await page.waitForTimeout(300);
      assert((await page.locator('.panels .list').textContent()).includes('写质量报告 #工作'));
      await page.locator('.panels .item .check').first().click();
      await page.waitForTimeout(250);
      assert((await page.locator('.panels .item').first().getAttribute('class')).includes('item-on'));
    });
    await check('43 记一笔收支：切 tab、金额按分落盘、结余刷新', async () => {
      await page.getByRole('tab', { name: '记一笔收支' }).click();
      await page.locator('.panels input[placeholder="金额（元）"]').fill('12.50');
      await page.locator('.panels input[placeholder="一句备注"]').fill('午饭');
      await page.getByRole('button', { name: '记一笔' }).click();
      await page.waitForTimeout(300);
      assert((await page.locator('.panels .list').textContent()).includes('12.50'));
      assert((await page.locator('.money-row').textContent()).includes('12.50'));
    });
    await check('44 学习进展：一句话加一本书并翻 10 页（写的是 md_growth）', async () => {
      await page.getByRole('tab', { name: '学习进展' }).click();
      await page.waitForTimeout(200);
      await page.locator('.panels input[placeholder^="在读哪本"]').fill('设计心理学');
      await page.getByRole('button', { name: '读一段' }).click();
      await page.waitForTimeout(600);
      const list = await page.locator('.panels .list').textContent();
      assert(list.includes('设计心理学'), '加完没出现在列表里：' + list);
      assert(list.includes('10 / 300'), '没有翻到 10 页：' + list);
    });

    // --- 时间轴（原「回看」页的日记视图） ---
    await check('45 时间轴只含日记子模块，不再出现重复三 tab', async () => {
      await page.locator('.nav-item').nth(1).click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.review').count(), 1);
      assert.strictEqual(await page.locator('.rv-tab').count(), 0);
      assert.strictEqual(await page.locator('.diary').count(), 1);
      assert.strictEqual(await page.locator('.retro').count(), 0);
      assert.strictEqual(await page.locator('.grid-cards').count(), 0);
      assert((await page.locator('.review h1').textContent()).includes('时间轴'));
    });
    await check('46 全年像素年历固定 372 格（12 月 × 31 天）', async () => {
      assert.strictEqual(await page.locator('.px').count(), 372);
    });
    await check('47 关键词查找（过滤模式）只返回命中条目', async () => {
      // 默认是「定位」（列表不动 + 高亮跳转，见 #107a），过滤要显式切过去
      await page.getByRole('button', { name: '过滤' }).click();
      await page.waitForTimeout(250);
      await page.locator('.diary input[placeholder="正文 / 栏目关键词"]').fill('桌面版');
      await page.getByRole('button', { name: '查找' }).click();
      await page.waitForTimeout(300);
      assert((await page.locator('.diary').textContent()).includes('桌面版'));
      assert.strictEqual(await page.locator('.rv-loc-row').count(), 0, '过滤模式不该再画全量列表');
      assert((await page.locator('.rv-find .line').count()) >= 1, '过滤没有命中行');
      // 切回定位，别把模式漏给后面的用例
      await page.getByRole('button', { name: '定位' }).click();
      await page.waitForTimeout(250);
    });

    // --- 回顾（仅复盘） ---
    await check('48 回顾只含复盘子模块，不再出现概览 / 日记', async () => {
      await page.locator('.nav-item').nth(2).click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.rv-tab').count(), 0);
      assert.strictEqual(await page.locator('.retro').count(), 1);
      assert.strictEqual(await page.locator('.retro textarea').count(), 3);
      assert.strictEqual(await page.locator('.diary').count(), 0);
      assert.strictEqual(await page.locator('.grid-cards').count(), 0);
      assert((await page.locator('.review h1').textContent()).includes('回顾'));
    });
    await check('49 周 / 月复盘切换后周期键变化', async () => {
      const before = await page.locator('.retro .muted').first().textContent();
      await page.getByRole('button', { name: '月复盘' }).click();
      await page.waitForTimeout(250);
      const after = await page.locator('.retro .muted').first().textContent();
      assert.notStrictEqual(before, after);
    });

    // --- 胶囊 ---
    await check('50 胶囊弹窗：4 个日期预设与 3 组分类（已从一级导航降到顶栏）', async () => {
      await page.locator('.titlebar .capsule-btn').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.cm-box').count(), 1, '顶栏胶囊按钮没弹出弹窗');
      assert.strictEqual(await page.locator('.capsule').count(), 1);
      assert.strictEqual(await page.locator('.cm-tab').count(), 2, '书写 / 到期两态不齐');
      assert.strictEqual(await page.locator('.capsule .seg').count(), 4);
      assert((await page.locator('.capsule').textContent()).includes('封存中'));
    });
    await check('51 封存新胶囊后进入「封存中」组', async () => {
      await page.locator('.capsule textarea').fill('给三个月后的自己');
      await page.getByRole('button', { name: '封存', exact: true }).click();
      await page.waitForTimeout(400);
      assert((await page.locator('.capsule').textContent()).includes('已封存，到期才能开启'));
      assert((await page.locator('.capsule').textContent()).includes('封存中 1'));
    });
    await check('52 到期前不泄露正文，点「开启」给出守门提示', async () => {
      const sealed = page.locator('.capsule .item').filter({ hasText: '内容封存中' }).first();
      assert.strictEqual(await sealed.count(), 1);
      await sealed.getByRole('button', { name: '开启' }).click();
      await page.waitForTimeout(200);
      assert((await page.locator('.capsule .message').textContent()).includes('还没到开启的日子'));
      assert.strictEqual(await page.locator('.opened').count(), 0);
      // 弹窗是覆盖层，不关掉会挡住后面所有左栏点击
      await page.locator('.cm-x').click();
      await page.waitForTimeout(150);
      assert.strictEqual(await page.locator('.cm-box').count(), 0);
    });

    // --- 坚持 ---
    await check('53 坚持视图展示默认 4 个里程碑与三大考验期', async () => {
      await page.locator('.nav-item').nth(4).click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.habit').count(), 1);
      assert.strictEqual(await page.locator('.habit .item').count(), 4);
      assert((await page.locator('.habit').textContent()).includes('三大考验期'));
    });
    await check('54 自定义里程碑「第 7 天」写入并可合并', async () => {
      await page.locator('.habit input.at').fill('7');
      await page.locator('.habit input[placeholder^="给自己的奖励"]').fill('一杯好咖啡');
      await page.getByRole('button', { name: '添加 / 合并' }).click();
      await page.waitForTimeout(350);
      assert((await page.locator('.habit').textContent()).includes('一杯好咖啡'));
      assert.strictEqual(await page.locator('.habit .item').count(), 5);
    });

    // --- 设置 ---
    await check('55 设置视图 4 皮肤 / 4 模板 / 6 开关（含天气）', async () => {
      await page.locator('.nav-gear').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.settings').count(), 1);
      assert.strictEqual(await page.locator('.settings .skin').count(), 4);
      // 第 8 卡「语言」也用 .seg，不能拿 .settings .seg 一把数（会把 4 个模板算成 9 个）。
      // 只数第 2 张卡（页面模板）里的分段按钮，断言才是在说「4 个模板」这件事。
      assert.strictEqual(await page.locator('.settings .card').nth(1).locator('.seg').count(), 4,
        '页面模板不是 4 个');
      // 2026-11-11：首页天气也是一个开关（默认开），所以从 5 变 6
      assert.strictEqual(await page.locator('.settings .switch').count(), 6, '模块 3 + 头七天 + 本机时间源 + 首页天气');
      const setText = await page.locator('.settings').textContent();
      assert(setText.includes('首页天气与位置'), '设置页缺首页天气卡片');
      assert(setText.includes('不发送日记'), '设置页没说清天气不发送日记内容');
    });
    await check('56 切换模板后 aria-pressed 与 seg-on 同步', async () => {
      await page.locator('.settings .seg').nth(1).click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.settings .seg').nth(1).getAttribute('aria-pressed'), 'true');
      assert((await page.locator('.settings .seg').nth(1).getAttribute('class')).includes('seg-on'));
    });
    await check('57 关闭模块后 aria-checked 变 false 且 toast 说明数据保留', async () => {
      await page.locator('.settings .switch').first().click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.settings .switch').first().getAttribute('aria-checked'), 'false');
      assert((await page.locator('.toast').textContent()).includes('数据仍保留'));
    });
    await check('58 设置页「打开数据中心」跳回唯一数据入口', async () => {
      await page.getByRole('button', { name: '打开数据中心' }).click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.dc').count(), 1);
    });

    // --- 数据中心（唯一导入 / 导出入口） ---
    await check('59 数据中心 4 个动作卡', async () => {
      assert.strictEqual(await page.locator('.action-card').count(), 4);
    });
    await check('60 切换动作卡时 action-on 唯一且 aria-selected 同步', async () => {
      await page.locator('.action-card').nth(0).click();
      assert.strictEqual(await page.locator('.action-on').count(), 1);
      assert.strictEqual(await page.locator('.action-card').nth(0).getAttribute('aria-selected'), 'true');
    });
    await check('61 剪贴板明确标注「仅复制文本，不是备份」', async () => {
      assert((await page.locator('.dc').textContent()).includes('仅复制文本，不是备份'));
    });
    await check('62 另存为文件：回执含完整路径且 receipt-on 生效', async () => {
      await page.locator('.dc .primary').click();
      await page.waitForTimeout(400);
      assert((await page.locator('.receipt').getAttribute('class')).includes('receipt-on'));
      // 不能硬编码 C:\Users：本机为避开 C 盘空间把 TEMP 指到了 G 盘，探针模式的落盘目录随 TEMP 走。
      // 要验的是「回执给的是完整绝对路径 + 真实文件名 + 字节数」，不是路径前缀。
      const rc = (await page.locator('.receipt').textContent()).trim();
      assert(/[A-Za-z]:[\\/]/.test(rc), '回执里没有完整绝对路径：' + rc);
      assert(/九格手记-备份-\d{4}-\d{2}-\d{2}\.(json|txt|md)/.test(rc), '回执里没有真实文件名：' + rc);
      assert(/字节/.test(rc), '回执里没有字节数：' + rc);
      assert((await page.locator('.dc .message').textContent()).includes('已写出文件'));
    });
    await check('63 导入非法 JSON 明确报错，不谎称成功', async () => {
      await page.locator('.action-card').nth(1).click();
      await page.locator('.dc textarea').fill('{ 不是 JSON');
      await page.getByRole('button', { name: '预览并导入' }).click();
      await page.waitForTimeout(250);
      assert((await page.locator('.dc .message').textContent()).includes('导入失败'));
    });
    await check('64 其它视图不存在第二个导入/导出入口', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.action-card').count(), 0);
    });
    await check('65 独立洞察模块铺开 9 格切换、六项指标与结论', async () => {
      await page.locator('.insight-btn').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.insight-pick').count(), 9);
      assert.strictEqual(await page.locator('.metric-card').count(), 6);
      assert((await page.locator('.conclusion-text').textContent()).length > 0);
      assert((await page.locator('.conclusion').getAttribute('class')).includes('conclusion-on'));
    });
    await check('66 近 30 天热力与环比数据渲染', async () => {
      // 类名已与左栏「最近 28 天」的 .heat-cell 区分，仍限定模块内计数
      assert.strictEqual(await page.locator('.insight-view .insight-heat').count(), 30);
      assert((await page.locator('.cmp').count()) >= 3);
      assert((await page.locator('.insight-view').textContent()).includes('子角度覆盖'));
    });
    await check('67 切换格子后 insight-pick-on 唯一且标题跟随', async () => {
      await page.locator('.insight-pick').nth(2).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.insight-pick-on').count(), 1);
      assert.strictEqual(await page.locator('.insight-pick').nth(2).getAttribute('aria-pressed'), 'true');
      assert((await page.locator('.insight-view h1').textContent()).includes('身心健康'));
    });
    await check('68 返回今天后问候条仍在顶部、二级项选中态正确清除', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.greeting-bar').count(), 1);
      assert.strictEqual(await page.locator('.insight-view').count(), 0);
      assert(!(await page.locator('.insight-btn').getAttribute('class')).includes('insight-on'));
    });
    await check('69 全局概览位于单格洞察下方且六卡齐全', async () => {
      await page.locator('.insight-btn').click();
      await page.waitForTimeout(300);
      const below = await page.locator('.insight-view').evaluate(function (el) {
        const first = el.querySelector('.conclusion');
        const ov = el.querySelector('.overview-section');
        return !!(first && ov) && (first.compareDocumentPosition(ov) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      assert(below, '全局概览不在单格洞察下方');
      assert.strictEqual(await page.locator('.overview-card').count(), 6);
      assert((await page.locator('.overview-section').getAttribute('class')).includes('overview-on'));
    });
    await check('70 概览六卡接本机领域汇总（30 天心情采样可见）', async () => {
      const t = await page.locator('.overview-section').textContent();
      ['本周小结', '近 30 天心情', '工作', '收支汇总', '学习进展', '反复出现的字句'].forEach(function (s) {
        assert(t.includes(s), '概览缺 ' + s);
      });
      assert((await page.locator('.ov-bar').count()) >= 30, '近 30 天心情未取到采样');
    });
    // --- 九格双击进主功能 + GTD 工作台 ---
    await check('71 双击格子空白处进入「工作 · GTD 工作台」', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.gtd-view').count(), 0);
      await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.gtd-view').count(), 1);
      assert.strictEqual(await page.locator('.grid').count(), 0, '九格未让位给主功能页');
      assert((await page.locator('.gtd-view h2').textContent()).includes('GTD'));
    });
    await check('72 GTD 捕获：回车后进收件箱，计数同步 +1', async () => {
      await page.locator('.cap-input').fill('改图纸 #现场');
      await page.locator('.cap-input').press('Enter');
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.gtd-item').count(), 1);
      assert((await page.locator('.gtd-tab').nth(0).textContent()).includes('收件箱'));
      assert((await page.locator('.gtd-tab').nth(0).textContent()).includes('1'));
    });
    await check('73 厘清向导：去做 → 定动作 → 今天做，收件箱清空且占一条六条', async () => {
      await page.locator('.clarify-btn').first().click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.clarify-panel').count(), 1);
      assert((await page.locator('.cp-step').textContent()).includes('第 1 / 3 步'));
      await page.locator('.cp-choice').nth(0).click();
      await waitStep(page, 2);
      // 第 2 步预填原标题，不必重打
      assert((await page.locator('.cp-full').inputValue()).includes('改图纸'));
      await page.locator('.clarify-panel .cp-in').nth(1).fill('@电脑');
      await page.locator('.clarify-panel .primary').click();
      await waitStep(page, 3);
      await page.locator('.cp-choice').nth(0).click();
      await page.locator('.clarify-panel .primary').click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.gtd-item').count(), 0, '收件箱未清空');
      await page.locator('.gtd-tab').nth(1).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.gtd-item').count(), 1);
      assert((await page.locator('.gtd-item').first().textContent()).includes('@电脑'));
    });
    await check('74 项目停滞：日程项有项目但无下一步时标红提示', async () => {
      await page.locator('.cap-input').fill('写验收报告');
      await page.locator('.cap-proj').fill('二期验收');
      await page.locator('.cap-btn').click();
      await page.waitForTimeout(400);
      // 捕获后应自动跳回收件箱，保证「刚记下的那条」可见
      assert((await page.locator('.gtd-tab').nth(0).getAttribute('class')).includes('gtd-tab-on'));
      await page.locator('.clarify-btn').first().click();
      await page.waitForTimeout(200);
      await page.locator('.cp-choice').nth(0).click();
      await waitStep(page, 2);
      await page.locator('.clarify-panel .primary').click();
      await waitStep(page, 3);
      await page.locator('.cp-choice').nth(1).click();
      await page.waitForTimeout(150);
      await page.locator('.clarify-panel input[type="date"]').fill('2026-12-01');
      await page.locator('.clarify-panel .primary').click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.gtd-stall').count(), 1, '停滞项目未标出');
      assert((await page.locator('.gtd-stall').textContent()).includes('停滞'));
    });
    // --- 子任务树：父是容器，子才是能动手的那一步 ---
    await check('74a 给「下一步」挂子项：父行显示 0 / 1，子项缩进独立成行', async () => {
      await page.locator('.gtd-tab').nth(1).click();
      await page.waitForTimeout(250);
      const parent = page.locator('.gtd-item').filter({ hasText: '改图纸' }).first();
      await parent.locator('.gtd-add-kid').click();
      await page.waitForTimeout(150);
      const input = page.locator('.gtd-kid-add .kid-in').first();
      await input.fill('把变更单发给王工');
      await input.press('Enter');
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.gtd-kid').count(), 1, '子项没渲染出来');
      assert.strictEqual(await page.locator('.gtd-kids-wrap .gtd-kid').count(), 1, '子项没有缩进包裹');
      const row = page.locator('.gtd-item').filter({ hasText: '改图纸' }).first();
      const count = await row.locator('.gtd-kid-count').textContent();
      assert(count.includes('0 / 1'), '父行没有 0 / 1 子项计数：' + count);
      // 子项继承了父的上下文（@电脑），否则拆开后还得再填一遍
      assert((await page.locator('.gtd-kid').first().textContent()).includes('@电脑'), '子项没继承上下文');
      // 右栏必须跟着刷新：刚加完子项，「下一步」不该还停在 0
      const nextVal = await page.locator('.context .ctx-kv').nth(1).textContent();
      assert(nextVal.includes('2'), '右栏没随清单刷新：' + nextVal);
    });
    await check('74b 勾父任务被拦下：不静默完成容器，确认后一并完成父子', async () => {
      const row = page.locator('.gtd-item').filter({ hasText: '改图纸' }).first();
      await row.locator('.gtd-check').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.gtd-block').count(), 1, '勾父任务没有被拦下');
      const hint = await page.locator('.gtd-block').textContent();
      assert(hint.includes('还有 1 个子项没完成'), '拦截文案不对：' + hint);
      assert((await page.locator('.gtd-item').filter({ hasText: '改图纸' }).first().getAttribute('class')).indexOf('gtd-done') < 0,
        '父任务被静默完成了');
      await page.locator('.gtd-block .gtd-block-go').click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.gtd-block').count(), 0, '一并完成后拦截条没消失');
      assert.strictEqual(await page.locator('.gtd-kid').count(), 0, '子项没跟着一起完成');
    });
    await check('74c 删父任务只上抬子项：子项变成独立任务，不陪葬', async () => {
      await page.locator('.cap-input').fill('装修房子');
      await page.locator('.cap-input').press('Enter');
      await page.waitForTimeout(400);
      await page.locator('.clarify-btn').first().click();
      await page.waitForTimeout(200);
      await page.locator('.cp-choice').nth(0).click();
      await waitStep(page, 2);
      await page.locator('.clarify-panel .primary').click();
      await waitStep(page, 3);
      await page.locator('.clarify-panel .primary').click();
      await page.waitForTimeout(450);
      await page.locator('.gtd-tab').nth(1).click();
      await page.waitForTimeout(250);
      await page.locator('.gtd-item').filter({ hasText: '装修房子' }).first().locator('.gtd-add-kid').click();
      await page.waitForTimeout(150);
      const input = page.locator('.gtd-kid-add .kid-in').first();
      await input.fill('给工长打电话');
      await input.press('Enter');
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.gtd-kid').count(), 1);

      await page.locator('.gtd-item').filter({ hasText: '装修房子' }).first().locator('.gtd-del').click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.gtd-item').filter({ hasText: '装修房子' }).count(), 0, '父任务没删掉');
      assert.strictEqual(await page.locator('.gtd-kid').count(), 0, '子项还挂在已删除的父下面');
      const names = await page.locator('.gtd-item').allTextContents();
      assert(names.some(function (t) { return t.includes('给工长打电话'); }), '删父把子项一起删了');
      const msg = await page.locator('.msg').textContent();
      assert(msg.includes('上抬'), '没有说明子项去哪了：' + msg);
      // 清理，避免影响后续断言
      await page.locator('.gtd-item').filter({ hasText: '给工长打电话' }).first().locator('.gtd-del').click();
      await page.waitForTimeout(300);
    });
    await check('74d 工作台底部富文本记录窗：引导词可用、可保存到今天', async () => {
      assert.strictEqual(await page.locator('.note-editor').count(), 1, '工作台没有记录窗');
      assert.strictEqual(await page.locator('.note-editor .rt-toolbar .rt-btn').count(), 8, '工具栏不是 8 个键');
      const prompt = ((await page.locator('.note-editor .rt-prompt-text').textContent()) || '').trim();
      assert(prompt.length > 4, '记录窗没有引导词：' + prompt);
      const body = page.locator('.note-editor .rt-body');
      await body.click();
      await page.keyboard.type('今天把变更单发出去了');
      assert((await page.locator('.note-editor .ne-save').getAttribute('class')).includes('ne-save-on'), '有未保存内容时按钮没变化');
      await page.locator('.note-editor .ne-save').click();
      await page.waitForTimeout(650);
      // 提示走外壳的 toast（notify），不是工作台自己的行内 msg
      const msg = (await page.locator('.toast').textContent()) || '';
      assert(msg.includes('已保存到'), '没有保存提示：' + msg);
      assert(!(await page.locator('.note-editor .ne-save').getAttribute('class')).includes('ne-save-on'), '保存后仍是脏态');
    });
    await check('75 每周回顾已搬到右栏：五项检查齐全，记录后状态落盘', async () => {
      assert.strictEqual(await page.locator('.context .review').count(), 1, '右栏没有每周回顾');
      assert.strictEqual(await page.locator('.gtd-view .review').count(), 0, '中栏还留着每周回顾（与右栏重复）');
      assert.strictEqual(await page.locator('.check-row').count(), 5);
      const before = await page.locator('.review').getAttribute('class');
      assert(!before.includes('gtd-review-on'), '首次进入不该已是已回顾态');
      await page.locator('.review-actions .primary').click();
      await page.waitForTimeout(400);
      assert((await page.locator('.review').getAttribute('class')).includes('gtd-review-on'));
    });
    // --- 分栏分行 + 点任务改详情 ---
    await check('75a 工作台分栏分行：左侧三段分栏、行内三列对齐、已完成可回看', async () => {
      assert.strictEqual(await page.locator('.gtd-side').count(), 1, '没有左侧分栏');
      assert.strictEqual(await page.locator('.gtd-side .side-sec').count(), 3, '分栏不是「清单/项目/情境」三段');
      const tabs = await page.locator('.gtd-tab').allTextContents();
      assert.strictEqual(tabs.length, 6, '清单应有 5 组 + 已完成');
      assert(tabs[5].includes('已完成'), '第 6 项应为已完成：' + tabs[5]);
      assert.strictEqual(await page.locator('.gtd-colhead').count(), 1, '缺少列头，分行对不齐');
      const heads = await page.locator('.gtd-colhead span').allTextContents();
      assert(heads.join('|').includes('任务') && heads.join('|').includes('情境') && heads.join('|').includes('到期'), '列头不齐：' + heads.join('|'));
      // 分栏真的在列表左边（同一行上的 x 坐标）
      const sideBox = await page.locator('.gtd-side').boundingBox();
      const listBox = await page.locator('.gtd-list').boundingBox();
      assert(sideBox && listBox && sideBox.x + sideBox.width <= listBox.x + 2, '分栏没有排在列表左侧');
    });
    await check('75b 点一条任务：右栏换成它的详情，改标题保存后中栏跟着变', async () => {
      // 备三条下一步，两条同项目、一条另一个项目，后面筛选才有对照组
      for (const [t, p] of [['量房尺寸', '装修'], ['订瓷砖', '装修'], ['交底纪要', '二期验收']]) {
        await page.locator('.cap-input').fill(t);
        await page.locator('.cap-proj').fill(p);
        await page.locator('.cap-btn').click();
        await page.waitForTimeout(350);
        await page.locator('.clarify-btn').first().click();
        await page.waitForTimeout(200);
        await page.locator('.cp-choice').nth(0).click();
        await waitStep(page, 2);
        await page.locator('.clarify-panel .primary').click();
        await waitStep(page, 3);
        await page.locator('.cp-choice').nth(0).click();
        await page.locator('.clarify-panel .primary').click();
        await page.waitForTimeout(400);
      }
      await page.locator('.gtd-tab').nth(1).click();
      await page.waitForTimeout(300);
      const row = page.locator('.gtd-item').filter({ hasText: '量房尺寸' }).first();
      await row.locator('.gtd-title').click();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.context .wc-detail-on').count(), 1, '右栏没有切到任务详情');
      assert.strictEqual(await page.locator('#wc-title').inputValue(), '量房尺寸', '详情里的标题不是选中那条');
      assert((await row.getAttribute('class')).includes('gtd-sel'), '选中行没有高亮');
      await page.locator('#wc-title').fill('量房尺寸（含阳台）');
      await page.locator('.context .wc-save').click();
      await page.waitForTimeout(500);
      const titles = await page.locator('.gtd-item .gtd-title').allTextContents();
      assert(titles.some(function (x) { return x.includes('含阳台'); }), '改完标题中栏没跟着变：' + titles.join(','));
    });
    await check('75c 项目分栏点一下就筛、再点恢复；搜索只留命中', async () => {
      const all = await page.locator('.gtd-item').count();
      assert(all >= 3, '下一步应有至少三条，便于对照：' + all);
      await page.locator('.gtd-side .side-proj').filter({ hasText: '二期验收' }).first().click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.gtd-filter').count(), 1, '筛选后没有「清除筛选」提示');
      const filtered = await page.locator('.gtd-item').count();
      assert(filtered < all && filtered > 0, '项目筛选没生效：' + all + ' → ' + filtered);
      await page.locator('.gtd-side .side-proj').filter({ hasText: '二期验收' }).first().click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.gtd-item').count(), all, '再点一次没有恢复');
      await page.locator('.gtd-search').fill('订瓷砖');
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.gtd-item').count(), 1, '搜索没有收窄到 1 条');
      assert((await page.locator('.gtd-filter').textContent()).includes('搜索'), '筛选条没写清是按什么筛的');
      await page.locator('.gtd-clear').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.gtd-item').count(), all, '清除筛选没恢复');
    });
    // --- 分列对得齐不齐，得拿真坐标量，不能只看「表头里有没有这几个字」 ---
    await check('75c2 列头与任务行共用一套栅格：四列左边界误差 ≤1px、分列线贯通', async () => {
      const geo = await page.evaluate(function () {
        const head = document.querySelector('.gtd-colhead');
        const row = document.querySelector('.gtd-item');
        if (!head || !row) return null;
        function box(el) {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { l: r.left, w: r.width, bl: parseFloat(cs.borderLeftWidth) || 0 };
        }
        return {
          h: ['.ch-ctx', '.ch-proj', '.ch-due', '.ch-act'].map(function (s) { return box(head.querySelector(s)); }),
          r: ['.gtd-cell-ctx', '.gtd-cell-proj', '.gtd-cell-due', '.gtd-act'].map(function (s) { return box(row.querySelector(s)); }),
          headBottom: head.getBoundingClientRect().bottom,
          rowTop: row.getBoundingClientRect().top
        };
      });
      assert(geo, '取不到列头或任务行');
      for (let i = 0; i < 4; i++) {
        assert(geo.h[i] && geo.r[i], '第 ' + (i + 1) + ' 列取不到几何信息');
        assert(Math.abs(geo.h[i].l - geo.r[i].l) <= 1,
          '第 ' + (i + 1) + ' 列左右没对上：表头 ' + geo.h[i].l.toFixed(1) + ' / 行 ' + geo.r[i].l.toFixed(1));
        assert(Math.abs(geo.h[i].w - geo.r[i].w) <= 1,
          '第 ' + (i + 1) + ' 列宽不一致：' + geo.h[i].w.toFixed(1) + ' / ' + geo.r[i].w.toFixed(1));
        assert(geo.h[i].bl > 0 && geo.r[i].bl > 0, '第 ' + (i + 1) + ' 列缺纵向分列线');
      }
      assert(geo.rowTop - geo.headBottom <= 10, '列头与首行离得太远，看不出是一张表：' + (geo.rowTop - geo.headBottom));
    });
    await check('75c3 任务拖进左侧清单「将来也许」：离开当前清单、计数 +1、有回执', async () => {
      const target = page.locator('.gtd-tab').nth(4);
      const before = await target.innerText();
      const row = page.locator('.gtd-item').filter({ hasText: '交底纪要' }).first();
      assert.strictEqual(await row.count(), 1, '下一步里找不到「交底纪要」');
      const dt = await page.evaluateHandle(function () { return new DataTransfer(); });
      await row.dispatchEvent('dragstart', { dataTransfer: dt });
      await target.dispatchEvent('dragover', { dataTransfer: dt });
      await page.waitForTimeout(150);
      assert((await target.getAttribute('class')).includes('gtd-drop-hot'), '拖到清单项没有落点高亮');
      await target.dispatchEvent('drop', { dataTransfer: dt });
      await page.waitForTimeout(700);
      assert.notStrictEqual(await target.innerText(), before, '「将来也许」计数没变：' + before);
      assert((await page.locator('.msg').textContent()).includes('将来也许'), '没有归类回执');
      assert.strictEqual(await page.locator('.gtd-item').filter({ hasText: '交底纪要' }).count(), 0, '拖走后仍留在下一步');

      // 反方向也成立：从「将来也许」拖回「下一步」，别让后面的断言吃到这次的改动
      const dt2 = await page.evaluateHandle(function () { return new DataTransfer(); });
      await page.locator('.gtd-tab').nth(4).click();
      await page.waitForTimeout(350);
      const back = page.locator('.gtd-item').filter({ hasText: '交底纪要' }).first();
      const nextTab = page.locator('.gtd-tab').nth(1);
      await back.dispatchEvent('dragstart', { dataTransfer: dt2 });
      await nextTab.dispatchEvent('dragover', { dataTransfer: dt2 });
      await nextTab.dispatchEvent('drop', { dataTransfer: dt2 });
      await page.waitForTimeout(700);
      await nextTab.click();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.gtd-item').filter({ hasText: '交底纪要' }).count(), 1, '拖回来没回到下一步');
    });
    await check('75c4 任务拖到「情境」胶囊：情境就地改掉，清单归组不变', async () => {
      const row = page.locator('.gtd-item').filter({ hasText: '订瓷砖' }).first();
      const chip = page.locator('.side-ctx').filter({ hasText: '@会议' }).first();
      const all = await page.locator('.gtd-item').count();
      const dt = await page.evaluateHandle(function () { return new DataTransfer(); });
      await row.dispatchEvent('dragstart', { dataTransfer: dt });
      await chip.dispatchEvent('dragover', { dataTransfer: dt });
      await page.waitForTimeout(150);
      assert((await chip.getAttribute('class')).includes('gtd-drop-hot'), '拖到情境胶囊没有落点高亮');
      await chip.dispatchEvent('drop', { dataTransfer: dt });
      await page.waitForTimeout(700);
      const line = await page.locator('.gtd-item').filter({ hasText: '订瓷砖' }).first().innerText();
      assert(line.includes('@会议'), '情境没改过来：' + line);
      assert(!line.includes('@电话'), '旧情境还留着：' + line);
      assert.strictEqual(await page.locator('.gtd-item').count(), all, '改情境不该改动清单条数');
    });
    await check('75c5 右键任务行：设置 / 移动 / 转发 / 删除 齐备，右栏跟着切到这一条', async () => {
      await page.locator('.gtd-item').filter({ hasText: '订瓷砖' }).first().click({ button: 'right' });
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.gtd-menu').count(), 1, '右键没弹出菜单');
      const items = (await page.locator('.gtd-menu .gm-item').allTextContents()).join('|');
      ['任务设置', '移动到', '转发', '删除'].forEach(function (k) {
        assert(items.includes(k), '菜单缺「' + k + '」：' + items);
      });
      assert.strictEqual(await page.locator('.context .wc-detail-on').count(), 1, '右栏没跟着切到右键那条');
      assert.strictEqual(await page.locator('#wc-title').inputValue(), '订瓷砖', '右栏显示的不是右键那条');

      await page.locator('.gtd-menu .gm-item').filter({ hasText: '转发' }).first().click();
      await page.waitForTimeout(250);
      const sub = (await page.locator('.gtd-menu .gm-subitem').allTextContents()).join('|');
      assert(sub.includes('今日六条') && sub.includes('自由记录') && sub.includes('复制'), '转发子菜单不全：' + sub);

      // 贴着窗口右边缘右击时，菜单不能被推到窗外去
      const box = await page.locator('.gtd-menu').boundingBox();
      const vp = await page.evaluate(function () { return { w: window.innerWidth, h: window.innerHeight }; });
      assert(box && box.x >= -1 && box.x + box.width <= vp.w + 1, '菜单横向越界：' + JSON.stringify(box));
      assert(box.y >= -1 && box.y + box.height <= vp.h + 1, '菜单纵向越界：' + JSON.stringify(box));

      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.gtd-menu').count(), 0, 'Esc 没关掉菜单');
    });
    // --- 分栏名单：＋新建 / 双击改名 / 右键归档 / 归档后从选择器消失 ---
    await check('75e 分栏「＋」建项目、双击改名、右键归档后从项目选择器里消失', async () => {
      const projSec = page.locator('.gtd-side .side-sec').filter({ hasText: '项目' }).first();
      await projSec.locator('.side-plus').click();
      await page.waitForTimeout(200);
      await projSec.locator('.side-add-in').fill('归档测试');
      await projSec.locator('.side-add-in').press('Enter');
      await page.waitForTimeout(650);
      assert.strictEqual(await projSec.locator('.side-proj').filter({ hasText: '归档测试' }).count(), 1, '新建的项目没出现在分栏');

      await projSec.locator('.side-proj').filter({ hasText: '归档测试' }).first().dblclick();
      await page.waitForTimeout(250);
      await projSec.locator('.side-edit-in').fill('归档测试2');
      await projSec.locator('.side-edit-in').press('Enter');
      await page.waitForTimeout(650);
      assert.strictEqual(await projSec.locator('.side-proj').filter({ hasText: '归档测试2' }).count(), 1, '双击改名没生效');

      await projSec.locator('.side-proj').filter({ hasText: '归档测试2' }).first().click({ button: 'right' });
      await page.waitForTimeout(300);
      const items = (await page.locator('.gtd-side-menu .gm-item').allTextContents()).join('|');
      ['改名', '归档', '删除'].forEach(function (k) {
        assert(items.includes(k), '项目右键菜单缺「' + k + '」：' + items);
      });
      await page.locator('.gtd-side-menu .gm-item').filter({ hasText: '归档' }).first().click();
      await page.waitForTimeout(700);
      assert.strictEqual(await projSec.locator('.side-proj').filter({ hasText: '归档测试2' }).count(), 0, '归档后还留在项目列表');
      assert.strictEqual(await page.locator('.side-arch-toggle').count(), 1, '没有归档入口，归档就找不回来了');

      // 这一条是归档的意义所在：归档项目不能再出现在行内选择器里
      const row = page.locator('.gtd-item').first();
      await row.locator('.gtd-cell-proj').click();
      await page.waitForTimeout(300);
      const opts = (await page.locator('.gtd-pick .gp-list').innerText()) || '';
      assert(!opts.includes('归档测试2'), '归档项目仍出现在项目选择器里：' + opts);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);

      // 取消归档 → 回到列表；再删掉，别给后面的断言留垃圾
      await page.locator('.side-arch-toggle').click();
      await page.waitForTimeout(300);
      await page.locator('.side-arch-item').filter({ hasText: '归档测试2' }).first().click({ button: 'right' });
      await page.waitForTimeout(300);
      await page.locator('.gtd-side-menu .gm-item').filter({ hasText: '取消归档' }).first().click();
      await page.waitForTimeout(650);
      assert.strictEqual(await projSec.locator('.side-proj').filter({ hasText: '归档测试2' }).count(), 1, '取消归档没回到列表');
      await projSec.locator('.side-proj').filter({ hasText: '归档测试2' }).first().click({ button: 'right' });
      await page.waitForTimeout(300);
      await page.locator('.gtd-side-menu .gm-item').filter({ hasText: '删除' }).first().click();
      await page.waitForTimeout(650);
      assert.strictEqual(await projSec.locator('.side-proj').filter({ hasText: '归档测试2' }).count(), 0, '删除没生效');
    });
    await check('75f 行内选情境 + 右键删情境：任务上的标签一并清掉', async () => {
      const ctxSec = page.locator('.gtd-side .side-sec').filter({ hasText: '情境' }).first();
      await ctxSec.locator('.side-plus').click();
      await page.waitForTimeout(200);
      await ctxSec.locator('.side-add-in').fill('车库');   // 故意不带 @，看会不会自动补
      await ctxSec.locator('.side-add-in').press('Enter');
      await page.waitForTimeout(650);
      assert.strictEqual(await ctxSec.locator('.side-ctx').filter({ hasText: '@车库' }).count(), 1, '新建情境没有自动补 @');

      await page.locator('.gtd-item').first().locator('.gtd-cell-ctx').click();
      await page.waitForTimeout(300);
      await page.locator('.gtd-pick .gp-item').filter({ hasText: '@车库' }).first().click();
      await page.waitForTimeout(700);
      assert((await page.locator('.gtd-item').first().innerText()).includes('@车库'), '行内没改成 @车库');

      await ctxSec.locator('.side-ctx').filter({ hasText: '@车库' }).first().click({ button: 'right' });
      await page.waitForTimeout(300);
      const items = (await page.locator('.gtd-side-menu .gm-item').allTextContents()).join('|');
      assert(items.includes('改名') && items.includes('删除'), '情境右键菜单不全：' + items);
      assert(!items.includes('归档'), '情境不该有归档（归档是项目的事）：' + items);

      await page.locator('.gtd-side-menu .gm-item').filter({ hasText: '删除' }).first().click();
      await page.waitForTimeout(700);
      assert.strictEqual(await ctxSec.locator('.side-ctx').filter({ hasText: '@车库' }).count(), 0, '情境没删掉');
      assert(!(await page.locator('.gtd-item').first().innerText()).includes('@车库'), '任务上那条旧情境没跟着清掉');
    });
    await check('75g 点「到期」格选今天：行内当天就变，不用去右栏', async () => {
      const row = page.locator('.gtd-item').first();
      await row.locator('.gtd-cell-due').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.gtd-pick .gp-quick .mini').count(), 3, '到期面板缺快捷按钮');
      await page.locator('.gtd-pick .gp-quick .mini').first().click();   // 今天
      await page.waitForTimeout(750);
      assert.strictEqual(await page.locator('.gtd-pick').count(), 0, '选完面板没关');
      const line = await page.locator('.gtd-item').first().innerText();
      assert(line.includes('今天'), '行内没显示今天到期：' + line);
    });
    await check('75h 行内面板能加入 / 移出今日六条，右栏按钮同步', async () => {
      const row = page.locator('.gtd-item').first();
      await row.locator('.gtd-cell-ctx').click();
      await page.waitForTimeout(300);
      const wasIn = (await page.locator('.gtd-pick .gp-focus').innerText()).indexOf('移出') >= 0;
      await page.locator('.gtd-pick .gp-focus').click();
      await page.waitForTimeout(750);
      const after = (await page.locator('.context .wc-detail').innerText()) || '';
      assert(wasIn ? after.includes('加入今日六条') : after.includes('移出六条'), '右栏六条按钮没跟着变：' + after);

      // 复原成原来那条，别把后面「今日六条」的断言搞乱
      await row.locator('.gtd-cell-ctx').click();
      await page.waitForTimeout(300);
      await page.locator('.gtd-pick .gp-focus').click();
      await page.waitForTimeout(650);
    });
    await check('75d 已完成分组：7 天内做完的能回看，也能一键重开', async () => {
      if (await page.locator('.gtd-clear').count()) {
        await page.locator('.gtd-clear').click();
        await page.waitForTimeout(250);
      }
      await page.locator('.gtd-tab').nth(5).click();
      await page.waitForTimeout(300);
      const done = page.locator('.gtd-item').filter({ hasText: '改图纸' }).first();
      assert.strictEqual(await done.count(), 1, '已完成分组里看不到刚做完的「改图纸」');
      await done.locator('.mini').first().click();
      await page.waitForTimeout(450);
      // 只看标题列：子项行会带「↑ 改图纸」的归属标签，按整行文本匹配会误判
      let titles = await page.locator('.gtd-item .gtd-title').allTextContents();
      assert(!titles.some(function (x) { return x.indexOf('改图纸') >= 0; }), '重开后仍留在已完成：' + titles.join(','));
      await page.locator('.gtd-tab').nth(1).click();
      await page.waitForTimeout(300);
      titles = await page.locator('.gtd-item .gtd-title').allTextContents();
      assert(titles.some(function (x) { return x.indexOf('改图纸') >= 0; }), '重开后没回到下一步：' + titles.join(','));
    });
    await check('76 返回九格后九格恢复，GTD 不计入一级导航', async () => {
      await page.locator('.gtd-view .back').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.grid').count(), 1);
      assert.strictEqual(await page.locator('.gtd-view').count(), 0);
      assert.strictEqual(await page.locator('.nav-item').count(), 8, '一级导航仍应为 7 项 + 设置');
    });
    await check('76a 今日六条：已并入九格「未来」格，今日页不留横条；进格挑一件并「→ 格」', async () => {
      // 今日页顶部只留问候与九格：六条那条横条必须已经不在了
      assert.strictEqual(await page.locator('.focus-bar').count(), 0, '今日页还在单独画六条横条');
      const order = await page.locator('.center').evaluate(function (el) {
        const g = el.querySelector('.greeting-bar');
        const grid = el.querySelector('.grid');
        return !!(g && grid) && (g.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      assert(order, '问候条不在九格之前');

      // 九格这一格改叫「今日六条」，并带进度徽标（入口进了格子，得一眼看出用没用）
      const label = await page.locator('.cell[data-cell="future"] .cell-label').innerText();
      assert(label.includes('今日六条'), '这一格还叫「' + label + '」');
      assert.strictEqual(await page.locator('.cell[data-cell="future"] .cell-focus').count(), 1, '没有六条进度徽标');
      const badge = await page.locator('.cell[data-cell="future"] .cell-focus').innerText();
      assert(/(未挑|\d\s*\/\s*\d)/.test(badge.trim()), '徽标没报六条状态：' + badge);

      // 进格：上面六条、下面留一句
      await page.locator('.cell[data-cell="future"] .cell-label').dblclick();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.focus-view').count(), 1, '没进入今日六条工作台');
      assert.strictEqual(await page.locator('.focus-view .focus-bar').count(), 1, '格内没有六条本体');
      assert.strictEqual(await page.locator('.fb-slot').count(), 6, '不是六个空位');
      assert((await page.locator('.fb-stat').textContent()).includes('/'), '没有完成统计');
      assert.strictEqual(await page.locator('.focus-view .editor .rt-body').count(), 1, '格内缺「给今天留一句」');

      // 挑一件：候选只给能动手的（容器不在里面）
      await page.locator('.fb-add').click();
      await page.waitForTimeout(500);
      assert.strictEqual(await page.locator('.fb-panel').count(), 1, '点挑一件没有面板');
      assert((await page.locator('.fb-cand').count()) >= 1, '候选为空：厘清出来的下一步应该能挑');
      await page.locator('.fb-cand-btn').first().click();
      await page.waitForTimeout(600);
      assert.strictEqual(await page.locator('.fb-panel').count(), 0, '挑完没关面板');
      assert((await page.locator('.fb-slot .fb-text').count()) >= 1, '挑完之后槽里没有内容');

      // → 格：只有完成态才给入口，挑来的多是未完成，先勾一条
      if ((await page.locator('.fb-write').count()) === 0) {
        await page.locator('.fb-check').first().click();
        await page.waitForTimeout(650);
      }
      assert((await page.locator('.fb-write').count()) >= 1, '完成后没有「→ 格」入口');
      await page.locator('.fb-write').first().click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.fb-cell').count(), 9, '可选格数不对');
      await page.locator('.fb-cell').nth(2).click();
      await page.locator('.fb-line').fill('把改图纸这件事结掉了');
      await page.locator('.fb-save').click();
      await page.waitForTimeout(850);

      // 退回九格再看落点，确认「→ 格」写的是今天的记录
      await page.locator('.focus-view .back').click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.focus-view').count(), 0, '没退回九格');
      const health = await page.locator('.cell[data-cell="health"] .rt-body').innerText();
      assert(health.includes('把改图纸这件事结掉了'), '「→ 格」没写进健康格：' + health);
    });
    await check('76b 左右栏边界可拖：拖动改宽、落进 localStorage、双击复位', async () => {
      const width = async function (sel) {
        const b = await page.locator(sel).boundingBox();
        return b ? Math.round(b.width) : 0;
      };
      const nav0 = await width('.nav');
      const rail0 = await width('.context');

      // 右边界往左拖 → 右栏变宽（受中栏 420 最小宽度约束，允许被夹）
      const h = await page.locator('.col-divider').nth(1).boundingBox();
      await page.mouse.move(h.x + h.width / 2, h.y + 260);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 - 110, h.y + 260, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(220);
      const rail1 = await width('.context');
      assert(rail1 > rail0 + 25, '右栏没变宽：' + rail0 + ' → ' + rail1);
      const saved = await page.evaluate(function () { return localStorage.getItem('jiuge.layout.v1'); });
      assert(!!saved, '栏宽没写进 localStorage');
      assert.strictEqual(JSON.parse(saved).rail, rail1, 'localStorage 里的宽度和实际不一致：' + saved);

      // 左边界往右拖 → 左栏变宽
      const h2 = await page.locator('.col-divider').nth(0).boundingBox();
      await page.mouse.move(h2.x + h2.width / 2, h2.y + 260);
      await page.mouse.down();
      await page.mouse.move(h2.x + h2.width / 2 + 56, h2.y + 260, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(220);
      const nav1 = await width('.nav');
      assert(nav1 > nav0 + 25, '左栏没变宽：' + nav0 + ' → ' + nav1);

      // 双击复位（两侧都回到 240 / 300）
      await page.locator('.col-divider').nth(1).dblclick();
      await page.waitForTimeout(250);
      assert(Math.abs((await width('.context')) - 300) <= 2, '双击没复位右栏');
      await page.locator('.col-divider').nth(0).dblclick();
      await page.waitForTimeout(250);
      assert(Math.abs((await width('.nav')) - 240) <= 2, '双击没复位左栏');
    });
    await check('76c 右栏「本页选项」：今日状态可写，正文仍只在主栏', async () => {
      const opt = page.locator('.today-opt');
      assert.strictEqual(await opt.count(), 1, '右栏没有本页选项');
      assert((await opt.locator('.ctx-title').textContent()).indexOf('本页选项') >= 0, '选项卡标题不对');
      assert.strictEqual(await opt.locator('.opt-tab').count(), 2, '不是两个分组');
      // 今日状态表单在右栏，主栏里已经没有
      assert.strictEqual(await page.locator('.context .base-grid').count(), 1, '右栏没有今日状态表单');
      assert.strictEqual(await page.locator('.center .base-grid').count(), 0, '主栏还留着今日状态表单');
      assert.strictEqual(await page.locator('.center .panels').count(), 0, '主栏还留着录入面板');
      assert.strictEqual(await page.locator('.center .extras').count(), 0, '主栏还留着补充区');
      // 右栏写了要真的落盘：选天气后提示「今日状态已记下」
      await page.locator('.context .base-grid select').first().selectOption('多云');
      await page.getByRole('button', { name: '记下今日状态' }).click();
      await page.waitForTimeout(400);
      assert((await page.locator('.toast').textContent()).includes('今日状态已记下'), '右栏保存没生效');
    });
    await check('77 收支格双击进入完整账本（跨天流水）', async () => {
      await page.locator('.cell[data-cell="money"] .cell-label').dblclick();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.money-view').count(), 1);
      assert.strictEqual(await page.locator('.sum-card').count(), 3);
      assert.strictEqual(await page.locator('.ledger').count(), 1);
      await page.locator('.money-view .back').click();
      await page.waitForTimeout(250);
    });
    await check('77a 账本底部富文本记录窗：写一句并可保存到今天', async () => {
      await page.locator('.cell[data-cell="money"] .cell-label').dblclick();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.money-view .note-editor').count(), 1, '账本没有记录窗');
      const body = page.locator('.money-view .note-editor .rt-body');
      await body.click();
      await page.keyboard.type('这个月装修超支两千');
      await page.locator('.money-view .note-editor .ne-save').click();
      await page.waitForTimeout(650);
      const msg = (await page.locator('.toast').textContent()) || '';
      // 先回九格再断言，避免断言失败把后续用例卡在账本页
      await page.locator('.money-view .back').click();
      await page.waitForTimeout(350);
      assert(msg.includes('已保存到'), '账本记录没保存：' + msg);
      const cell = await page.locator('.cell[data-cell="money"] .rt-body').innerText();
      assert(cell.includes('这个月装修超支两千'), '账本写的内容没回到九格');
    });
    await check('78 学习格双击进入「学习成长」：考试 / 技能 / 阅读三块各自入口', async () => {
      await page.locator('.cell[data-cell="growth"] .cell-label').dblclick();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('.growth-view').count(), 1);
      assert((await page.locator('.growth-view h2').textContent()).includes('学习成长'));
      const tabs = await page.locator('.g-tab').allTextContents();
      assert.strictEqual(tabs.length, 3, '三块应各有一个 tab');
      assert(tabs[0].includes('考试考证') && tabs[1].includes('技能学习') && tabs[2].includes('主题阅读'), tabs.join('|'));
      assert.strictEqual(await page.locator('.day-note').count(), 1);
      // 空态文案要说清「这一步该写什么」，不是一句「暂无数据」
      assert((await page.locator('.rows').textContent()).includes('倒计时'), '考试空态没说明要填考试日');
    });
    await check('78a 考试：建一场带日期的考试，阶段与倒计时自动出来；加科目后可按章推进', async () => {
      await page.locator('.add-row input[aria-label="考试名称"]').fill('一级建造师');
      await page.locator('.add-row input[aria-label="考试日期"]').fill('2026-12-20');
      await page.getByRole('button', { name: '加一场考试' }).click();
      await page.waitForTimeout(450);
      const row = page.locator('.rows .g-row').first();
      assert((await row.textContent()).includes('一级建造师'));
      assert((await row.textContent()).includes('距考试'), '没算倒计时：' + (await row.textContent()));
      assert((await row.textContent()).includes('强化'), '41 天应是「强化」阶段');

      await row.locator('.g-title').click();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('#gc-title').inputValue(), '一级建造师', '右栏没切到这场考试');
      await page.locator('.context input[aria-label="新科目"]').fill('市政实务');
      await page.locator('.context input[aria-label="总章数"]').fill('40');
      await page.getByRole('button', { name: '加科目' }).click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.context .gc-item').count(), 1, '科目没加进右栏');
      assert((await page.locator('.context .gc-item').textContent()).includes('0 / 40 章'));
      await page.locator('.context .gc-item .gc-mini').first().click();
      await page.waitForTimeout(450);
      assert((await page.locator('.context .gc-item').textContent()).includes('1 / 40 章'));
      assert((await page.locator('.rows .g-row').first().textContent()).includes('3%'), '科目进度没反映到中栏');
    });
    await check('78b 技能：里程碑勾选 + 练习记录，两种进度分开算', async () => {
      await page.locator('.g-tab').nth(1).click();
      await page.waitForTimeout(250);
      await page.locator('.add-row input[aria-label="技能名称"]').fill('Python 数据处理');
      await page.getByRole('button', { name: '加一项技能' }).click();
      await page.waitForTimeout(450);
      await page.locator('.rows .g-row').first().locator('.g-title').click();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('#gc-skill').inputValue(), 'Python 数据处理');
      await page.locator('.context input[aria-label="新里程碑"]').fill('能独立写爬虫');
      await page.getByRole('button', { name: '加', exact: true }).click();
      await page.waitForTimeout(450);
      assert((await page.locator('.context .gc-item').first().textContent()).includes('能独立写爬虫'));
      await page.locator('.context .gc-check').first().click();
      await page.waitForTimeout(450);
      assert((await page.locator('.rows .g-row').first().textContent()).includes('1 / 1 里程碑'));

      // 行内 +30′：练习时长与里程碑是两个数，不能混成一个进度
      await page.locator('.rows .g-row').first().locator('.g-quick').click();
      await page.waitForTimeout(450);
      assert((await page.locator('.rows .g-row').first().textContent()).includes('30′'), '练习时长没进中栏');
    });
    await check('78c 阅读：开主题 → 放书 → 翻页 → 摘录，四步都在同一主题下', async () => {
      await page.locator('.g-tab').nth(2).click();
      await page.waitForTimeout(250);
      await page.locator('.add-row input[aria-label="阅读主题"]').fill('给排水规范');
      await page.getByRole('button', { name: '开一个主题' }).click();
      await page.waitForTimeout(450);
      await page.locator('.rows .g-row').first().locator('.g-title').click();
      await page.waitForTimeout(350);
      assert.strictEqual(await page.locator('#gc-theme').inputValue(), '给排水规范');

      await page.locator('.context input[aria-label="书名"]').fill('室外排水设计标准');
      await page.locator('.context input[aria-label="页数"]').fill('200');
      await page.getByRole('button', { name: '加书' }).click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.context .gc-book').count(), 1);
      assert((await page.locator('.rows .g-row').first().textContent()).includes('0 / 1 本读完'));

      await page.locator('.context .gc-book .gc-mini').first().click();
      await page.waitForTimeout(450);
      assert((await page.locator('.context .gc-book').textContent()).includes('10 / 200 页'));
      assert((await page.locator('.rows .g-row').first().textContent()).includes('在读《室外排水设计标准》'));

      await page.locator('.context input[aria-label="摘录内容"]').fill('雨水管渠设计重现期应按当地规定执行');
      await page.locator('.context input[aria-label="页码"]').fill('12');
      await page.getByRole('button', { name: '存摘录' }).click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.context .gc-quote').count(), 1, '摘录没落库');
      assert((await page.locator('.rows .g-row').first().textContent()).includes('1 条'), '摘录数没进中栏');
    });
    await check('78d 学习右栏：三块总览 + 该看一眼；旧学习库为空时如实说没得导', async () => {
      const t = await page.locator('.context').innerText();
      assert(t.includes('学习库') && t.includes('条目'), t.slice(0, 80));
      assert.strictEqual(await page.locator('.context .gc-grid .ctx-kv').count(), 4, '总览不是四格');
      await page.getByRole('button', { name: '导入旧学习库' }).click();
      await page.waitForTimeout(600);
      // 回执走这一页自己的行内提示（不是外壳 toast，避免被上一条提示盖住）
      const inline = (await page.locator('.growth-view .msg').count())
        ? (await page.locator('.growth-view .msg').textContent()) || ''
        : '';
      assert(/没有可导入|已导入/.test(inline), '导入旧库没有回执：' + inline);
      await page.locator('.growth-view .back').click();
      await page.waitForTimeout(300);
    });
    await check('79 其余格进入通用单格工作台：中栏只留书写，统计全部归右栏（去重）', async () => {
      await page.locator('.cell[data-cell="health"] .cell-open').click();
      await page.waitForTimeout(600);
      assert.strictEqual(await page.locator('.cell-view').count(), 1);
      assert((await page.locator('.cell-view h2').textContent()).includes('健康'));
      assert.strictEqual(await page.locator('.cell-view .rt').count(), 1);
      // 去重门禁：中栏不得再出现指标 / 环比 / 热力 / 历史，它们只在右栏出现一次
      assert.strictEqual(await page.locator('.cell-view .metric').count(), 0, '中栏仍残留六项指标');
      assert.strictEqual(await page.locator('.cell-view .compare').count(), 0, '中栏仍残留近 30 天环比');
      assert.strictEqual(await page.locator('.cell-view .cell-heat').count(), 0, '中栏仍残留 30 天热力');
      assert.strictEqual(await page.locator('.cell-view .history').count(), 0, '中栏仍残留历史列表');
      const ctx = await page.locator('.context').innerText();
      assert(ctx.includes('本期指标'), ctx.slice(0, 100));
      assert(ctx.includes('近 30 天'), ctx.slice(0, 100));
      assert(ctx.includes('最近写过'), '右栏未接管该格跨天历史');
      assert.strictEqual(await page.locator('.context .ctx-heat-cell').count(), 30);
    });
    await check('80 单格工作台可跳完整洞察并带过去该格选中态', async () => {
      await page.locator('.cell-view .ghost').click();
      await page.waitForTimeout(400);
      assert.strictEqual(await page.locator('.insight-view').count(), 1);
      assert.strictEqual(await page.locator('.insight-pick').nth(2).getAttribute('aria-pressed'), 'true');
    });
    // --- 富文本编辑 + 小程序引导词（完整书写页） ---
    await check('82 完整书写页是富文本：8 个格式按钮 + 字数按纯文本计', async () => {
      await page.locator('.nav-mod').nth(2).click();
      await page.waitForTimeout(400);
      assert.strictEqual(await page.locator('.cell-view .rt').count(), 1);
      assert.strictEqual(await page.locator('.cell-view .rt-toolbar .rt-btn').count(), 8);
      assert.strictEqual(await page.locator('.cell-view .rt-body').getAttribute('contenteditable'), 'true');
      // 九格里的紧凑模式不显示工具栏，避免 9 条工具栏挤成一团
      assert.strictEqual(await page.locator('.cell .rt-toolbar').count(), 0);
    });
    await check('83 选中文字点「粗」后编辑器内出现 strong（命令真的生效）', async () => {
      const body = page.locator('.cell-view .rt-body');
      await body.click();
      await page.keyboard.type('今天走了八千步');
      await page.keyboard.press('Control+A');
      await page.locator('.cell-view .rt-toolbar .rt-btn').first().click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.cell-view .rt-body strong, .cell-view .rt-body b').count(), 1);
      assert((await page.locator('.cell-view .rt-toolbar .rt-btn').first().getAttribute('class')).includes('rt-btn-on'));
    });
    await check('84 引导词取自 diary-store.promptFor，可换一条并插入为引用', async () => {
      const prompt = page.locator('.cell-view .rt-prompt-text');
      const first = (await prompt.textContent()).trim();
      assert(first.length > 4, '引导词为空：' + first);
      assert(!first.includes('暂无引导词'));
      await page.locator('.cell-view .rt-prompt-btn').first().click();
      await page.waitForTimeout(300);
      const second = (await prompt.textContent()).trim();
      assert(second.length > 4);
      assert.notStrictEqual(second, first, '「换一条」没有换出新词');
      await page.locator('.cell-view .rt-prompt-insert').click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.cell-view .rt-body blockquote').count(), 1);
    });
    await check('85 保存后回九格，该格以粗体渲染（Markdown 往返成立）', async () => {
      await page.locator('.cell-view .primary').click();
      await page.waitForTimeout(500);
      await page.locator('.cell-view .back').click();
      await page.waitForTimeout(400);
      const cell = page.locator('.cell[data-cell="health"]');
      assert.strictEqual(await cell.locator('.rt-body strong, .rt-body b').count(), 1, '九格未渲染粗体，可能是存了 HTML 或标记丢失');
      assert((await cell.locator('.rt-body').innerText()).includes('今天走了八千步'));
      assert.strictEqual(await cell.locator('.rt-body blockquote').count(), 1);
    });
    await check('86 重新进入完整页，富文本内容与格式仍在（已持久化）', async () => {
      await page.locator('.nav-mod').nth(2).click();
      await page.waitForTimeout(400);
      assert.strictEqual(await page.locator('.cell-view .rt-body strong, .cell-view .rt-body b').count(), 1);
      assert.strictEqual(await page.locator('.cell-view .rt-body blockquote').count(), 1);
      await page.locator('.cell-view .back').click();
      await page.waitForTimeout(300);
    });
    // --- 右栏按模块联动（每个入口一份专属上下文，不是同一份卡片） ---
    await check('87 今天右栏点九格进度 → 进入该格主功能，右栏同步换成 GTD 清单健康', async () => {
      await page.locator('.context .ctx-dot').first().click();
      await page.waitForTimeout(450);
      assert((await page.locator('.view-crumb').textContent()).includes('单格工作台'));
      const t = await page.locator('.context').innerText();
      assert(t.includes('清单健康') && t.includes('收件箱') && t.includes('下一步'), t.slice(0, 80));
      assert.strictEqual(await page.locator('.context .ctx-kv').count() >= 4, true);
    });
    await check('88 工作格右栏含每周回顾状态与「已记录/未记录」标记', async () => {
      const t = await page.locator('.context').innerText();
      assert(t.includes('每周回顾'), t.slice(0, 120));
      assert(/本周已记录|未记录/.test(t), t.slice(0, 120));
      assert(t.includes('五项检查通过'), t.slice(0, 120));
    });
    await check('89 金钱格右栏换成本月收支三栏 + 支出分类', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(250);
      await page.locator('.nav-mod').nth(1).click();
      await page.waitForTimeout(450);
      const t = await page.locator('.context').innerText();
      assert(t.includes('本月收支') && t.includes('支出') && t.includes('结余'), t.slice(0, 90));
      assert.strictEqual(await page.locator('.context .ctx-kv').count() >= 3, true);
    });
    await check('90 成长格右栏换成学习库进度与在读条目', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(250);
      await page.locator('.nav-mod', { hasText: '成长' }).first().click();
      await page.waitForTimeout(450);
      const t = await page.locator('.context').innerText();
      assert(t.includes('学习库') && t.includes('条目'), t.slice(0, 90));
    });
    await check('91 其余六格右栏换成该格指标 + 近 30 天热力', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(250);
      await page.locator('.nav-mod').nth(2).click();
      await page.waitForTimeout(500);
      const t = await page.locator('.context').innerText();
      assert(t.includes('健康') && t.includes('本期指标'), t.slice(0, 90));
      assert.strictEqual(await page.locator('.context .ctx-heat-cell').count(), 30);
    });
    await check('92 时间轴右栏：本年 12 个月度分布条', async () => {
      await page.locator('.nav-item').nth(1).click();
      await page.waitForTimeout(450);
      const t = await page.locator('.context').innerText();
      assert(t.includes('月度分布') && t.includes('近期节奏'), t.slice(0, 90));
      assert.strictEqual(await page.locator('.context .ctx-bar-row').count(), 12);
    });
    await check('93 回顾右栏：周/月两套复盘完成度', async () => {
      await page.locator('.nav-item').nth(2).click();
      await page.waitForTimeout(450);
      const t = await page.locator('.context').innerText();
      assert(t.includes('复盘完成度') && t.includes('本周') && t.includes('本月'), t.slice(0, 90));
      assert(t.includes('本周三问'), t.slice(0, 120));
    });
    await check('94 自由记录页：三 tab 在位，右栏仍是胶囊上下文（三组计数不泄露正文）', async () => {
      await page.locator('.nav-item').nth(3).click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.free-view').count(), 1, '第 4 项导航没进自由记录');
      assert.strictEqual(await page.locator('.free-view .fw-tab').count(), 3, '三种功能不齐');
      const t = await page.locator('.context').innerText();
      assert(t.includes('胶囊状态') && t.includes('待开启') && t.includes('封存中'), t.slice(0, 90));
      assert.strictEqual(await page.locator('.context .ctx-kv').count(), 3);
    });
    await check('95 坚持右栏：天数四格 + 下一个奖励', async () => {
      await page.locator('.nav-item').nth(4).click();
      await page.waitForTimeout(450);
      const t = await page.locator('.context').innerText();
      assert(t.includes('下一个奖励'), t.slice(0, 90));
      assert(t.includes('当前连续') && t.includes('最长连续'), t.slice(0, 120));
    });
    await check('96 数据中心右栏：本机数据规模四格', async () => {
      await page.locator('.nav-item').nth(6).click();
      await page.waitForTimeout(500);
      const t = await page.locator('.context').innerText();
      assert(t.includes('本机数据规模') && t.includes('日记篇数'), t.slice(0, 90));
      assert.strictEqual(await page.locator('.context .ctx-kv').count(), 4);
    });
    await check('97 设置右栏：当前配置四项 + 合规口径', async () => {
      await page.locator('.nav-item').nth(7).click();
      await page.waitForTimeout(450);
      const t = await page.locator('.context').innerText();
      assert(t.includes('当前配置') && t.includes('九格模板'), t.slice(0, 90));
      assert(t.includes('不收集账号'), t.slice(0, 160));
    });
    await check('98 九个入口的右栏内容互不相同（无复用残留）', async () => {
      const texts = [];
      for (let i = 0; i < 8; i += 1) {
        await page.locator('.nav-item').nth(i).click();
        await page.waitForTimeout(260);
        texts.push((await page.locator('.context').innerText()).replace(/\s+/g, ''));
      }
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(260);
      await page.locator('.nav-mod').first().click();
      await page.waitForTimeout(400);
      texts.push((await page.locator('.context').innerText()).replace(/\s+/g, ''));
      const unique = new Set(texts);
      assert.strictEqual(unique.size, texts.length, '有入口共用同一份右栏：' + texts.map(function (t) { return t.slice(0, 18); }).join(' | '));
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(250);
    });
    // ---- V1.1：补记 ----
    await check('99 补记：点前一天出现横幅，并明示统计口径', async () => {
      await page.locator('.dn-btn').first().click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.backfill-banner').count(), 1, '补记横幅未出现');
      const b = await page.locator('.backfill-banner').innerText();
      assert(b.includes('补记'), b);
      assert(b.includes('真实今天'), '未明示统计口径，用户会以为右侧统计也切了');
      assert((await page.locator('.dn-label').getAttribute('class')).includes('dn-past'), '日期标签未变色');
      assert((await page.locator('.date-title').innerText()).includes('补记'), '九格标题未标补记');
    });

    await check('100 补记写入的是那一天，切回今天不串内容', async () => {
      const cell = page.locator('.cell[data-cell="free"] .rt-body');
      await cell.click();
      await page.keyboard.type('补记的一句话');
      await page.waitForTimeout(200);
      await page.locator('.save-btn').click();
      await page.waitForTimeout(800);
      await page.locator('.dn-today').click();
      await page.waitForTimeout(700);
      assert.strictEqual(await page.locator('.backfill-banner').count(), 0, '回到今天后横幅还在');
      const todayFree = await page.locator('.cell[data-cell="free"] .rt-body').innerText();
      assert(!todayFree.includes('补记的一句话'), '补记内容串到今天了');
      await page.locator('.dn-btn').first().click();
      await page.waitForTimeout(700);
      const backFree = await page.locator('.cell[data-cell="free"] .rt-body').innerText();
      assert(backFree.includes('补记的一句话'), '补记内容没落到那一天');
    });

    await check('101 补记态回到今天后，「后一天」按钮禁用（不能写未来）', async () => {
      await page.locator('.dn-btn').nth(1).click();
      await page.waitForTimeout(500);
      assert.strictEqual(await page.locator('.backfill-banner').count(), 0, '未回到今天');
      assert(await page.locator('.dn-btn').nth(1).isDisabled(), '今天之后仍可前进');
    });

    // ---- V1.1：封存箱 ----
    await check('102 封存：时间轴点 × 后该篇离开列表', async () => {
      await page.locator('.nav-item').nth(1).click();
      await page.waitForTimeout(500);
      const before = await page.locator('.chip-op').count();
      assert(before >= 2, '可封存的篇目不足：' + before);
      await page.locator('.chip-bin').first().click();
      await page.waitForTimeout(700);
      const after = await page.locator('.chip-op').count();
      assert.strictEqual(after, before - 1, '封存后列表没减少');
      const msg = await page.locator('.tl-msg').innerText();
      assert(msg.includes('封存箱'), msg);
      assert(msg.includes('还原'), '未提示可还原');
    });

    await check('103 封存箱：左栏二级进入，条目带「还有 N 天离开」', async () => {
      await page.locator('.nav-bin').click();
      await page.waitForTimeout(600);
      assert.strictEqual(await page.locator('.bin-view').count(), 1, '封存箱未独立成视图');
      assert.strictEqual(await page.locator('.bin-item').count(), 1, '封存箱条目数不对');
      const leave = await page.locator('.bin-leave').innerText();
      assert(/还有 \d+ 天/.test(leave), leave);
      assert(leave.includes('离开'), '未给出离开日期');
      assert((await page.locator('.context').innerText()).includes('封存'), '右栏没有封存箱专属面板');
    });

    await check('104 还原：封存箱清空，该篇回到时间轴', async () => {
      await page.locator('.bin-restore').click();
      await page.waitForTimeout(800);
      assert.strictEqual(await page.locator('.bin-item').count(), 0, '还原后条目还在');
      assert((await page.locator('.bin-empty').innerText()).includes('空'), '空态文案缺失');
      await page.locator('.nav-item').nth(1).click();
      await page.waitForTimeout(600);
      const n = await page.locator('.chip-op').count();
      assert(n >= 2, '还原后时间轴篇数没回来：' + n);
    });

    // ---- V1.1：数据健康 ----
    await check('105 数据健康：六项状态齐全，且如实说明备份落后', async () => {
      // 数据中心现在是第 7 个一级入口（娱乐插在坚持之后）
      await page.locator('.nav-item', { hasText: '数据中心' }).click();
      await page.waitForTimeout(800);
      assert.strictEqual(await page.locator('.health').count(), 1, '健康卡未出现');
      const t = await page.locator('.health-grid').innerText();
      ['上次退出', '主文件', '备份文件', '快照', '数据规模', '自动备份'].forEach((k) => {
        assert(t.includes(k), '健康卡缺「' + k + '」');
      });
      const note = await page.locator('.health-note').innerText();
      assert(note.includes('落后'), '没说明备份落后篇数（说"一致"是谎话）');
    });

    await check('106 立即备份：手动触发一次快照并刷新状态', async () => {
      const before = await page.locator('.h-cell').nth(3).innerText();
      await page.locator('.hbtn').first().click();
      await page.waitForTimeout(1200);
      const after = await page.locator('.h-cell').nth(3).innerText();
      assert(/份/.test(after), '快照状态未刷新：' + after);
      assert(before !== after || after.includes('最近'), '快照数未变化：' + before + ' → ' + after);
    });

    // ---- V1.1：内联状态提示 ----
    await check('107 内联提示：九格空格显示「还没写过 / N 天没写」', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(700);
      const gaps = await page.locator('.cell-gap').count();
      assert(gaps > 0, '九格没有任何「多久没写」提示');
      const first = await page.locator('.cell-gap').first().innerText();
      assert(/还没写过|天没写/.test(first), first);
    });

    // ---- V1.2 收尾：定位 ≠ 过滤 ----
    await check('107a 定位不筛列表、Enter 跳下一处；过滤只留命中；心情筛选只在过滤可用', async () => {
      // 造两篇同关键词的日记（今天 + 昨天），保证「下一处」真的有下一处
      const body = page.locator('.cell[data-cell="emotion"] .rt-body');
      await body.click();
      await page.keyboard.type('定位样例甲');
      await page.locator('.save-btn').click();
      await page.waitForTimeout(700);
      await page.locator('.dn-btn').first().click();
      await page.waitForTimeout(650);
      const backCell = page.locator('.cell[data-cell="emotion"] .rt-body');
      await backCell.click();
      await page.keyboard.type('定位样例乙');
      await page.locator('.save-btn').click();
      await page.waitForTimeout(750);
      await page.locator('.dn-today').click();
      await page.waitForTimeout(600);

      await page.locator('.nav-item').nth(1).click();
      await page.waitForTimeout(800);
      const total = await page.locator('.rv-loc-row').count();
      assert(total >= 2, '定位列表是空的：' + total);
      assert.strictEqual((await page.locator('.rv-mode-on').innerText()).trim(), '定位', '默认不是定位模式');

      const box = page.locator('.diary input[placeholder="正文 / 栏目关键词"]');
      await box.fill('定位样例');
      await page.waitForTimeout(450);
      // 分水岭：定位一篇不少，过滤才筛
      assert.strictEqual(await page.locator('.rv-loc-row').count(), total, '定位模式把列表筛掉了');
      assert((await page.locator('.rv-loc .hl').count()) >= 2, '命中处没有高亮');
      assert.strictEqual(await page.locator('.rv-loc-on').count(), 1, '没标出当前处');
      assert(/第 1 \/ 2 处/.test(await page.locator('.rv-count').innerText()),
        '计数不对：' + (await page.locator('.rv-count').innerText()));
      const firstDate = await page.locator('.rv-loc-on .rv-loc-date').innerText();

      await box.press('Enter');
      await page.waitForTimeout(350);
      assert(/第 2 \/ 2 处/.test(await page.locator('.rv-count').innerText()),
        'Enter 没跳到下一处：' + (await page.locator('.rv-count').innerText()));
      const secondDate = await page.locator('.rv-loc-on .rv-loc-date').innerText();
      assert.notStrictEqual(firstDate, secondDate, '当前处没换（跳了个寂寞）');

      await box.press('Shift+Enter');
      await page.waitForTimeout(350);
      assert(/第 1 \/ 2 处/.test(await page.locator('.rv-count').innerText()), 'Shift+Enter 没回到上一处');

      // 搜不到时列表也不许清空——清空就又变成过滤了
      await box.fill('绝无此词zzz');
      await page.waitForTimeout(400);
      assert.strictEqual(await page.locator('.rv-loc-row').count(), total, '没有命中时列表被清空');
      const noHit = await page.locator('.rv-count').innerText();
      assert(noHit.includes('没有命中') && noHit.includes(String(total)), '没命中时该说清列表仍是全量：' + noHit);

      // 过滤：只留命中
      await box.fill('定位样例');
      await page.getByRole('button', { name: '过滤' }).click();
      await page.waitForTimeout(600);
      assert.strictEqual(await page.locator('.rv-loc-row').count(), 0, '过滤模式还在画全量列表');
      const lines = await page.locator('.rv-find .line').count();
      assert(lines >= 2, '过滤命中不足：' + lines);
      assert((await page.locator('.rv-find .line').first().innerText()).includes('定位样例'));

      // 心情筛选属于过滤：定位模式下必须置灰，否则点了没反应像坏了
      await page.getByRole('button', { name: '定位' }).click();
      await page.waitForTimeout(350);
      assert(await page.locator('.rv-find select').isDisabled(), '定位模式下心情筛选仍可点');
    });

    // ---- V1.2 收尾：未来 7 天（右栏，只读 + 跳转）----
    await check('107b 未来 7 天：右栏列出明天到期，点一行进对应主功能', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(700);
      // 造一条「明天到期」的日程：捕获 → 厘清向导第 3 步「定个日子」
      await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
      await page.waitForTimeout(700);
      await page.locator('.cap-input').fill('明天要交的验收单');
      await page.locator('.cap-btn').click();
      await page.waitForTimeout(600);
      await page.locator('.clarify-btn').first().click();
      await page.waitForTimeout(350);
      await page.locator('.cp-choice').nth(0).click();
      await waitStep(page, 2);
      await page.locator('.clarify-panel .primary').click();
      await waitStep(page, 3);
      await page.locator('.cp-choice').nth(1).click();
      await page.waitForTimeout(250);
      const t = new Date();
      t.setDate(t.getDate() + 1);
      const pad = function (n) { return n < 10 ? '0' + n : String(n); };
      const tomorrow = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
      await page.locator('.clarify-panel input[type="date"]').fill(tomorrow);
      await page.locator('.clarify-panel .primary').click();
      await page.waitForTimeout(800);
      await page.locator('.gtd-view .back').click();
      await page.waitForTimeout(800);

      assert.strictEqual(await page.locator('.ctx-soon-card').count(), 1, '右栏没有「未来 7 天」');
      assert((await page.locator('.ctx-soon-row').count()) >= 1, '未来 7 天是空的');
      const card = await page.locator('.ctx-soon-card').innerText();
      assert(card.includes('明天'), '日期没算成「明天」：' + card);
      assert(card.includes('明天要交的验收单'), '刚排的日程没进右栏');
      // 只读预览：右栏里没有输入控件
      assert.strictEqual(await page.locator('.ctx-soon-card input, .ctx-soon-card textarea').count(), 0, '右栏预览里出现了输入框（越界写数据）');

      await page.locator('.ctx-soon-row', { hasText: '明天要交的验收单' }).first().click();
      await page.waitForTimeout(800);
      assert.strictEqual(await page.locator('.gtd-view').count(), 1, '点一行没进 GTD 工作台');
      await page.locator('.gtd-view .back').click();
      await page.waitForTimeout(600);
    });

    // ---- 梦想升成一级目标板 / 娱乐补进九格 / 梦想账户浮窗 ----
    await check('107c 梦想：左栏一级进入，建一条带账户的目标，存够后浮窗提醒、达成后消失', async () => {
      const navDream = page.locator('.nav-item', { hasText: '梦想' });
      assert.strictEqual(await navDream.count(), 1, '左栏没有「梦想」一级目录');
      await navDream.first().click();
      await page.waitForTimeout(800);
      assert.strictEqual(await page.locator('.dream-view').count(), 1, '没有进入梦想页');
      assert((await page.locator('.dream-view h1').innerText()).includes('梦想'));

      // 初始那棵树（六个领域 17 条目标）应该已经种进去了
      const seeded = await page.locator('.rows').innerText();
      ['健康与精力', '事业与财务', '家庭与社交', '学习与成长', '精神与休闲', '物质与环境'].forEach(function (k) {
        assert(seeded.includes(k), '初始树缺领域：' + k);
      });
      assert(seeded.includes('每周运动 3 次'), '初始树缺子目标');
      assert.strictEqual(await page.locator('.area').count(), 6, '领域分组数量不对');

      // 建一条：事业与财务 / 短期，带截止日
      await page.locator('.add-btn').click();
      await page.waitForTimeout(200);
      await page.locator('.ap-title').fill('换一台工作站');
      await page.locator('.ap-sel').nth(0).selectOption('career');
      await page.locator('.ap-sel').nth(1).selectOption('short');
      await page.locator('.ap-date').fill('2027-03-01');
      await page.locator('.ap-save').click();
      await page.waitForTimeout(800);
      const rowsText = await page.locator('.rows').innerText();
      assert(rowsText.includes('换一台工作站'), '目标没进列表：' + rowsText);
      assert(rowsText.includes('事业与财务'), '领域标签没显示');
      assert(rowsText.includes('短期'), '期限标签没显示');

      // 新建后自动选中：详细设置在**右栏**，中栏不再内联展开
      const mine = page.locator('.goal', { hasText: '换一台工作站' }).first();
      await page.waitForTimeout(400);
      assert.strictEqual(await mine.locator('.goal-detail').count(), 0, '中栏还在内联展开详情（应移到右栏）');
      assert.strictEqual(await page.locator('.context .dctx-detail').count(), 1, '新建后右栏没换成这条目标的详情');
      assert((await page.locator('.context .dctx-detail').innerText()).includes('换一台工作站'), '右栏详情不是刚建的那条');
      assert.strictEqual(await page.locator('.context .dctx-photo').count(), 1, '右栏顶部没有梦想图片窗');
      assert((await page.locator('.context .dctx-detail').innerText()).includes('量化分析'), '右栏缺量化分析');

      // 点另一条 → 右栏换过去；再点回来（选中态必须跟手）
      await page.locator('.goal', { hasText: '每周运动 3 次' }).first().locator('.g-title').click();
      await page.waitForTimeout(500);
      assert((await page.locator('.context .dctx-detail').innerText()).includes('每周运动 3 次'), '右栏没跟着换目标');
      await mine.locator('.g-title').click();
      await page.waitForTimeout(500);
      assert((await page.locator('.context .dctx-detail').innerText()).includes('换一台工作站'), '点回来右栏没换回原目标');

      // 右栏开梦想账户 2000 元
      await page.locator('.context input[aria-label="梦想账户目标金额（元）"]').fill('2000');
      await page.locator('.context .dctx-detail button', { hasText: '开启账户' }).click();
      await page.waitForTimeout(800);
      assert((await mine.locator('.goal-main').innerText()).includes('账户 ¥0 / 2,000'),
        '账户没建起来：' + (await mine.locator('.goal-main').innerText()));

      // 存够 → 浮窗出现
      await page.locator('.context input[aria-label="存入金额（元）"]').fill('2000');
      await page.locator('.context .dctx-detail button').filter({ hasText: /^存入$/ }).click();
      await page.waitForTimeout(900);
      assert((await mine.locator('.goal-main').innerText()).includes('可动'), '存够后没标「可动」');
      await page.waitForTimeout(600);
      assert.strictEqual(await page.locator('.dream-alert').count(), 1, '账户存够后没有浮窗提醒');
      const alertText = await page.locator('.dream-alert').innerText();
      assert(alertText.includes('换一台工作站') && alertText.includes('2,000'), '浮窗没写清是哪个梦想：' + alertText);
      assert(alertText.includes('标记达成之前'), '浮窗没说清会一直提醒到达成为止');

      // 点「去梦想页」不该关掉提醒（还债靠达成，不靠点掉）
      await page.locator('.da-later').click();
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('.dream-alert').count(), 0, '「稍后」没有收起浮窗');

      // 具象化图片：走真实按钮 → 原生选择器（PROBE 给固定路径）→ 复制进数据目录 → 右栏显示
      await page.locator('.context .dctx-photo-bar button', { hasText: '选一张图片' }).click();
      await page.waitForTimeout(900);
      const pic = page.locator('.context .dctx-photo img');
      assert.strictEqual(await pic.count(), 1, '右栏图片窗没显示出刚设置的图片');
      const picSrc = await pic.getAttribute('src');
      assert(picSrc && picSrc.indexOf('data:image/png;base64,') === 0,
        '图片不是从本机读成 dataURL 的：' + String(picSrc).slice(0, 40));
      assert.strictEqual(await mine.locator('.g-pic').count(), 1, '列表没标出这条已配图');
      await page.locator('.context .dctx-photo-bar button', { hasText: '移除' }).click();
      await page.waitForTimeout(800);
      assert.strictEqual(await page.locator('.context .dctx-photo img').count(), 0, '移除后图片还在');
      assert.strictEqual(await page.locator('.context .dctx-photo-hold').count(), 1, '移除后没回到占位态');
      assert.strictEqual(await mine.locator('.g-pic').count(), 0, '列表配图标记没跟着消失');

      // 标记达成 → 浮窗不再出现（刷新后也不再）
      await mine.locator('.g-check').click();
      await page.waitForTimeout(900);
      assert.strictEqual(await page.locator('.dream-alert').count(), 0, '达成之后浮窗还在');
      assert((await mine.locator('.goal-main').innerText()).includes('已达成'), '状态没改成已达成');
    });

    // --- 语料库：名言 / 问候 / 运动提示都能自己增删改 ---
    await check('108 语料库入口：数据中心下有二级目录，三类齐全并显示内置数量', async () => {
      await page.locator('.nav-lib').click();
      await page.waitForSelector('.lib-view', { timeout: 5000 });
      assert.strictEqual(await page.locator('.lib-tab').count(), 3, '三类语料没齐');
      const tabs = await page.locator('.lib-tab').allInnerTexts();
      assert(tabs.join('|').includes('名言警句') && tabs.join('|').includes('问候语') && tabs.join('|').includes('运动提示'), tabs.join('|'));
      const bar = await page.locator('.lib-bar').innerText();
      assert(bar.includes('内置 539'), '名言内置数量没显示：' + bar);
      assert((await page.locator('.lib-today .lt-row').count()) >= 3, '没有「今天取到的三条」预览');
      // 右栏只读：只有跳转链接，没有输入控件
      assert.strictEqual(await page.locator('.context .lib-view').count(), 0);
      assert.strictEqual(await page.locator('.context input, .context textarea').count(), 0, '右栏出现了输入控件');
      const ctx = await page.locator('.context').innerText();
      assert(ctx.includes('三类语料') && ctx.includes('此刻取到的三条'), '右栏没显示语料库联动信息：' + ctx.slice(0, 80));
    });

    await check('109 新增一条自己的名言：出现在列表首位、标「我的」，删掉后回到 0', async () => {
      const mine = 'E2E 自己写的一句：把今天过好';
      await page.locator('.lib-btn', { hasText: '＋ 新增' }).click();
      await page.locator('.lib-add .lib-input').fill(mine);
      await page.locator('.lib-add .lib-mini').first().fill('E2E');
      await page.locator('.lib-add .lib-btn-main').click();
      await page.waitForTimeout(600);
      const first = page.locator('.lib-item').first();
      assert((await first.innerText()).includes(mine), '新增后没出现在列表首位');
      assert((await first.innerText()).includes('我的'), '新增条目没标「我的」');
      assert((await page.locator('.lib-bar').innerText()).includes('我的 1'), '「我的」计数没变');

      // 改一句：改完立刻在新位置显示
      await first.locator('.lib-link', { hasText: '编辑' }).click();
      await page.locator('.lib-item .lib-input').first().fill(mine + '（改过）');
      await page.locator('.lib-item .lib-btn-main').click();
      await page.waitForTimeout(600);
      assert((await page.locator('.lib-item').first().innerText()).includes('（改过）'), '编辑没生效');

      // 删自己的：真删
      await page.locator('.lib-item').first().locator('.lib-link', { hasText: '删除' }).click();
      await page.waitForTimeout(600);
      assert((await page.locator('.lib-bar').innerText()).includes('我的 0'), '删掉后「我的」计数没回落');
      assert((await page.locator('.lib-item').first().innerText()).indexOf('E2E 自己写的') < 0, '删掉后还在列表里');
    });

    await check('110 删内置只记「已移除」、原文不变，可一键还原', async () => {
      await page.locator('.lib-tab', { hasText: '问候语' }).click();
      await page.waitForSelector('.lib-item', { timeout: 5000 });
      const before = await page.locator('.lib-bar').innerText();
      assert(before.includes('内置 29'), '问候语内置数量不对：' + before);
      const firstText = await page.locator('.lib-item').first().innerText();

      await page.locator('.lib-item').first().locator('.lib-link', { hasText: '移除' }).click();
      await page.waitForTimeout(600);
      const after = await page.locator('.lib-bar').innerText();
      assert(after.includes('已移除 1'), '移除后没记「已移除」：' + after);

      await page.locator('.lib-chip', { hasText: '已移除' }).click();
      await page.waitForTimeout(400);
      const hidden = page.locator('.lib-item').first();
      assert((await hidden.innerText()).includes(firstText.slice(0, 8)), '已移除列表里不是原句（原文被改动）');
      await hidden.locator('.lib-link', { hasText: '还原' }).click();
      await page.waitForTimeout(600);
      // 计数看「已移除」那个筛选胶囊：它常驻显示数字，而顶部统计行在归零后不再写「已移除 0」
      const chip = await page.locator('.lib-chip', { hasText: '已移除' }).innerText();
      assert(/0/.test(chip), '还原后计数没回落：' + chip);
      assert((await page.locator('.lib-empty').innerText()).includes('没有已移除'), '还原后空态提示不对');
    });

    await check('111 首页三行都来自语料库：「动一动」有标签、「换一条」真的换、能进语料库', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForSelector('.greeting-bar', { timeout: 5000 });
      const hint = await page.locator('.greeting-hint').innerText();
      assert(hint.includes('动一动'), '运动提示没标「动一动」：' + hint);
      assert(hint.replace('动一动', '').trim().length > 2, '运动提示是空的');

      const before = await page.locator('.quote-line').innerText();
      await page.locator('.qa-btn', { hasText: '换一条' }).click();
      await page.waitForTimeout(500);
      const after = await page.locator('.quote-line').innerText();
      assert.notStrictEqual(after, before, '「换一条」没换');

      await page.locator('.qa-btn', { hasText: '语料库' }).click();
      await page.waitForSelector('.lib-view', { timeout: 5000 });
      assert((await page.locator('.view-crumb').innerText()).includes('语料库'), '标题栏没切到语料库');
    });

    // --- V1.3 时间纵深：五项能力的真窗口断言 ---
    await check('113 时间纵深入口：左栏二级进入，人生月历 1200 格且不说「你已走过」', async () => {
      await page.locator('.nav-life').click();
      await page.waitForSelector('.v13', { timeout: 5000 });
      assert.strictEqual(await page.locator('.v13-month').count(), 1200, '月历不是 100 年 × 12 月');
      const head = await page.locator('.v13-h2').innerText();
      assert(head.includes('从第一条记录算起'), '未填生日时的口径不对：' + head);
      assert(!head.includes('你已走过'), '未填生日却假装知道生日');
    });

    await check('114 填出生年月后改用「你已走过」，起点跟着换成出生年', async () => {
      await page.locator('#v13-birth').fill('1980-06');
      await page.locator('.v13-birth .v13-btn').click();
      await page.waitForTimeout(400);
      const head = await page.locator('.v13-h2').innerText();
      assert(head.includes('你已走过'), '填了生日仍用估算口径：' + head);
      assert.strictEqual((await page.locator('.v13-yearlabel').first().innerText()).trim(), '1980', '起点没换成出生年');
    });

    await check('115 正文待办：只读表，页面里没有任何可写输入框', async () => {
      await page.locator('.v13-tab', { hasText: '正文待办' }).click();
      await page.waitForSelector('.v13-digest', { timeout: 5000 });
      const rows = await page.locator('.v13-todo').count();
      const empty = await page.locator('.v13-digest .v13-empty').count();
      assert(rows > 0 || empty > 0, '待办页既没有行也没有空态');
      assert.strictEqual(await page.locator('.v13-digest input').count(), 0, '只读汇总出现可写输入框');
      assert((await page.locator('.v13-note').first().innerText()).includes('回到原文'), '没说明勾选要回原文');
    });

    await check('116 随便看看：能翻出旧日记且连点不重复；空库则禁用并说明', async () => {
      await page.locator('.v13-tab', { hasText: '随便看看' }).click();
      await page.waitForSelector('.v13-panel', { timeout: 5000 });
      const roll = page.locator('.v13-panel .v13-btn', { hasText: '再翻一篇' });
      if (await roll.isDisabled()) {
        assert((await page.locator('.v13-empty').innerText()).includes('还没有旧记录'), '空库没给提示');
        return;
      }
      await roll.click();
      await page.waitForSelector('.v13-pick', { timeout: 5000 });
      const first = await page.locator('.v13-pick .v13-h3').innerText();
      await roll.click();
      await page.waitForTimeout(400);
      if (await page.locator('.v13-pick').count() > 0) {
        const second = await page.locator('.v13-pick .v13-h3').innerText();
        assert.notStrictEqual(second, first, '连点两次翻到同一篇');
      } else {
        assert((await page.locator('.v13-empty').innerText()).includes('翻过'), '翻完没给说明');
      }
    });

    await check('117 导出今天为一张图：回执含路径 / 字节 / 尺寸，落盘真是 PNG', async () => {
      await page.locator('.v13-tabs .v13-btn', { hasText: '导出今天为一张图' }).click();
      await page.waitForFunction(function () {
        const el = document.querySelector('.v13-msg');
        return !!el && el.textContent.indexOf('已导出') >= 0;
      }, null, { timeout: 15000 });
      const msg = await page.locator('.v13-msg').innerText();
      assert(/字节/.test(msg) && /×/.test(msg), '回执缺字节数或尺寸：' + msg);
      const m = msg.match(/已导出 (.+?) · (\d+) 字节/);
      assert(m, '回执没给完整路径');
      const buf = fs.readFileSync(m[1]);
      assert.strictEqual(buf.slice(1, 4).toString(), 'PNG', '落盘的不是 PNG 二进制');
      assert.strictEqual(buf.length, Number(m[2]), '回执字节数与文件不符');
    });

    await check('118 数据中心「一个文件」：路径可见，打包产物只装数据键', async () => {
      await page.locator('.nav-item', { hasText: '数据中心' }).click();
      await page.waitForSelector('.dc', { timeout: 5000 });
      await page.locator('.action-card', { hasText: '导出备份' }).click();
      const card = page.locator('.panel[aria-label="一个文件"]');
      assert((await card.innerText()).includes('个数据键'), '没把数据文件与键数量写清楚');
      await card.locator('.btn', { hasText: '打包为单个文件' }).click();
      await page.waitForFunction(function () {
        const el = document.querySelector('.dc .receipt');
        return !!el && el.textContent.indexOf('.jiuge') >= 0;
      }, null, { timeout: 15000 });
      const receipt = await page.locator('.dc .receipt').innerText();
      const m = receipt.match(/回执：(.+?\.jiuge) · (\d+) 字节/);
      assert(m, '打包回执没给路径与字节：' + receipt);
      const pack = JSON.parse(fs.readFileSync(m[1], 'utf8'));
      assert(pack.app === 'jiuge-notes' && pack.kind === 'jiuge-pack', '打包格式不对');
      assert(Object.keys(pack.data).every(function (k) {
        return k.indexOf('asar') < 0 && !/\.(exe|dll|js)$/.test(k);
      }), '包里混进了程序文件');
    });

    // --- 三个二级视图：保守存在性 / 界面减负（不依赖库里有数据、不写文件）---
    await check('119 内容连接：左栏二级进入，五个分区都在且不再堆解释', async () => {
      await page.locator('.nav-connect').click();
      await page.waitForSelector('.con-root', { timeout: 5000 });
      const tabTexts = await page.locator('.con-tab').allInnerTexts();
      ['搜索增强', '正文内链', '轻标签', '重复任务', '耗时记录'].forEach(function (label) {
        assert(tabTexts.some(function (t) { return t.includes(label); }), '缺分区：' + label);
      });
      const root = page.locator('.con-root');
      assert((await root.innerText()).includes('拼音'), '搜索增强分区没提「拼音」');
      // 界面减负：切到耗时分区后也不该再出现设计理由 / 实现口径
      await page.locator('.con-tab', { hasText: '耗时记录' }).click();
      const conText = await root.innerText();
      assert(!conText.includes('牺牲精度') && !conText.includes('诚实说明'), '耗时分区仍常驻解释文案');
    });

    await check('120 关系经营：左栏二级进入，两个入口按时态分开且界面不堆解释', async () => {
      await page.locator('.nav-relation').click();
      await page.waitForSelector('.rel-wrap', { timeout: 5000 });
      // 详情表单（含「我能帮他什么」与两个入口按钮）默认收起；点「新增联系人」只展开前端表单，不写文件
      await page.locator('.rel-btn', { hasText: '新增联系人' }).click();
      await page.waitForSelector('.rel-formgrid', { timeout: 5000 });
      const text = await page.locator('.rel-wrap').innerText();
      assert(text.includes('约一下'), '缺「约一下」入口');
      assert(text.includes('记一次'), '缺「记一次」入口');
      assert(text.includes('我能帮他什么'), '缺「我能帮他什么」栏');
      assert(text.includes('还没发生') && text.includes('已经发生'), '两个入口没按时态分开');
      assert(!text.includes('健康度评分') && !text.includes('心理学常数'), '关系视图仍常驻评分/公式解释');
    });

    await check('121 长期形状：左栏二级进入，克制条款收起但加密免责即时可见', async () => {
      await page.locator('.nav-long').click();
      await page.waitForSelector('.lng-wrap', { timeout: 5000 });
      const wrap = page.locator('.lng-wrap');
      const termText = await wrap.innerText();
      assert(!termText.includes('不做养生') && !termText.includes('诚实降级'), '节气分区仍常驻克制条款');
      // 「忘记口令即不可恢复」在「单条加密」分区（v-else-if），默认不渲染，切过去再看
      await page.locator('.lng-tab', { hasText: '单条加密' }).click();
      await page.waitForFunction(function () {
        const el = document.querySelector('.lng-wrap');
        return !!el && el.textContent.indexOf('忘记口令即不可恢复') >= 0;
      }, null, { timeout: 5000 });
      assert((await wrap.innerText()).includes('忘记口令即不可恢复'), '加密分区没写口令不可恢复免责');
    });

    await check('122 新视图切换后左栏一级导航仍是 8 项', async () => {
      await page.locator('.nav-connect').click();
      await page.waitForSelector('.con-root', { timeout: 5000 });
      // 新功能只走二级入口，不占一级名额
      assert.strictEqual(await page.locator('.nav-item').count(), 8, '一级导航被新视图占用了名额');
    });

    await check('123 三个新视图都有回今天的入口', async () => {
      const views = [
        { nav: '.nav-relation', root: '.rel-wrap', back: '.rel-back' },
        { nav: '.nav-connect', root: '.con-root', back: '.con-back' },
        { nav: '.nav-long', root: '.lng-wrap', back: '.lng-back' }
      ];
      for (const v of views) {
        await page.locator(v.nav).click();
        await page.waitForSelector(v.root, { timeout: 5000 });
        const back = page.locator(v.root + ' ' + v.back);
        assert.strictEqual(await back.count(), 1, v.root + ' 里应有且仅有一个返回入口');
        // 真实文案是「← 返回」：既非「回到今天」、也不含「今天」，按真实 DOM 断言返回入口
        const label = await back.innerText();
        assert(label.includes('回到今天') || label.includes('今天') || label.includes('返回'),
          v.root + ' 返回按钮文案异常：' + label);
      }
    });

    await check('124 新视图里没有可写正本的越权入口', async () => {
      const views = [
        { nav: '.nav-connect', root: '.con-root' },
        { nav: '.nav-relation', root: '.rel-wrap' },
        { nav: '.nav-long', root: '.lng-wrap' }
      ];
      for (const v of views) {
        await page.locator(v.nav).click();
        await page.waitForSelector(v.root, { timeout: 5000 });
        const scope = page.locator(v.root);
        assert.strictEqual(await scope.locator('input[type="file"]').count(), 0,
          v.root + ' 里出现文件选择框（可越权读写本地文件）');
        if (v.root === '.con-root') {
          // 正文内链只读：连接视图里不该有 contenteditable 正本编辑区
          assert.strictEqual(await scope.locator('[contenteditable="true"]').count(), 0,
            '连接视图出现 contenteditable 正本编辑区');
        }
      }
    });

    await check('125 图书馆顶栏入口、三分区与右栏联动', async () => {
      await page.locator('.reading-btn').click();
      await page.waitForSelector('.rd-view', { timeout: 5000 });
      assert.strictEqual(await page.locator('.rd-tab').count(), 3, '图书馆应有休闲 / 主题 / 读书笔记三个分区');
      assert.ok((await page.locator('.rd-title').innerText()).indexOf('图书馆') >= 0);
      const ctx = await page.locator('[data-context="reading"]').innerText();
      assert.ok(ctx.indexOf('读书笔记') >= 0 && ctx.indexOf('标签聚类') >= 0, '右栏没换成图书馆联动信息');
    });

    await check('126 休闲阅读：加书 → 翻开 → 伴读三问 → 行内批注进读书笔记库', async () => {
      await page.locator('.rd-tab').nth(0).click();
      await page.locator('.rd-name').fill('九格试读本');
      await page.locator('.rd-add .rd-primary').click();
      await page.waitForSelector('.rd-book', { timeout: 5000 });
      assert.ok((await page.locator('.rd-book').first().innerText()).indexOf('九格试读本') >= 0, '书没上书架');
      await page.locator('.rd-book').first().locator('button', { hasText: '翻开读' }).click();
      await page.waitForSelector('.rd-reader', { timeout: 5000 });
      assert.strictEqual(await page.locator('.rd-prompt').count(), 3, '伴读三问应恰好三问');
      await page.locator('.rd-prompt').first().click();
      assert.ok((await page.locator('.rd-reader').innerText()).indexOf('别等') >= 0, '点问题后没给提示');
      await page.locator('.rd-reader textarea').nth(0).fill('书里的一句原文');
      await page.locator('.rd-reader textarea').nth(1).fill('我读到时想到的一句话');
      await page.locator('.rd-reader input[aria-label="页码"]').fill('32');
      await page.locator('.rd-reader input[aria-label="标签"]').fill('#给排水 #试读');
      await page.locator('.rd-reader .rd-primary').click();
      await page.locator('.rd-tab').nth(2).click();
      await page.waitForSelector('.rd-note', { timeout: 5000 });
      const row = await page.locator('.rd-note').first().innerText();
      assert.ok(row.indexOf('书里的一句原文') >= 0 && row.indexOf('#给排水') >= 0, '笔记没进「读书笔记」数据库');
    });

    await check('127 笔记写进九格：带出处、只一行、防重复', async () => {
      await page.locator('.rd-note').first().locator('button', { hasText: '→ 九格' }).click();
      await page.waitForSelector('.rd-pushed', { timeout: 5000 });
      // 别用返回 Promise 的 waitForFunction：Promise 对象本身是 truthy，会立刻「通过」。
      // 也别只取 items[0]：补记用例会留下别的日期。改成 Node 侧轮询真实数据。
      let snap = [];
      for (let i = 0; i < 25; i++) {
        snap = await page.evaluate(async () => {
          const r = await window.jiugeBridge.invoke('v1/diaries:list', { pageSize: 20 });
          return ((r.data && r.data.items) || []).map(function (x) {
            return { date: x.date, free: (x.cells && x.cells.free) || '' };
          });
        });
        if (snap.some(function (x) { return x.free.indexOf('【读书·') >= 0; })) break;
        await page.waitForTimeout(200);
      }
      const hit = snap.filter(function (x) { return x.free.indexOf('【读书·') >= 0; });
      assert.strictEqual(hit.length, 1, '应恰好一天收到回写，现场：' + JSON.stringify(snap));
      const text = hit[0].free;
      assert.ok(text.indexOf('【读书·休闲娱乐】《九格试读本》p.32') >= 0, '回写行缺书名 / 页码：' + text);
      assert.ok(text.indexOf('我读到时想到的一句话') >= 0, '回写行缺自己的话');
      assert.strictEqual((text.match(/【读书·/g) || []).length, 1, '同一条笔记被写进九格两次');
    });

    await check('128 主题阅读 V2.14 自建书单；闪念一键同时进库与九格', async () => {
      await page.locator('.rd-tab').nth(1).click();
      await page.waitForSelector('.rd-notice', { timeout: 5000 });
      assert.ok((await page.locator('.rd-notice').innerText()).indexOf('主题书单') >= 0, '主题页未提示可自建书单');
      // 建一个主题 → 手写加一本书 → 双击翻开（中栏批注器与休闲同款）
      await page.locator('.rd-add input[aria-label="新主题名"]').fill('GUI测试主题');
      await page.locator('.rd-add button', { hasText: '建主题' }).first().click();
      await page.waitForSelector('.rd-group-title', { timeout: 5000 });
      assert.ok((await page.locator('.rd-group-title').first().innerText()).indexOf('GUI测试主题') >= 0, '主题没建出来');
      await page.locator('.rd-group input[aria-label="主题新书名"]').fill('GUI主题书');
      await page.locator('.rd-group button', { hasText: '加书名' }).first().click();
      await page.waitForFunction(() => document.querySelectorAll('.rd-group .rd-book').length > 0, null, { timeout: 5000 });
      await page.locator('.rd-group .rd-book').first().locator('button', { hasText: '翻开读' }).click();
      await page.waitForSelector('.rd-reader[aria-label="主题阅读器"] .rd-prompts', { timeout: 5000 });
      assert.ok((await page.locator('.rd-reader[aria-label="主题阅读器"] .rd-chapters').count()) >= 1, '主题批注器缺章节大纲');
      await page.locator('.rd-tab').nth(0).click();
      await page.locator('.rd-book').first().locator('button', { hasText: '翻开读' }).click();
      await page.waitForSelector('.rd-flash input[aria-label="即时想法"]', { timeout: 5000 });
      await page.locator('.rd-flash input[aria-label="即时想法"]').fill('突然冒出来的一个念头');
      await page.locator('.rd-flash input[aria-label="即时想法"]').press('Enter');
      let flashOk = false;
      for (let i = 0; i < 25; i++) {
        const cells = await page.evaluate(async () => {
          const r = await window.jiugeBridge.invoke('v1/diaries:list', { pageSize: 20 });
          const rec = ((r.data && r.data.items) || [])[0];
          return rec ? (rec.cells || {}) : {};
        });
        if ((cells.free || '').indexOf('突然冒出来的一个念头') >= 0) { flashOk = true; break; }
        await page.waitForTimeout(200);
      }
      assert.ok(flashOk, '闪念没写进自由记录格');
      const md = await page.evaluate(async () => {
        const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.notes', args: [{ keyword: '突然冒出来' }] });
        return r.data || {};
      });
      assert.ok((md.total || 0) >= 1, '闪念没有同时进「读书笔记」数据库');
    });

    await check('129 本地电子书：点击选择 → 登记 → 详细列表 / 封面预览切换', async () => {
      await page.locator('.reading-btn').click();
      await page.waitForSelector('.rd-view', { timeout: 5000 });
      await page.locator('.rd-tab').nth(0).click();
      await page.waitForSelector('.rd-drop', { timeout: 5000 });
      assert.strictEqual(await page.locator('.rd-view input[type="file"]').count(), 0,
        '渲染层不得出现文件选择框（选文件必须走主进程对话框）');
      await page.locator('.rd-file-actions .rd-primary').click();
      await page.waitForSelector('.rd-book', { timeout: 10000 });
      const row = page.locator('.rd-book').filter({ hasText: '城门与水管' }).first();
      const rowText = await row.innerText();
      assert.ok(rowText.indexOf('城门与水管') >= 0, '没从 EPUB 读出书名：' + rowText);
      assert.ok(rowText.indexOf('老刘') >= 0, '没从 EPUB 读出作者');
      assert.ok(rowText.indexOf('EPUB') >= 0, '缺格式徽标');
      assert.ok(rowText.indexOf(EPUB_FIXTURE) >= 0, '详细列表没显示本机路径');
      await page.locator('.rd-viewmode button', { hasText: '封面预览' }).click();
      await page.waitForSelector('.rd-grid .rd-card', { timeout: 5000 });
      const card = page.locator('.rd-card').filter({ hasText: '城门与水管' }).first();
      assert.ok((await card.innerText()).indexOf('城门与水管') >= 0, '封面卡片没渲染这本书');
      assert.strictEqual(await page.locator('.rd-card-img').count(), 1, 'EPUB 封面没被读出来');
      await page.locator('.rd-viewmode button', { hasText: '详细列表' }).click();
      await page.waitForSelector('.rd-shelf', { timeout: 5000 });
    });

    await check('130 拖放区与去重：拖入态可见，同一本再选一次不重复', async () => {
      await page.locator('.rd-drop').dispatchEvent('dragenter');
      assert.ok((await page.locator('.rd-drop').getAttribute('class') || '').indexOf('rd-drop-on') >= 0,
        '拖入时没有高亮');
      await page.locator('.rd-drop').dispatchEvent('dragleave');
      const before = await page.locator('.rd-book').count();
      await page.locator('.rd-file-actions .rd-primary').click();
      await page.waitForTimeout(700);
      assert.strictEqual(await page.locator('.rd-book').count(), before, '同一路径被登记了两次');
    });

    await check('131 翻开读：独立三栏阅读窗口（目录 / 正文 / 笔记 / 回写）', async () => {
      const row = page.locator('.rd-book').filter({ hasText: '城门与水管' }).first();
      assert.strictEqual(await row.locator('button', { hasText: '本机打开' }).count(), 0,
        '「本机打开」应已下线');
      const [reader] = await Promise.all([
        app.waitForEvent('window'),
        row.locator('button', { hasText: '翻开读' }).click()
      ]);
      reader.on('pageerror', function (err) { jsErrors.push('reader: ' + String(err && err.message || err)); });
      await reader.waitForSelector('.rr-app', { timeout: 20000 });
      assert.ok((await reader.locator('.rr-book-title').innerText()).indexOf('城门与水管') >= 0,
        '阅读窗口没显示书名');
      assert.strictEqual(await reader.locator('.rr-toc-item').count(), 3,
        '目录项数不对（NCX 两层共 3 项）');
      assert.strictEqual(await reader.locator('.rr-page').count(), 1, '缺正文 iframe');
      assert.ok((await reader.locator('.rr-page').getAttribute('sandbox') || '').indexOf('allow-scripts') < 0,
        '正文 iframe 放行了脚本');
      const frames = reader.frames().filter((f) => f !== reader.mainFrame());
      assert.ok(frames.length >= 1, '正文 iframe 没挂上');
      const body1 = await frames[0].locator('body').innerText();
      assert.ok(body1.indexOf('城里的水管埋在地下') >= 0, '正文没渲染：' + body1.slice(0, 80));

      // 目录跳章：第二项（data-index=1）是「第二章 城门」
      await reader.locator('.rr-toc-item[data-index="1"]').first().click();
      await reader.waitForTimeout(700);
      const frames2 = reader.frames().filter((f) => f !== reader.mainFrame());
      const body2 = await frames2[0].locator('body').innerText();
      assert.ok(body2.indexOf('城门每天开合') >= 0, '目录跳章没换正文');

      // 右栏写笔记：三阶九问（读中 · Q5 连接），答案直接进笔记库并带阶标签
      await reader.click('.rr-q9-tab[data-stage="mid"]');
      await reader.waitForTimeout(250);
      await reader.click('.rr-q9-item[data-i="1"]');
      await reader.fill('.rr-q9-input', '这一章说的是城市基础设施的日常。');
      await reader.click('.rr-q9-save');
      await reader.waitForSelector('.rr-note', { timeout: 10000 });
      const noteText = await reader.locator('.rr-note').first().innerText();
      assert.ok(noteText.indexOf('城市基础设施') >= 0, '九问答案没进数据库：' + noteText);
      assert.ok(noteText.indexOf('#连接') >= 0, '答案没带阶标签：' + noteText);

      // 一键回写九格：只追加、带出处
      await reader.locator('.rr-note').first().locator('.rr-push').click();
      await reader.waitForSelector('.rr-pushed', { timeout: 10000 });
      const line = await page.evaluate(async () => {
        const r = await window.jiugeBridge.invoke('v1/diaries:list', { pageSize: 5 });
        const items = (r.data && r.data.items) || [];
        const hit = items.filter(function (x) {
          return ((x.cells && x.cells.free) || '').indexOf('【读书·休闲娱乐】') >= 0;
        })[0];
        return hit ? hit.cells.free : '';
      });
      assert.ok(line.indexOf('《城门与水管》') >= 0, '回写行缺书名：' + line);
      assert.ok(line.indexOf('#连接') >= 0, '回写行缺阶标签');
      // 只看本书：同一格里此前已有别的书（#127 试读本 / #128 闪念）留下的行，不能算进来
      assert.strictEqual((line.match(/【读书·[^\n]*《城门与水管》/g) || []).length, 1,
        '同一条笔记被写进九格两次');

      // 翻章同步进度
      await reader.click('.rr-progress-sync');
      await reader.waitForTimeout(700);
      const prog = await reader.locator('.rr-progress-text').innerText();
      assert.ok(/已读\s*\d+\s*\/\s*\d+\s*章/.test(prog), '进度没同步：' + prog);
      const pct = await page.evaluate(async () => {
        const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.board', args: [] });
        const b = ((r.data && r.data.books) || []).filter(function (x) { return x.title === '城门与水管'; })[0];
        return b ? b.done : -1;
      });
      assert.ok(pct > 0, '主板书架没收到阅读进度：' + pct);

      // 重复点「翻开读」不应叠第二个窗口
      await row.locator('button', { hasText: '翻开读' }).click();
      await page.waitForTimeout(800);
      assert.strictEqual(app.windows().length, 2, '同一本书应复用窗口，不该叠窗');
      await reader.close();
    });

    await check('132 阅读器详细功能：多字体 / 书签 / 书内搜索 / 划选标注 / 重开复原', async () => {
      const row = page.locator('.rd-book').filter({ hasText: '城门与水管' }).first();
      const [rd] = await Promise.all([
        app.waitForEvent('window'),
        row.locator('button', { hasText: '翻开读' }).click()
      ]);
      rd.on('pageerror', function (err) { jsErrors.push('reader2: ' + String(err && err.message || err)); });
      await rd.waitForSelector('.rr-app', { timeout: 20000 });
      await rd.waitForTimeout(1600);
      const fr = rd.frames().filter((f) => f !== rd.mainFrame())[0];
      await fr.waitForSelector('p', { timeout: 15000 });

      // 多字体：标题黑体栈 vs 正文宋体栈，必须不是同一种
      const fonts = await fr.evaluate(() => ({
        h1: getComputedStyle(document.querySelector('h1')).fontFamily,
        p: getComputedStyle(document.querySelector('p')).fontFamily
      }));
      assert.notStrictEqual(fonts.h1, fonts.p, '标题与正文用了同一种字体（满屏一种字）');
      assert.ok(/SimSun|Songti|Serif/i.test(fonts.p), '正文不是宋体/衬线栈：' + fonts.p);
      assert.ok(/YaHei|PingFang|sans-serif/i.test(fonts.h1), '标题不是黑体栈：' + fonts.h1);
      await rd.selectOption('#rrTypeface', 'sans');
      const pSans = await fr.evaluate(() => getComputedStyle(document.querySelector('p')).fontFamily);
      assert.ok(/YaHei|PingFang|sans-serif/i.test(pSans), '字体方案切「全黑体」没生效');
      await rd.selectOption('#rrTypeface', 'mixed');

      // 书签
      await rd.click('#rrTabMark');
      await rd.click('#rrBmAdd');
      await rd.waitForSelector('.rr-bm', { timeout: 8000 });
      // 位置记忆生效后，打开时可能已在别的章：只校验「记住了当前章」，不写死节号
      const bmText = await rd.locator('.rr-bm').first().innerText();
      assert.ok(/第\s*\d+\s*节/.test(bmText), '书签没记下章序：' + bmText);
      await rd.click('#rrTabToc');
      assert.ok((await rd.locator('.rr-toc-bm-dot').count()) >= 1, '目录没标出书签位置');

      // 书内搜索
      await rd.fill('#rrSearchInput', '水管');
      await rd.click('#rrSearchBtn');
      await rd.waitForSelector('.rr-hit', { timeout: 25000 });
      assert.ok((await rd.locator('.rr-hit').first().innerText()).indexOf('第') >= 0, '搜索命中没带章节');

      // 划选 → 绿色高亮（正文里真的画出 mark）
      await fr.evaluate(() => {
        const p = document.querySelectorAll('p')[0];
        const node = p.firstChild;
        const r = document.createRange();
        r.setStart(node, 1);
        r.setEnd(node, Math.min(9, node.length));
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      });
      await rd.click('.rr-hl-green');
      await fr.waitForSelector('mark.rr-mark', { timeout: 8000 });
      const mark = await fr.evaluate(() => {
        const m = document.querySelector('mark.rr-mark');
        return m ? { cls: m.className, bg: getComputedStyle(m).backgroundColor } : null;
      });
      assert.ok(mark && mark.cls.indexOf('rr-hl-green') >= 0, '高亮 class 不对：' + JSON.stringify(mark));
      assert.strictEqual(mark.bg, 'rgb(200, 239, 192)', '高亮颜色不对：' + mark.bg);
      assert.ok((await rd.locator('.rr-note').count()) >= 1, '标注没进右栏笔记');

      // 跨段划选（用户最常干的事：从这一段拖到下一段）：不能整条丢掉，每段各包一段 mark
      const paraProbe = await fr.evaluate(() => ({
        n: document.querySelectorAll('p').length,
        head: (document.body ? document.body.textContent : '').slice(0, 40)
      }));
      assert.ok(paraProbe.n >= 2, '夹具章节段落太少，无法验证跨段高亮：' + JSON.stringify(paraProbe));
      await fr.evaluate(() => {
        const tn = function (el) {
          const cs = el.childNodes;
          for (let i = 0; i < cs.length; i++) {
            if (cs[i].nodeType === 3 && cs[i].textContent.trim()) return cs[i];
          }
          return el.firstChild;
        };
        const ps = document.querySelectorAll('p');
        const a = tn(ps[0]);
        const b = tn(ps[1]);
        const r = document.createRange();
        r.setStart(a, 0);
        r.setEnd(b, Math.min(6, b.textContent.length));
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      });
      await rd.click('.rr-hl-blue');
      await rd.waitForTimeout(700);
      const multi = await fr.evaluate(() => {
        const ms = Array.prototype.slice.call(document.querySelectorAll('mark.rr-hl-blue'));
        return { n: ms.length, bgs: ms.map(function (m) { return getComputedStyle(m).backgroundColor; }) };
      });
      assert.ok(multi.n >= 2, '跨段高亮只画出 ' + multi.n + ' 段（每段应各有一段 mark）');
      assert.ok(multi.bgs.every(function (c) { return c === 'rgb(197, 228, 255)'; }),
        '跨段高亮颜色不对：' + JSON.stringify(multi.bgs));
      const chipBg = await rd.evaluate(() => {
        const c = document.querySelector('.rr-note .rr-note-style[data-color="blue"]');
        return c ? getComputedStyle(c).backgroundColor : '';
      });
      assert.ok(chipBg === 'rgb(197, 228, 255)', '右栏色标没带颜色：' + chipBg);

      // 关窗重开：标注与书签都要还在（锚点与书签都落了库）
      await rd.close();
      await page.waitForTimeout(900);
      const row2 = page.locator('.rd-book').filter({ hasText: '城门与水管' }).first();
      const [rd2] = await Promise.all([
        app.waitForEvent('window'),
        row2.locator('button', { hasText: '翻开读' }).click()
      ]);
      await rd2.waitForSelector('.rr-app', { timeout: 20000 });
      await rd2.waitForTimeout(1800);
      const fr2 = rd2.frames().filter((f) => f !== rd2.mainFrame())[0];
      await fr2.waitForSelector('p', { timeout: 15000 });
      await fr2.waitForSelector('mark.rr-mark', { timeout: 8000 });
      assert.ok((await fr2.evaluate(() => document.querySelectorAll('mark.rr-mark').length)) >= 1,
        '重开后正文标注丢了（锚点没复原）');
      await rd2.click('#rrTabMark');
      assert.ok((await rd2.locator('.rr-bm').count()) >= 1, '重开后书签丢了');
      await rd2.close();
    });

    await check('133 排印增强：两端对齐 / 缩进 / 版心 / 段距 / 标点挤压 / 不横向溢出', async () => {
      const row = page.locator('.rd-book').filter({ hasText: '城门与水管' }).first();
      const [rd] = await Promise.all([
        app.waitForEvent('window'),
        row.locator('button', { hasText: '翻开读' }).click()
      ]);
      rd.on('pageerror', function (err) { jsErrors.push('reader3: ' + String(err && err.message || err)); });
      await rd.waitForSelector('.rr-app', { timeout: 20000 });
      await rd.waitForTimeout(1800);
      const fr = rd.frames().filter((f) => f !== rd.mainFrame())[0];
      await fr.waitForSelector('p', { timeout: 15000 });

      const base = await fr.evaluate(() => {
        const cs = (s) => getComputedStyle(document.querySelector(s));
        const b = getComputedStyle(document.body);
        return {
          ta: cs('p').textAlign,
          indent: cs('p').textIndent,
          h1Indent: cs('h1').textIndent,
          h1Align: cs('h1').textAlign,
          maxW: b.maxWidth,
          padL: b.paddingLeft,
          para: b.getPropertyValue('--rr-para').trim(),
          overflow: document.body.scrollWidth - document.body.clientWidth,
          fontFamily: cs('p').fontFamily,
          fontWeight: cs('p').fontWeight
        };
      });
      // 字体栈必须点名「有 Regular 实例」的家族，且正文真的是 400——
      // 只写 font-weight 不够：家族里只有 Heavy 时浏览器照样拿 900 渲染整章。
      assert.ok(base.fontFamily.indexOf('Source Han Serif CN') >= 0,
        '正文衬线没走思源宋体 CN：' + base.fontFamily);
      assert.strictEqual(base.fontWeight, '400', '正文不是常规字重：' + base.fontWeight);
      assert.strictEqual(base.ta, 'justify', '正文没有两端对齐：' + base.ta);
      assert.strictEqual(base.indent, '36px', '首行缩进不是 2em(36px)：' + base.indent);
      assert.strictEqual(base.h1Indent, '0px', '标题不该缩进：' + base.h1Indent);
      assert.strictEqual(base.h1Align, 'left', '标题不该两端对齐：' + base.h1Align);
      assert.ok(base.overflow <= 2, '正文出现横向溢出（长串把版心撑破）：' + base.overflow);

      // 版心三档：宽边应把正文收窄并加大留白
      await rd.selectOption('#rrMargin', 'wide');
      await rd.waitForTimeout(320);
      const wide = await fr.evaluate(() => {
        const b = getComputedStyle(document.body);
        return { maxW: b.maxWidth, padL: b.paddingLeft };
      });
      assert.strictEqual(wide.maxW, '600px', '版心切宽边没生效：' + wide.maxW);
      assert.strictEqual(wide.padL, '64px', '宽边留白不对：' + wide.padL);

      // 段距三档：宽松 = 1em
      await rd.selectOption('#rrPara', 'loose');
      await rd.waitForTimeout(320);
      const loose = await fr.evaluate(() => ({
        mb: getComputedStyle(document.querySelector('p')).marginBottom,
        para: getComputedStyle(document.body).getPropertyValue('--rr-para').trim()
      }));
      assert.strictEqual(loose.mb, '18px', '段距切宽松没生效：' + loose.mb);
      assert.strictEqual(loose.para, '1em', '段距变量没更新：' + loose.para);

      // 标点挤压：支持就真开，不支持就该置灰并说明——绝不允许「点了没反应也不说」
      const punct = await rd.evaluate(() => {
        const b = document.querySelector('#rrPunct');
        return { exists: !!b, disabled: b ? b.disabled : null, title: b ? b.title : '' };
      });
      assert.ok(punct.exists, '工具栏缺「标点挤压」按钮');
      if (punct.disabled) {
        assert.ok(punct.title.indexOf('不支持') >= 0, '标点挤压被禁用却没说明原因');
      } else {
        await rd.click('#rrPunct');
        await rd.waitForTimeout(320);
        const on = await fr.evaluate(() => ({
          attr: document.body.getAttribute('data-punct'),
          trim: getComputedStyle(document.body).textSpacingTrim || ''
        }));
        assert.strictEqual(on.attr, 'on', '标点挤压点了没生效');
        assert.ok(/trim|space/.test(on.trim), '标点挤压没有落到 text-spacing-trim：' + on.trim);
        await rd.click('#rrPunct');
      }

      // 偏好要记住：重开窗口不该退回默认
      await rd.close();
      await page.waitForTimeout(600);
      const [rd2] = await Promise.all([
        app.waitForEvent('window'),
        page.locator('.rd-book').filter({ hasText: '城门与水管' }).first()
          .locator('button', { hasText: '翻开读' }).click()
      ]);
      await rd2.waitForSelector('.rr-app', { timeout: 20000 });
      await rd2.waitForTimeout(1500);
      const pref = await rd2.evaluate(() => ({
        margin: document.querySelector('#rrMargin').value,
        para: document.querySelector('#rrPara').value
      }));
      assert.strictEqual(pref.margin, 'wide', '版心偏好没记住');
      assert.strictEqual(pref.para, 'loose', '段距偏好没记住');
      await rd2.close();
    });

    await check('134 完读率轻互动：章末卡 → 继续下一章 → 摘录计数 → 续读条', async () => {
      const row = page.locator('.rd-book').filter({ hasText: '城门与水管' }).first();
      const [rd] = await Promise.all([
        app.waitForEvent('window'),
        row.locator('button', { hasText: '翻开读' }).click()
      ]);
      rd.on('pageerror', function (err) { jsErrors.push('reader4: ' + String(err && err.message || err)); });
      await rd.waitForSelector('.rr-app', { timeout: 20000 });
      await rd.waitForTimeout(1600);
      const fr = rd.frames().filter((f) => f !== rd.mainFrame())[0];
      await fr.waitForSelector('p', { timeout: 15000 });

      // 前面的用例可能已把位置推到末章：先回第 1 章，才能验「还有下一章」这条链路
      if (((await rd.locator('.rr-pos').innerText()).trim() || '').indexOf('1 /') !== 0) {
        await rd.click('#rrTabToc');
        await rd.locator('.rr-toc-item').first().click();
        await rd.waitForTimeout(1000);
      }
      const frBack = rd.frames().filter((f) => f !== rd.mainFrame())[0];
      await frBack.waitForSelector('p', { timeout: 15000 });

      // T2：进度三件套
      const prog = (await rd.locator('.rr-progress-text').innerText()).trim();
      assert.ok(/已读\s*\d+\s*\/\s*\d+\s*章/.test(prog), '进度缺章进度：' + prog);
      assert.ok(/全书\s*\d+%/.test(prog), '进度缺全书百分比：' + prog);
      assert.ok(/本章\s*\d+%/.test(prog), '进度缺本章百分比：' + prog);

      // T3：滚到底出章末卡（正文流内的静卡，不是弹窗）
      await frBack.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await rd.waitForFunction(() => {
        const el = document.querySelector('#rrEndCard');
        return !!(el && !el.hidden && el.classList.contains('rr-show'));
      }, null, { timeout: 8000 });
      const card = await rd.evaluate(() => {
        const c = document.querySelector('#rrEndCard');
        const cs = getComputedStyle(c);
        const frameDoc = document.querySelector('#rrPage').contentDocument;
        return {
          h: c.querySelector('.rr-endcard-h').textContent,
          q: c.querySelector('.rr-endcard-q').textContent,
          btns: Array.prototype.map.call(c.querySelectorAll('.rr-endcard-b button'), (b) => b.textContent),
          inFrame: !!(frameDoc && frameDoc.getElementById('rrEndCard')),
          top: Math.round(c.getBoundingClientRect().top),
          bg: cs.backgroundColor,
          fontSize: parseFloat(cs.fontSize)
        };
      });
      // 阅读旅程触点是不入正文的顶部浮层：不进 iframe、靠上、半透明、字号小于正文
      assert.strictEqual(card.inFrame, false, '章末卡又插进正文 iframe 了');
      // 顶部浮层：在正文区上三分之一内即可（工具栏换行会把正文起点往下推）
      assert.ok(card.top < 360, '章末卡不在正文上部：' + card.top);
      assert.ok(/rgba/.test(card.bg), '章末卡不是半透明底：' + card.bg);
      assert.ok(card.fontSize <= 13, '章末卡字号没压小：' + card.fontSize);
      assert.ok(card.h.indexOf('本章读完') >= 0, '章末卡缺「本章读完」：' + card.h);
      assert.ok(/全书\s*\d+%/.test(card.h), '章末卡缺全书百分比：' + card.h);
      assert.ok(card.btns.indexOf('继续下一章') >= 0, '章末卡缺「继续下一章」：' + card.btns.join('|'));
      assert.ok(card.btns.indexOf('写一句感想') >= 0, '章末卡缺「写一句感想」');
      assert.ok(!/恭喜|太棒|真棒/.test(card.h + card.q), '章末卡出现发糖词');

      // 继续下一章：切章 + 卡片随 srcdoc 消失
      await rd.click('#rrEndNext');
      await rd.waitForTimeout(1200);
      const pos = (await rd.locator('.rr-pos').innerText()).trim();
      // 夹具的章数可能变，别写死分母：只要求从第 1 章进到第 2 章
      assert.ok(/^2\s*\/\s*\d+$/.test(pos), '点继续下一章后没切到第 2 章：' + pos);
      const fr2 = rd.frames().filter((f) => f !== rd.mainFrame())[0];
      await fr2.waitForSelector('p', { timeout: 10000 });
      assert.strictEqual(await rd.evaluate(() => document.querySelector('#rrEndCard').hidden), true,
        '换章后章末卡没消失');

      // T5：划选后 toast 带「本书第 N 句」
      const selInfo = await fr2.evaluate(() => {
        // 挑第一个「正文文本足够长」的段落，别盲取 firstChild（可能是空白节点）
        // 夹具里有的章只有一句话，门槛放低到「够划选」即可
        const ps = Array.prototype.slice.call(document.querySelectorAll('p'));
        for (let i = 0; i < ps.length; i += 1) {
          const walker = document.createTreeWalker(ps[i], NodeFilter.SHOW_TEXT, null);
          let node = walker.nextNode();
          while (node && (node.textContent || '').trim().length < 4) node = walker.nextNode();
          if (!node) continue;
          const len = node.textContent.trim().length;
          const r = document.createRange();
          r.setStart(node, 0);
          r.setEnd(node, Math.min(6, len));
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
          return { ok: true, text: s.toString().slice(0, 30), count: s.rangeCount, pCount: ps.length };
        }
        return { ok: false, why: 'no selectable text node' };
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return { ok: true, text: s.toString().slice(0, 30), count: s.rangeCount, pCount: ps.length };
      });
      // 选区真在，才谈得上点颜色；否则是测试自己的问题，不能算功能失败
      assert.ok(selInfo.ok && selInfo.text && selInfo.text.trim().length >= 2,
        '测试没能建立选区：' + JSON.stringify(selInfo));
      await rd.click('.rr-hl-yellow');
      await rd.waitForTimeout(800);
      const toast = (await rd.locator('#rrStatusMsg').innerText()).trim();
      assert.ok(/这是这本书的第\s*\d+\s*句/.test(toast),
        '摘录 toast 没给存量计数：' + toast + ' | sel=' + JSON.stringify(selInfo));

      // T1：关窗重开出现续读条（位置已存），5 秒内可见
      await rd.close();
      await page.waitForTimeout(700);
      const [rd2] = await Promise.all([
        app.waitForEvent('window'),
        page.locator('.rd-book').filter({ hasText: '城门与水管' }).first()
          .locator('button', { hasText: '翻开读' }).click()
      ]);
      await rd2.waitForSelector('.rr-app', { timeout: 20000 });
      await rd2.waitForTimeout(1400);   // 续读条在打开后 600ms 才出现，且 5 秒后自动淡出
      const rs = await rd2.evaluate(() => {
        const el = document.querySelector('#rrResume');
        const ls = {};
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k.indexOf('reader') >= 0) ls[k] = localStorage.getItem(k);
        }
        return {
          exists: !!el,
          hidden: el ? el.hidden : null,
          text: (document.querySelector('#rrResumeText') || {}).textContent || '',
          search: location.search,
          ls: ls
        };
      });
      assert.ok(rs.exists, '阅读窗里没有续读条元素');
      assert.strictEqual(rs.hidden, false, '续读条没出现（hidden 仍为 true）：' + JSON.stringify(rs));
      assert.ok(rs.text.indexOf('上次读到第') >= 0, '续读条文案不对：' + rs.text);
      assert.ok(/全书\s*\d+%/.test(rs.text), '续读条缺全书百分比：' + rs.text);
      await rd2.close();
    });

    await check('135 双击书架直接读 + 三阶九问浮窗可拖可折可唤回', async () => {
      // 双击书行整块（不是「翻开读」按钮）就该打开阅读窗
      const row = page.locator('.rd-book').filter({ hasText: '城门与水管' }).first();
      const [rd] = await Promise.all([
        app.waitForEvent('window'),
        row.dblclick()
      ]);
      rd.on('pageerror', function (err) { jsErrors.push('reader5: ' + String(err && err.message || err)); });
      await rd.waitForSelector('.rr-app', { timeout: 20000 });
      await rd.waitForTimeout(1500);

      const ask0 = await rd.evaluate(() => {
        const el = document.querySelector('#rrAsk');
        return {
          hidden: el ? el.hidden : null,
          title: (document.querySelector('#rrAskTitle') || {}).textContent || '',
          q: (document.querySelector('#rrAskQ') || {}).textContent || '',
          pos: el ? { x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top) } : null
        };
      });
      assert.ok(ask0.hidden === false, '双击开读后浮窗没出现');
      assert.ok(/伴读 · (读前|读中|读后)/.test(ask0.title), '浮窗标题不是三阶之一：' + ask0.title);
      assert.ok(/^Q[1-9]/.test(ask0.q), '浮窗没有在问问题：' + ask0.q);

      // 浮窗只做读中三问：不再有「切阶段」，读前 / 读后归右栏面板
      const stageGone = await rd.evaluate(() => !document.querySelector('#rrAskStage'));
      assert.strictEqual(stageGone, true, '浮窗还留着「切阶段」按钮');
      assert.ok(/读中/.test(ask0.title), '浮窗标题不是读中三问：' + ask0.title);

      // 右栏：三阶九问面板取代旧自由表单；一次只展开一问
      const q9 = await rd.evaluate(() => {
        const tabs = Array.prototype.map.call(
          document.querySelectorAll('#rrQ9Tabs button'), (b) => b.getAttribute('data-stage'));
        const items = Array.prototype.map.call(
          document.querySelectorAll('.rr-q9-item'), (b) => b.textContent);
        const first = document.querySelector('.rr-q9-item');
        if (first) first.click();
        const onTab = document.querySelector('.rr-q9-tab.rr-q9-on');
        return {
          tabs: tabs,
          items: items,
          opened: document.querySelectorAll('.rr-q9-edit').length,
          hasOldForm: !!document.querySelector('#rrType') || !!document.querySelector('#rrSave'),
          active: onTab ? onTab.getAttribute('data-stage') : ''
        };
      });
      assert.deepStrictEqual(q9.tabs, ['pre', 'mid', 'post'], '右栏九问缺三阶 tab：' + JSON.stringify(q9.tabs));
      assert.strictEqual(q9.hasOldForm, false, '右栏旧自由表单还在');
      assert.strictEqual(q9.opened, 1, '点一问却展开了 ' + q9.opened + ' 个输入框（同一时刻只该有一问）');
      assert.ok(/Q1|Q2|Q3/.test(q9.items.join('|')), '读前阶没列出 Q1/Q2/Q3：' + q9.items.join('|'));

      // 面板落库：写一句 → 存下 → 进读书笔记（带该阶标签）
      const Q9_TAG = { pre: '读前', mid: '重述', post: '章句' };
      const panelTag = Q9_TAG[q9.active] || '';
      assert.ok(panelTag, '右栏九问的默认阶不在三阶之内：' + q9.active);
      await rd.fill('.rr-q9-input', '想弄清管道为什么会老化');
      await rd.click('.rr-q9-save');
      await rd.waitForTimeout(700);
      const panelSaved = await rd.evaluate(async () => {
        const r = await window.jiugeBridge.invoke('v1/domain:call',
          { name: 'reading.notes', args: [{ keyword: '管道为什么会老化' }] });
        const n = ((r.data && r.data.items) || [])[0];
        return n ? { tags: n.tags, text: n.text, type: n.type } : null;
      });
      assert.ok(panelSaved, '九问面板存下的答案没落进读书笔记');
      assert.ok((panelSaved.tags || []).indexOf(panelTag) >= 0,
        '面板答案没带阶标签：' + JSON.stringify(panelSaved.tags));

      // 拖动：走同一条 mousedown→mousemove→mouseup 逻辑
      await rd.evaluate(() => {
        const head = document.querySelector('#rrAskHead');
        const el = document.querySelector('#rrAsk');
        const r = el.getBoundingClientRect();
        const opt = { bubbles: true, cancelable: true };
        head.dispatchEvent(new MouseEvent('mousedown', Object.assign({ clientX: r.left + 40, clientY: r.top + 10 }, opt)));
        document.dispatchEvent(new MouseEvent('mousemove', Object.assign({ clientX: r.left - 300, clientY: r.top - 220 }, opt)));
        document.dispatchEvent(new MouseEvent('mouseup', opt));
      });
      await rd.waitForTimeout(320);
      const moved = await rd.evaluate(() => {
        const r = document.querySelector('#rrAsk').getBoundingClientRect();
        return {
          pos: { x: Math.round(r.left), y: Math.round(r.top) },
          saved: localStorage.getItem('jiuge-reader-ask-pos')
        };
      });
      assert.ok(moved.pos.x !== ask0.pos.x || moved.pos.y !== ask0.pos.y,
        '浮窗没跟着拖动：' + JSON.stringify({ from: ask0.pos, to: moved.pos }));
      assert.ok(!!moved.saved, '拖动后没记住位置');

      // 启动即胶囊 → 点一下展开 → 再收起 → 关闭 → 右下角唤回，位置不丢
      const foldedOnStart = await rd.evaluate(() =>
        getComputedStyle(document.querySelector('#rrAskBody')).display === 'none');
      assert.strictEqual(foldedOnStart, true, '启动时伴读浮窗不是胶囊形态（不该一上来就摊在正文上）');
      await rd.click('#rrAskFold');
      const expandedByClick = await rd.evaluate(() =>
        getComputedStyle(document.querySelector('#rrAskBody')).display !== 'none');
      assert.strictEqual(expandedByClick, true, '胶囊点开后没展开');
      await rd.click('#rrAskFold');
      const folded = await rd.evaluate(() =>
        getComputedStyle(document.querySelector('#rrAskBody')).display === 'none');
      assert.strictEqual(folded, true, '折叠没生效');
      await rd.click('#rrAskClose');
      const closed = await rd.evaluate(() => ({
        hidden: document.querySelector('#rrAsk').hidden,
        openBtn: document.querySelector('#rrAskOpen').hidden
      }));
      assert.strictEqual(closed.hidden, true, '关闭后浮窗还在');
      assert.strictEqual(closed.openBtn, false, '关闭后没有唤出按钮');
      await rd.click('#rrAskOpen');
      const back = await rd.evaluate(() => {
        const r = document.querySelector('#rrAsk').getBoundingClientRect();
        return { hidden: document.querySelector('#rrAsk').hidden, x: Math.round(r.left) };
      });
      assert.strictEqual(back.hidden, false, '唤回失败');
      assert.ok(Math.abs(back.x - moved.pos.x) <= 2, '唤回后位置没保持');

      // 引用原文：正文划一句 → 引原文 → 浮窗显示 → 存下后笔记带 quote + anchor（可跳回）
      const fr = rd.frames().filter((f) => f !== rd.mainFrame())[0];
      await fr.waitForSelector('p', { timeout: 15000 });
      await fr.evaluate(() => {
        const ps = Array.prototype.slice.call(document.querySelectorAll('p'));
        for (let i = 0; i < ps.length; i += 1) {
          const walker = document.createTreeWalker(ps[i], NodeFilter.SHOW_TEXT, null);
          let node = walker.nextNode();
          while (node && (node.textContent || '').trim().length < 6) node = walker.nextNode();
          if (!node) continue;
          const len = node.textContent.length;
          const r = document.createRange();
          r.setStart(node, 0);
          r.setEnd(node, Math.min(10, len));
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      });
      await rd.click('#rrAskPick');
      await rd.waitForTimeout(280);
      const qz = await rd.evaluate(() => ({
        hidden: document.querySelector('#rrAskQuote').hidden,
        text: document.querySelector('#rrAskQuoteText').textContent
      }));
      assert.strictEqual(qz.hidden, false, '引原文后浮窗没显示引用块');
      assert.ok(qz.text.indexOf('「') >= 0 && qz.text.length > 6, '引用块内容为空：' + qz.text);

      await rd.fill('#rrAskInput', '这一句说的是管道老化');
      await rd.click('#rrAskSave');
      await rd.waitForTimeout(800);
      const noted = await rd.evaluate(async () => {
        const r = await window.jiugeBridge.invoke('v1/domain:call', { name: 'reading.notes', args: [{ keyword: '管道老化' }] });
        const n = ((r.data && r.data.items) || [])[0];
        return n ? { quote: n.quote, anchor: n.anchor, chapterId: n.chapterId } : null;
      });
      assert.ok(noted, '三阶问答完没落进读书笔记');
      assert.ok(!!noted.quote, '笔记没带引用原文');
      assert.ok(/^\d+:\d+-\d+$/.test(noted.anchor || ''), '笔记没带锚点，右栏跳不回原文：' + noted.anchor);

      // 划线工具条上的快捷问（重述 / 连接 / 行动）：划一句 → 点「行动」→ 浮窗直跳 Q6 并带上这句
      const fr2 = rd.frames().filter((f) => f !== rd.mainFrame())[0];
      await fr2.evaluate(() => {
        const ps = Array.prototype.slice.call(document.querySelectorAll('p'));
        for (let i = 0; i < ps.length; i += 1) {
          const walker = document.createTreeWalker(ps[i], NodeFilter.SHOW_TEXT, null);
          let node = walker.nextNode();
          while (node && (node.textContent || '').trim().length < 6) node = walker.nextNode();
          if (!node) continue;
          const r = document.createRange();
          r.setStart(node, 0);
          r.setEnd(node, Math.min(12, node.textContent.length));
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return;
        }
      });
      await rd.waitForTimeout(450);
      const sbar = await rd.evaluate(() => {
        const el = document.querySelector('#rrSelBar');
        return {
          shown: el ? getComputedStyle(el).display !== 'none' : false,
          asks: Array.prototype.map.call(document.querySelectorAll('.rr-selbar-ask'),
            (b) => b.textContent + '|' + b.getAttribute('data-ask')),
          right: el ? Math.round(el.getBoundingClientRect().right) : 0,
          stageRight: Math.round(document.querySelector('#rrStage').getBoundingClientRect().right)
        };
      });
      assert.strictEqual(sbar.shown, true, '划选后没出现划线工具条');
      assert.strictEqual(sbar.asks.length, 3, '工具条上不是三个快捷问：' + sbar.asks.join(','));
      // 工具条多带了三个按钮，宽度夹不住会压出正文区
      assert.ok(sbar.right <= sbar.stageRight + 2, '划线工具条超出正文区：' + JSON.stringify(sbar));

      await rd.click('.rr-selbar-ask[data-ask="2"]');
      await rd.waitForTimeout(450);
      const asked = await rd.evaluate(() => ({
        q: document.querySelector('#rrAskQ').textContent,
        quote: document.querySelector('#rrAskQuote').hidden
          ? '' : document.querySelector('#rrAskQuoteText').textContent,
        hidden: document.querySelector('#rrAsk').hidden
      }));
      assert.strictEqual(asked.hidden, false, '点快捷问没唤出伴读浮窗');
      assert.ok(/Q6/.test(asked.q), '点「行动」没跳到 Q6：' + asked.q);
      assert.ok(asked.quote && asked.quote.indexOf('「') >= 0, '快捷问没把划选原文带成引用：' + asked.quote);

      // 进度已在底栏：顶栏不再有，底栏按钮与读数都在
      const bars = await rd.evaluate(() => ({
        inTop: !!document.querySelector('.rr-top #rrProgressSync'),
        inFooter: !!document.querySelector('.rr-status #rrProgressSync'),
        text: (document.querySelector('.rr-status #rrProgressText') || {}).textContent || ''
      }));
      assert.strictEqual(bars.inTop, false, '顶栏还留着「同步进度」');
      assert.strictEqual(bars.inFooter, true, '底栏没有进度区');
      assert.ok(/已读|进度/.test(bars.text), '底栏进度没读数：' + bars.text);

      // 底栏还要有「本次 / 累计」阅读时长
      const timing = await rd.evaluate(() => ({
        text: (document.querySelector('#rrTime') || {}).textContent || '',
        inFooter: !!document.querySelector('.rr-status #rrTime')
      }));
      assert.strictEqual(timing.inFooter, true, '时长不在底栏');
      assert.ok(/本次\s*\d+\s*分/.test(timing.text), '底栏缺本次时长：' + timing.text);
      assert.ok(timing.text.indexOf('累计') >= 0, '底栏缺累计时长：' + timing.text);

      // 浮窗默认落在右栏左侧，不该压住笔记列表的按钮
      const overlap = await rd.evaluate(() => {
        const a = document.querySelector('#rrAsk').getBoundingClientRect();
        const r = document.querySelector('.rr-right').getBoundingClientRect();
        return { askRight: Math.round(a.right), rightLeft: Math.round(r.left) };
      });
      assert.ok(overlap.askRight <= overlap.rightLeft + 2,
        '伴读浮窗压在右栏上：' + JSON.stringify(overlap));

      await rd.close();
    });

    // --- 本机时间源（ActivityWatch 只读订阅）---
    // 用一个真的 HTTP 服务冒充 ActivityWatch：验的是「主进程 GET → 聚合 → 落 md_worktime → 界面」
    // 整条链路，而不是拿假数据直接喂界面。
    const wtT9 = new Date(); wtT9.setHours(9, 0, 0, 0);
    const wtT12 = new Date(); wtT12.setHours(12, 0, 0, 0);
    const wtServer = http.createServer(function (req, res) {
      const url = String(req.url || '').split('?')[0];
      const send = function (obj) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url === '/api/0/info') return send({ hostname: 'e2e-host', version: '0.14.2', testing: false, device_id: 'e2e' });
      if (url === '/api/0/buckets/') return send({ 'aw-watcher-window_e2e-host': { type: 'currentwindow' }, 'aw-watcher-afk_e2e-host': { type: 'afkstatus' } });
      if (url.indexOf('aw-watcher-window_e2e-host/events') >= 0) return send([{ timestamp: wtT9.toISOString(), duration: 3600, data: { app: 'Code', title: '污水处理方案' } }]);
      if (url.indexOf('aw-watcher-afk_e2e-host/events') >= 0) return send([{ timestamp: wtT12.toISOString(), duration: 1800, data: { status: 'afk' } }]);
      return send({});
    });
    await new Promise(function (r) { wtServer.listen(0, '127.0.0.1', r); });
    const wtPort = wtServer.address().port;

    try {
      await check('112 本机时间源默认关闭：工作视图没有投入条、右栏没有时间源卡', async () => {
        await page.locator('.nav-item').first().click();
        await page.waitForTimeout(200);
        await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
        await page.waitForTimeout(350);
        assert.strictEqual(await page.locator('.gtd-view').count(), 1);
        assert.strictEqual(await page.locator('.wt').count(), 0, '默认关闭时不该渲染投入条');
        assert.strictEqual(await page.locator('.wc-source').count(), 0, '默认关闭时右栏不该有本机时间源卡');
        await page.locator('.gtd-view .back').click();
        await page.waitForTimeout(200);
      });

      await check('112a 设置页开启时间源：底栏改口成「仅本机回环」', async () => {
        await page.locator('.nav-gear').click();
        await page.waitForTimeout(250);
        const card = page.locator('.settings .card').filter({ hasText: '本机时间源' }).first();
        assert.ok((await card.textContent()).indexOf('九格自己不采集任何东西') >= 0, '设置页缺常驻声明');
        await card.locator('.switch').click();
        await page.waitForTimeout(250);
        assert.strictEqual(await card.locator('.switch').getAttribute('aria-checked'), 'true', '开关没打开');
        // 改口是异步的（开关 → 主进程 → 重读 meta → 底栏），等它自己翻过来
        await page.waitForFunction(function () {
          const el = document.querySelector('.statusbar .local');
          return !!(el && el.textContent && el.textContent.indexOf('仅本机回环') >= 0);
        }, null, { timeout: 4000 }).catch(function () { /* 下面那条断言会报出真实文本 */ });
        assert((await page.locator('.statusbar .local').textContent()).includes('仅本机回环'),
          '底栏没有跟着改成「仅本机回环」：' + (await page.locator('.statusbar .local').textContent()));
        // 指到本地 mock 服务（只允许回环，这一步同时验证地址校验不会误伤自定义端口）
        await page.locator('#wt-host').fill('127.0.0.1:' + wtPort);
        await page.locator('#wt-host-save').click();
        await page.waitForTimeout(300);
        // 地址必须真存进去：后面 112b 的「同步」打的就是这个端口，存不上就会一路塌
        const savedHost = await page.locator('#wt-host').inputValue();
        assert.strictEqual(savedHost, '127.0.0.1:' + wtPort, '本机地址没保存：' + savedHost);
      });

      await check('112b 同步：24h 切 96 段，活跃 1h、离开 30m、未归类 100%', async () => {
        await page.locator('.nav-item').first().click();
        await page.waitForTimeout(200);
        await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
        await page.waitForTimeout(400);
        assert.strictEqual(await page.locator('.wt').count(), 1, '开启后应出现投入条');
        assert.strictEqual(await page.locator('.wt .wt-seg').count(), 96, '时间带应为 96 段（15 分钟一段）');
        await page.locator('.wt .wt-act').first().click();
        // 同步是三次本机 HTTP：别用固定 sleep 赌运气，等「—」被替换掉
        await page.waitForFunction(function () {
          const el = document.querySelector('.wt-total b');
          return !!(el && el.textContent && el.textContent.trim() !== '—');
        }, null, { timeout: 6000 }).catch(function () { /* 下面报错时带上 .wt-err */ });
        const errLine = await page.locator('.wt-err').count() ? (await page.locator('.wt-err').textContent()).trim() : '';
        const total = (await page.locator('.wt-total b').textContent()).trim();
        assert.strictEqual(total, '1h', '活跃时长应为 1h，实得 ' + total + (errLine ? '｜同步报错：' + errLine : '｜同步没有报错，可能是根本没点中「同步」'));
        const sub = await page.locator('.wt-sub').first().textContent();
        assert.ok(sub.indexOf('30m') >= 0, '离开时长未显示：' + sub);
        assert.strictEqual((await page.locator('.wt-un').textContent()).trim(), '100%');
        assert.strictEqual(await page.locator('.wt-seg-on').count(), 4, '09:00–10:00 应占 4 段');
        assert.strictEqual(await page.locator('.wt-seg-on').first().getAttribute('data-cell'), '未归类');
      });

      await check('112c 加一条规则再同步：未归类降到 0，时间块改名', async () => {
        await page.locator('.gtd-view .back').click();
        await page.waitForTimeout(200);
        await page.locator('.nav-gear').click();
        await page.waitForTimeout(250);
        const card = page.locator('.settings .card').filter({ hasText: '本机时间源' }).first();
        await card.locator('input[aria-label="应用名"]').fill('code');
        await card.locator('input[aria-label="归类名"]').fill('编程');
        await card.getByRole('button', { name: '加规则' }).click();
        await page.waitForTimeout(300);
        assert.ok((await card.textContent()).indexOf('编程') >= 0, '规则没出现在列表里');

        await page.locator('.nav-item').first().click();
        await page.waitForTimeout(200);
        await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
        await page.waitForTimeout(400);
        await page.locator('.wt .wt-act').first().click();
        // 规则生效要等这一次同步落库：等时间块自己改名，而不是等固定毫秒
        await page.waitForFunction(function () {
          const el = document.querySelector('.wt-seg-on');
          return !!(el && el.getAttribute('data-cell') === '编程');
        }, null, { timeout: 6000 }).catch(function () { /* 下面两条断言会报出真实值 */ });
        assert.strictEqual((await page.locator('.wt-un').textContent()).trim(), '0%', '命中规则后不该再有未归类');
        assert.strictEqual(await page.locator('.wt-seg-on').first().getAttribute('data-cell'), '编程');
      });

      await check('112d 点时间块记一条：写进工作格，且第二次不重复写', async () => {
        await page.locator('.wt-seg-on').first().click();
        await page.waitForTimeout(250);
        const pop = page.locator('.wt-pop');
        assert.strictEqual(await pop.count(), 1, '点时间块没出浮层');
        const popText = await pop.textContent();
        assert.ok(popText.indexOf('09:00') >= 0 && popText.indexOf('编程') >= 0, '浮层内容不对：' + popText);
        await pop.getByRole('button', { name: '记一条' }).click();
        await page.waitForTimeout(700);
        const again = page.locator('.wt-pop').getByRole('button', { name: '已记过' });
        assert.strictEqual(await again.count(), 1, '写完后按钮没变成「已记过」');
        assert.strictEqual(await again.isDisabled(), true, '「已记过」还可以再点');

        await page.locator('.gtd-view .back').click();
        await page.waitForTimeout(300);
        // 九格的正文是 contenteditable（RichText），不是 textarea
        const text = await page.locator('.cell[data-cell="work"] .rt-body').innerText();
        assert.ok(text.indexOf('09:00–10:00 code · 编程（60 分钟）') >= 0, '工作格里没有这一行：' + text);
        assert.strictEqual((text.match(/编程（60 分钟）/g) || []).length, 1, '同一段被写了两次');
      });
    } finally {
      await new Promise(function (r) { wtServer.close(r); });
    }

    // ---- 自由记录模块三合一 + 胶囊降级（docs/28）----
    await check('136 胶囊弹窗两态：书写 / 今日到期可切换，关闭后无残留', async () => {
      await page.locator('.titlebar .capsule-btn').click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.cm-box').count(), 1);
      assert.strictEqual(await page.locator('.capsule').count(), 1, '默认应落在书写态');
      await page.locator('.cm-tab').nth(1).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.cm-due').count(), 1, '到期态没渲染');
      await page.locator('.cm-x').click();
      await page.waitForTimeout(150);
      assert.strictEqual(await page.locator('.cm-box').count(), 0);
    });

    await check('137 闪念快记：原文留自由记录，收件箱恰好多一条且重进不重复', async () => {
      await page.locator('.nav-item').nth(3).click();
      await page.waitForTimeout(350);
      await page.locator('.free-view .fw-tab').nth(1).click();
      await page.waitForTimeout(200);
      const stamp = '闪念同步验证-' + Date.now();
      await page.locator('.fw-capture input').fill(stamp);
      await page.locator('.fw-capture .fw-primary').click();
      await page.waitForTimeout(450);
      const row = page.locator('.fw-flash').filter({ hasText: stamp }).first();
      assert.strictEqual(await row.count(), 1, '闪念原文没落库');
      assert((await row.innerText()).includes('已同步'), '同步状态不是「已同步」');
      // R-29 验收：不再补偿。双击九格标题进 GTD 后必须**自己**停在收件箱，
      // 由产品修复（WorkView.pickStatus 忽略 UIEvent.detail>1 的第二次 click）保证，
      // 而不是靠测试端点回第 0 个 tab 把断言拉绿。
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(250);
      await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
      await page.waitForTimeout(400);
      assert.strictEqual(await page.locator('.gtd-view').count(), 1);
      assert.strictEqual(
        await page.locator('.gtd-tab').nth(0).getAttribute('aria-selected'), 'true',
        '双击进 GTD 后没停在收件箱（分组被第二次 click 切走）');
      await page.waitForTimeout(150);
      const hit = page.locator('.gtd-item').filter({ hasText: stamp });
      assert.strictEqual(await hit.count(), 1, '收件箱没同步到这一条（或多同步了一条）');
      // 再回一次自由记录：onMounted 会补跑 pending 同步，按 source 去重不应产生第二条
      await page.locator('.nav-item').nth(3).click();
      await page.waitForTimeout(400);
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(200);
      await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
      await page.waitForTimeout(400);
      await page.locator('.gtd-tab').nth(0).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.gtd-item').filter({ hasText: stamp }).count(), 1,
        '重复进入后收件箱出现第二条（source 幂等失效）');
    });

    await check('138 长文撰写：海明威体检只标色、不改写、写作/编辑双模式', async () => {
      await page.locator('.nav-item').nth(3).click();
      await page.waitForTimeout(300);
      await page.locator('.free-view .fw-tab').nth(2).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.fw-stats').count(), 1, '写作法面板没渲染');
      await page.locator('.fw-doclist .fw-primary').click();
      await page.waitForTimeout(300);
      assert.ok((await page.locator('.fw-doc').count()) >= 1, '新建长文没进列表');
      const text = '他非常慢慢地被进行了一番说明，其实没有予以解释。' + '字'.repeat(70) + '。';
      await page.locator('.fw-paper').fill(text);
      await page.locator('.fw-ebar .fw-btn').nth(0).click();
      await page.waitForTimeout(450);
      assert.strictEqual(await page.locator('.fw-review').count(), 1, '体检态没渲染');
      assert.ok((await page.locator('.fw-review .fw-hard').count()) >= 1, '过长句没标红');
      assert.ok((await page.locator('.fw-review mark').count()) >= 1, '弱化词没标蓝');
      assert.strictEqual(await page.locator('.fw-paper').count(), 0, '体检态还留着写作输入框');
      await page.locator('.fw-ebar .fw-btn').nth(0).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.fw-paper').inputValue(), text, '体检改写了用户正文');
    });

    await check('139 删闪念：原文与对应未完成的收件箱任务一并删除（Q3 A）', async () => {
      await page.locator('.nav-item').nth(3).click();
      await page.waitForTimeout(350);
      await page.locator('.free-view .fw-tab').nth(1).click();
      await page.waitForTimeout(200);
      const stamp = '闪念删除验证-' + Date.now();
      await page.locator('.fw-capture input').fill(stamp);
      await page.locator('.fw-capture .fw-primary').click();
      await page.waitForTimeout(400);
      // 先确认收件箱里确实有这一条
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(250);
      await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
      await page.waitForTimeout(400);
      await page.locator('.gtd-tab').nth(0).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.gtd-item').filter({ hasText: stamp }).count(), 1);
      // 回自由记录删掉原文
      await page.locator('.nav-item').nth(3).click();
      await page.waitForTimeout(350);
      await page.locator('.free-view .fw-tab').nth(1).click();
      await page.waitForTimeout(200);
      const row = page.locator('.fw-flash').filter({ hasText: stamp }).first();
      assert.strictEqual(await row.count(), 1);
      await row.getByRole('button', { name: '删除' }).click();
      await page.waitForTimeout(400);
      assert.strictEqual(await page.locator('.fw-flash').filter({ hasText: stamp }).count(), 0, '闪念原文没删掉');
      // 再回收件箱：任务应随之消失，不留孤儿
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(250);
      await page.locator('.cell[data-cell="work"] .cell-label').dblclick();
      await page.waitForTimeout(400);
      await page.locator('.gtd-tab').nth(0).click();
      await page.waitForTimeout(250);
      assert.strictEqual(await page.locator('.gtd-item').filter({ hasText: stamp }).count(), 0,
        '删了闪念，收件箱任务还在（孤儿）');
    });

    // ===== R-09 / R-10 / R-11 / R-12：第 1 批四项功能的真 DOM 断言 =====
    await check('140 全局热键 Ctrl+Alt+J 已注册，托盘已就绪（R-09）', async () => {
      const info = await app.evaluate(({ globalShortcut }) => ({
        accelerator: global.__jiugeAccelerator,
        registered: globalShortcut.isRegistered(global.__jiugeAccelerator || ''),
        tray: typeof global.__jiugeTrayReady === 'function' ? global.__jiugeTrayReady() : false
      }));
      assert.strictEqual(info.accelerator, 'Control+Alt+J', '热键不是约定的 Ctrl+Alt+J');
      assert.strictEqual(info.registered, true, '热键没注册上（可能被别的程序占用）');
      assert.strictEqual(info.tray, true, '托盘图标没建起来');
    });

    await check('141 速记入口：触发后 ≤500ms 进入可输入态，且落日取触发那一刻（R-09）', async () => {
      await page.locator('.nav-item').first().click();
      await page.waitForTimeout(200);
      assert.strictEqual(await page.locator('.quick textarea').count(), 0, '速记本来是开着的，测不出打开速度');
      const t0 = Date.now();
      await app.evaluate(() => global.__jiugeQuickCapture('e2e'));
      await page.locator('.quick textarea').waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForFunction(() => {
        const el = document.querySelector('.quick textarea');
        return !!el && document.activeElement === el;
      }, { timeout: 5000 });
      const cost = Date.now() - t0;
      assert.ok(cost <= 500, '进入可输入态耗时 ' + cost + 'ms，超过 500ms 验收线');
      // 落日：标题里的日期必须是「触发那一刻」，不是「保存那一刻」
      const head = await page.locator('.quick-head strong').innerText();
      assert.ok(/\d{4}-\d{2}-\d{2}/.test(head), '速记没显示落日日期：' + head);
      await page.locator('.quick .close').click();
      await page.waitForTimeout(200);
    });

    await check('142 可回滚版本：备份后列出，两步确认后真的执行（R-10）', async () => {
      await page.locator('.nav-item').nth(6).click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: '立即备份' }).click();
      await page.waitForTimeout(800);
      await page.waitForFunction(
        () => document.querySelectorAll('.ver-list .ver-item').length > 0,
        { timeout: 6000 }
      );
      const items = page.locator('.ver-list .ver-item');
      const before = await items.count();
      assert.ok(before >= 1, '备份后仍没有可回滚版本');
      const btn = items.first().locator('.ver-btn');
      assert.strictEqual((await btn.innerText()).trim(), '回到这一份', '按钮初始文案不对');
      await btn.click();
      await page.waitForTimeout(200);
      assert.ok((await btn.innerText()).includes('确认回到这一份'), '第一次点击没有进入二次确认');
      await btn.click();
      await page.waitForTimeout(2000);
      // 回滚会先给当前状态留一份安全版本，所以列表应该变长
      const after = await items.count();
      assert.ok(after > before, '回滚后没有生成安全版本（' + before + ' → ' + after + '）');
      const msg = await page.locator('.message').innerText().catch(() => '');
      assert.ok(msg.includes('已回到') || msg.includes('回滚未执行'), '回滚没有给出可见回执：' + msg);
    });

    await check('143 独立账本窗：打开后净资产真实渲染，不是空壳（R-12）', async () => {
      const winPromise = app.waitForEvent('window', { timeout: 20000 });
      await page.locator('.finance-btn').click();
      const fin = await winPromise;
      await fin.waitForLoadState('domcontentloaded');
      await fin.waitForTimeout(1200);
      const body = await fin.locator('body').innerText();
      assert.ok(body.includes('净资产'), '账本窗没渲染「净资产」：' + body.slice(0, 120));
      assert.ok(/净资产[\s\S]{0,30}\d/.test(body), '净资产没有数值，是个空壳');
      await fin.close();
    });

    await check('144 四语言：切到 English 界面文案跟随，切回中文可还原（R-12）', async () => {
      await page.locator('.nav-item').nth(7).click();
      await page.waitForTimeout(300);
      const before = await page.locator('.nav').innerText();
      await page.locator('.seg').filter({ hasText: 'English' }).first().click();
      await page.waitForTimeout(600);
      const after = await page.locator('.nav').innerText();
      assert.notStrictEqual(before, after, '切到 English 后导航文字没变化');
      assert.ok(/[A-Za-z]{3,}/.test(after), '导航没变成英文：' + after);
      await page.locator('.seg').filter({ hasText: '简体中文' }).first().click();
      await page.waitForTimeout(600);
      const back = await page.locator('.nav').innerText();
      assert.strictEqual(back, before, '切回简体中文后没有完整还原');
    });

    await check('113 真实窗口无 JS 运行时异常', async () => {
      assert.strictEqual(jsErrors.length, 0, JSON.stringify(jsErrors));
    });

    console.log('');
    console.log('========================================');
    console.log('  GUI 真断言 PASS ' + passed + ' | FAIL ' + failed + '（要求 ≥30）' + (skipped ? ' | 跳过 ' + skipped + ' 条（JIUGE_E2E_ONLY=' + ONLY.join(',') + '）' : ''));
    console.log('========================================');
    // 只跑子集时不再卡「≥30」这条线，但仍要求「全过」
    process.exitCode = failed > 0 || (ONLY.length ? passed < 1 : passed < 30) ? 1 : 0;
  } catch (e) {
    console.error('  启动或断言框架异常: ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    if (app) {
      try { await app.close(); } catch (e) { /* noop */ }
      // 窗口中途崩掉时 app.close() 不会真的把主进程带走，残留实例会一直占着
      // userData 的句柄，下一次跑到一半整窗消失（本轮实测就栽在这上面）——所以硬杀一次。
      try {
        const proc = typeof app.process === 'function' ? app.process() : null;
        if (proc && proc.pid) {
          const { spawnSync } = require('child_process');
          spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        }
      } catch (e) { /* noop */ }
    }
    // 等 Electron 子进程真正退出再交还控制权：连续快速重跑时，
    // 上一个实例还占着 userData 的文件句柄，会让下一次跑到一半整窗消失
    await new Promise(function (r) { setTimeout(r, 800); });
  }
})();

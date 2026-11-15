'use strict';
// 作用于**打包 exe** 的端到端断言（04-质量保障方案 §2：exe E2E ≥5 条）
// 关键：必须校验日志资源路径为 app.asar，不得用源码版 Electron 冒充。
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn, execSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
// 旧产物被环境独占时，允许用 JIUGE_EXE_PATH 指向本次真打出来的那一份
const exe = process.env.JIUGE_EXE_PATH
  ? path.resolve(process.env.JIUGE_EXE_PATH)
  : path.join(root, 'build-v2', '九格手记-v2-便携版.exe');
const userData = path.join(os.tmpdir(), 'jiuge-exe-e2e-' + Date.now());
// 便携版会解包到 %TEMP%\<appId>。如果不同轮次/其他实例共用同一个解包目录，
// 删不掉的旧文件会被改名成 xxxX 然后跳过，剩下的半截目录里缺 ffmpeg.dll / resources.pak，
// 结果就是「exe 静默不启、探针永远等不到」。每轮给一个自己的 TEMP，从根上不抢。
const tmpRoot = path.join(userData, 'tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const probeFile = path.join(userData, 'v2-probe.json');

delete process.env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(userData, { recursive: true });

// 解包目录的 app.asar 有时候会被环境钉死（删不掉、改名也不行，进程列表里又查不到），
// 那时打包只能换个输出目录。
// 整改（R-07）：原实现按「build-v2b 优先」硬编码顺序查找，一旦 build-v2b 里留着旧包，
// 就会出现「跑的是新 exe、验的是旧载荷」——门禁验错对象。现改为**按 mtime 取最新**，
// 不论输出目录叫什么名字，验的都是最近一次真正打出来的那一份。
function resolveAsar() {
  const list = [
    path.join(root, 'build-v2', 'win-unpacked', 'resources', 'app.asar'),
    path.join(root, 'build-v2b', 'win-unpacked', 'resources', 'app.asar'),
    path.join(root, 'build-v2c', 'win-unpacked', 'resources', 'app.asar'),
    path.join(root, 'build-v2d', 'win-unpacked', 'resources', 'app.asar')
  ].filter(function (p) { return fs.existsSync(p); });
  if (!list.length) return path.join(root, 'build-v2', 'win-unpacked', 'resources', 'app.asar');
  list.sort(function (a, b) { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; });
  return list[0];
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + ' :: ' + e.message);
  }
}

// 便携版每次启动都会解包到 %TEMP%\<appId>。如果上一轮被 taskkill /F 掐断，
// 解包器会把删不掉的 resources 改名成 resourcesX 再继续，结果目录里没有 resources，
// 下一次启动就「静默不启」——探针等 60 秒也不会出现。这里先自愈，别让环境债算成产品缺陷。
function healPortableDir() {
  // 启动器最终解包到系统 %TEMP%\<appId>（不认我们传的 TEMP），所以两处都要看
  [path.join(tmpRoot, 'jiu-ge-desktop-v2'), path.join(os.tmpdir(), 'jiu-ge-desktop-v2')].forEach(healOne);
}

function healOne(dir) {
  if (!fs.existsSync(dir)) return;
  // 健康标准：运行必需的几个文件都在。只判 app.asar 会漏掉「asar 有、ffmpeg/icudtl 被改名成 X」的半截解包
  const need = ['ffmpeg.dll', 'icudtl.dat', 'resources.pak', path.join('resources', 'app.asar')];
  const broken = need.some(function (f) { return !fs.existsSync(path.join(dir, f)); });
  if (!broken) return;

  // 半截解包往往还挂着一个起不来的旧实例，它占着文件，不杀就删不掉
  ['九格手记-v2-便携版.exe', '九格手记-v2.exe'].forEach(function (name) {
    try { execSync('taskkill /F /IM "' + name + '"', { stdio: 'ignore' }); } catch (e) { /* 没在跑 */ }
  });

  const until = Date.now() + 1200;
  while (Date.now() < until) { /* 等句柄释放 */ }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* 被占用就交给下一轮 */ }
}

function launch() {
  healPortableDir();
  const env = Object.assign({}, process.env, {
    JIUGE_V2_PROBE: '1',
    JIUGE_V2_USERDATA: userData,
    TEMP: tmpRoot,
    TMP: tmpRoot
  });
  const child = spawn(exe, [], { env: env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitProbe(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(probeFile)) {
      try { return JSON.parse(fs.readFileSync(probeFile, 'utf8')); } catch (e) { /* 写入中 */ }
    }
    await sleep(500);
  }
  return null;
}

function killPid(pid) {
  if (!pid) return;
  // /T 连子进程一起收：只杀主进程会留下渲染/GPU 子进程占着解包目录，
  // 下一次解包删不掉 resources，就成了「exe 静默不启」的假故障。
  try { execSync('taskkill /F /T /PID ' + pid, { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
  // 给句柄释放留一点时间，否则紧随其后的重启会撞上还在被占用的文件
  const until = Date.now() + 3000;
  while (Date.now() < until) { /* 同步短等待，仅在测试收尾使用 */ }
}

(async function main() {
  let probe = null;
  try {
    console.log('exe-assert | 打包产物端到端');
    console.log('  exe: ' + exe);
    console.log('  隔离 userData: ' + userData);
    console.log('');

    check('01 便携版 exe 存在且体积合理', function () {
      assert(fs.existsSync(exe), '缺少产物，请先执行打包');
      assert(fs.statSync(exe).size > 10 * 1024 * 1024, '产物过小，疑似不是完整 exe');
    });

    launch();
    console.log('  ... 等待干净机首次运行探针（最长 60s）');
    probe = await waitProbe(60000);

    check('02 干净 Windows 机首次运行：探针生成、无 ENOENT', function () {
      assert(probe, 'exe 未写出探针（可能被 SmartScreen 拦截或启动失败）');
      assert(!fs.existsSync(path.join(userData, 'v2-probe-error.txt')), '探针写出错误文件');
    });
    if (!probe) throw new Error('探针未生成，后续断言跳过');

    check('03 校验资源来自 app.asar（非源码版 Electron 冒充）', function () {
      assert.strictEqual(probe.isAsar, true, 'resourcePath=' + probe.resourcePath);
      assert(probe.resourcePath.indexOf('app.asar') >= 0);
      assert(probe.resourcePath.indexOf('renderer-v2') >= 0);
    });
    check('04 加载的是本地 file:// 静态产物，零远程地址', function () {
      assert(/^file:\/\//.test(probe.loadedUrl), probe.loadedUrl);
      assert(!/https?:\/\//.test(probe.loadedUrl), probe.loadedUrl);
      assert(probe.loadedUrl.indexOf('index.html') >= 0);
    });
    check('05 v1 IPC 路由全部注册（≥7）', function () {
      assert(probe.apiChannels >= 7, '实得 ' + probe.apiChannels);
    });
    check('06 主进程已挂 8 utils 领域层（StoragePort 生效）', function () {
      assert.strictEqual(probe.domainAttached, true);
    });
    check('07 contextIsolation / sandbox 均为 true', function () {
      assert.strictEqual(probe.contextIsolation, true);
      assert.strictEqual(probe.sandbox, true);
    });
    check('08 窗口标题为九格手记工作台', function () {
      assert(probe.title.indexOf('九格手记') >= 0, probe.title);
    });
    check('09 数据目录按 E2E 隔离，未污染真实用户数据', function () {
      assert.strictEqual(path.resolve(probe.userData), path.resolve(userData));
      assert(probe.userData.indexOf('AppData') < 0 || probe.userData.indexOf('jiuge-exe-e2e') >= 0);
    });

    // 双实例：第二次启动应被单实例锁拒绝，probe.pid 不变
    const pidBefore = probe.pid;
    const second = launch();
    await sleep(2500);
    const probeAfter = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
    check('10 双实例：第二进程不新建窗口、不覆盖 probe', function () {
      assert.strictEqual(probeAfter.pid, pidBefore, '主进程 pid 被第二个实例改写');
    });
    try { second.kill(); } catch (e) { /* noop */ }

    // 强杀后重启：journal 回放路径仍能正常启动
    killPid(probeAfter.pid);
    await sleep(800);
    fs.rmSync(probeFile, { force: true });
    launch();
    const recovered = await waitProbe(45000);
    check('11 强杀 /F 后重启：探针重新生成且可回放 journal', function () {
      assert(recovered, '强杀后重启失败');
      assert.strictEqual(recovered.isAsar, true);
      assert(typeof recovered.replayedAtBoot === 'number');
    });
    if (recovered) killPid(recovered.pid);

    check('12 旧 exe 与旧构建目录未被 v2 打包覆盖', function () {
      assert(fs.existsSync(path.join(root, 'build', '九格手记-便携版.exe')));
      assert(fs.existsSync(path.join(root, 'build', '九格手记-安装版-1.0.0.exe')));
    });

    // GTD 是独立领域模块：打包配置若漏掉 src/gtd，exe 一启动就 require 失败，
    // 而源码版 Electron 跑测试却完全正常——必须在产物上验一次。
    check('13 产物包含领域模块与封存箱（src/gtd、src/dream、src/growth、src/core/recycle 真的进包）', function () {
      const asar = require('@electron/asar');
      const asarPath = resolveAsar();
      assert(fs.existsSync(asarPath), 'app.asar 不存在');
      const list = asar.listPackage(asarPath).map(function (x) { return x.replace(/\\/g, '/'); });
      assert(list.some(function (x) { return x.indexOf('src/gtd/board.js') >= 0; }), 'src/gtd/board.js 未进包');
      assert(list.some(function (x) { return x.indexOf('src/dream/board.js') >= 0; }), 'src/dream/board.js 未进包');
      // 漏一个包内目录，主进程 require 直接崩，exe 一启动就白屏——所以逐目录点名
      assert(list.some(function (x) { return x.indexOf('src/growth/board.js') >= 0; }), 'src/growth/board.js 未进包（学习成长会白屏）');
      assert(list.some(function (x) { return x.indexOf('src/core/recycle.js') >= 0; }), 'src/core/recycle.js 未进包（封存箱会失效）');
      assert(list.some(function (x) { return x.indexOf('src/core/persistence.js') >= 0; }), 'src/core/persistence.js 未进包（自动备份会失效）');
      // V1.3 + V2.0/V2.1 领域模块：漏一个目录，exe 一启动就 require 失败白屏。
      // 源码版 Electron 测试发现不了，只能在产物上逐目录点名。
      [
        'src/v13/board.js',
        'src/search/query.js',
        'src/tags/board.js',
        'src/recur/board.js',
        'src/relation/board.js',
        'src/review/term.js',
        'src/trace/board.js',
        'src/secure/vault.js',
        'src/attach/links.js',
        'src/reading/board.js',
        'src/reading/epub.js',
        'src/reading/reader-source.js',
        'renderer-v2/reader/index.html',
        'renderer-v2/reader/reader.js'
      ].forEach(function (f) {
        assert(list.some(function (x) { return x.indexOf(f) >= 0; }), f + ' 未进包（相关模块会白屏）');
      });
      assert(list.some(function (x) { return x.indexOf('renderer-v2/dist/assets/') >= 0 && /\.js$/.test(x); }),
        'Vue 产物未进包');
    });

    // 本机时间源（md_worktime）：主进程 require 了 board / client / aggregate 三件套，
    // 打包漏一个就 startup 崩，而源码版跑得好好的——只有产物能证明它真的在包里。
    check('13a 产物包含本机时间源三件套（board / client / aggregate）', function () {
      const asar = require('@electron/asar');
      const asarPath = resolveAsar();
      const list = asar.listPackage(asarPath).map(function (x) { return x.replace(/\\/g, '/'); });
      ['src/worktime/board.js', 'src/worktime/client.js', 'src/worktime/aggregate.js'].forEach(function (f) {
        assert(list.some(function (x) { return x.indexOf(f) >= 0; }), f + ' 未进包（本机时间源会拖垮启动）');
      });
      // 兜底：整目录在包内，避免以后新增第 4 个文件时又漏配
      assert(list.some(function (x) { return x.indexOf('src/worktime/') >= 0; }), 'src/worktime 目录未进包');
    });

    check('14 探针确认新通道已注册（健康检查 / 手动备份）', function () {
      // probe 由 did-finish-load 写出，apiChannels 是 routeNames().length
      assert(probe.apiChannels >= 11, '通道数偏少，可能是旧包：' + probe.apiChannels);
    });

    // 自动备份要"真的在跑"，不能只验函数存在。
    // 但干净机从未写过数据时不该产生空快照（空快照会让用户以为有备份，比没有更危险）。
    // 所以分两条：先验"不该造的不造"，再造一份数据验"该备份的备份了"。
    const dataDir = path.join(userData, 'jiuge-data');
    const snapDir = path.join(dataDir, 'snapshots');
    const beforeSnaps = fs.existsSync(snapDir)
      ? fs.readdirSync(snapDir).filter(function (n) { return fs.existsSync(path.join(snapDir, n, 'meta.json')); }).length
      : 0;

    // 现在「干净机」也不是空的：首启会种一棵梦想树（17 条目标），有内容就该有快照。
    // 所以这条查的不是「零快照」，而是「快照不是空壳」：每份都得带真 store.json，
    // 且里面至少有一个键——防的是「快照目录建了、文件没落盘」那种假备份。
    check('15 首启快照不含空壳：每份都能还原出真实内容', function () {
      const dirs = fs.existsSync(snapDir)
        ? fs.readdirSync(snapDir).filter(function (n) { return fs.existsSync(path.join(snapDir, n, 'meta.json')); })
        : [];
      dirs.forEach(function (n) {
        const f = path.join(snapDir, n, 'store.json');
        assert(fs.existsSync(f), '快照 ' + n + ' 里没有 store.json');
        const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
        const keys = Object.keys(obj || {});
        assert(keys.length > 0, '快照 ' + n + ' 是空壳');
      });
      assert(dirs.length >= 1, '干净机首启也没留下任何快照（说明备份没跑）');
      void beforeSnaps;
    });

    const storeFile = path.join(dataDir, 'store.json');
    if (!fs.existsSync(storeFile)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify({
        schemaVersion: 2, revision: 1, updatedAt: Date.now(), entries: {}
      }), 'utf8');
      try { fs.unlinkSync(probeFile); } catch (e) { /* 无旧探针 */ }
      const child = launch();
      await waitProbe(60000);
      await sleep(900);
      killPid(child.pid);
    }

    check('16 有数据时启动即自动写一份快照，且快照里真有 store.json', function () {
      assert(fs.existsSync(snapDir), '快照目录未生成，自动备份没跑起来');
      const entries = fs.readdirSync(snapDir).filter(function (n) {
        return fs.existsSync(path.join(snapDir, n, 'meta.json'));
      });
      const auto = entries.filter(function (n) { return /-auto$/.test(n); });
      assert(auto.length >= 1, '没有自动快照：' + entries.join(','));
      const withStore = auto.filter(function (n) { return fs.existsSync(path.join(snapDir, n, 'store.json')); });
      assert(withStore.length >= 1, '自动快照缺 store.json，回滚会是空壳');
    });

    console.log('');
    console.log('========================================');
    console.log('  exe 端到端 PASS ' + passed + ' | FAIL ' + failed + '（要求 ≥5）');
    console.log('  说明：未签名 exe；对外分发前仍需 OV/EV 证书');
    console.log('========================================');
    process.exitCode = failed > 0 || passed < 5 ? 1 : 0;
  } catch (e) {
    console.error('  框架异常: ' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    if (probe && probe.pid) killPid(probe.pid);
  }
})();

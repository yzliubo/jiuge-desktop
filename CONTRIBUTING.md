# 参与完善 · 九格手记桌面版

欢迎提 Issue、提 PR、改文档、补测试。这是一个本地优先的 Electron 桌面应用（Windows 为主），目标是让「九格手记」在电脑上好用、可维护。

> **先读两句话**
> 1. 根目录 `README.md` 是 **v1 版本快照**，其中「纯本地零网络 / 不联网」已不适用于当前主线（v2 渲染层 + V3.17）。当前状态以 [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) 和代码为准。
> 2. 本仓库采用 **MIT 许可证**（见 [`LICENSE`](LICENSE)）。提交 PR 即表示你同意按 MIT 授权你的贡献；第三方依赖的许可口径见 [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md)。

## 一、从哪里开始

| 想做什么 | 入口 |
|---|---|
| 报 bug / 提需求 | 用 Issue 模板；标签 `good first issue` 的任务适合第一次参与 |
| 看当前版本脉络与已知边界 | [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) |
| 看早期产品 / 架构设计 | `docs/01-PRD.md`、`docs/02-ARCHITECTURE.md`、`docs/03-QA.md`（供参考，未必与代码一致） |
| 了解数据口径与验收 | `tests/phase2/`、`tests/e2e/`、`tools/` |

## 二、代码结构

| 路径 | 职责 |
|---|---|
| `src/main/` | Electron 主进程入口与窗口管理（含图书馆独立窗） |
| `src/core/` | 领域层、`api-layer.js` 路由、数据仓库 |
| `src/preload/` | `v2-preload.js`，IPC `CHANNELS` 白名单 |
| `src/reading/`、`src/weather/` 等 | 业务模块（阅读 / PDF / EPUB、天气、工时…） |
| `renderer-v2/src/` | Vue 3 + TS 渲染层：`views/`、`components/`、`composables/`、`bridge.ts` |
| `renderer-v2/reader/` | PDF/EPUB 阅读器静态页（**不进 Vite 构建**） |
| `renderer-v2/reader/vendor/` | 本地 pdf.js（含 LICENSE / NOTICE），请勿改成 CDN 引用 |
| `tests/`、`tools/` | 静态门禁、GUI 断言、打包校验脚本 |
| `docs/` | 设计文档与现状说明 |

**新增一个主进程能力要三处齐**：`src/core/api-layer.js` 路由 → `src/preload/v2-preload.js` 的 `CHANNELS` 白名单 → `renderer-v2/src/bridge.ts` 封装。只改一处跑不通。

## 三、本地跑起来

- 建议 Node 20 LTS（Electron 31.x），Windows 10 / 11。
- 装依赖：`npm install`、`npm --prefix renderer-v2 install`
- 启动：`npm run start:v2`（当前主线）；`npm start` 是 v1 历史入口。
- 若报 `app.whenReady undefined`：先清 `ELECTRON_RUN_AS_NODE`（Git Bash：`env -u ELECTRON_RUN_AS_NODE npm run start:v2`），或双击 `scripts/start.bat`。
- 渲染层改动后必须 `npm run build:view` 重建。**`renderer-v2/reader/` 是静态页不进 Vite 构建**，改 `reader.js` / `reader.css` / `index.html` 后要重新 `npm run dist:v2` 打包才会进 exe。

## 四、提交前请跑的门禁

| 命令 | 覆盖 |
|---|---|
| `npm run view:check` | 静态视图契约（当前 93/93） |
| `npm run verify` | 69 项等价性与全局一致性 |
| `npm run smoke` | 28 项数据层 / 导入冒烟 |
| `npm run golden` | 158 项黄金用例 |
| `npm run weather:check` | 天气模块 16 项 |
| `npm run asar:check` | 打包产物探针（需先 `dist:v2`） |
| `npm run test:gui` / `npm run test:exe` | 真 GUI 断言 / exe E2E（耗时；改阅读器或窗口时建议跑） |

PR 描述里请写明改了哪些模块、跑了哪几条门禁；界面改动**建议附截图**。

## 五、约定与红线

- **数据文件绝不入库**：`store.json`、`window-state.json`、`*.bak`、`build*/`、`*.exe` 均已在 `.gitignore`。
- **不要写入任何密钥、令牌、账号口令**，不要把本机绝对路径写进新增代码 / 文档；Issue 里不要贴 `store.json` 原文（含私人日记）。
- 新增独立窗口时，根节点要挂 `:data-skin="skin" data-surface="light"`，否则 `--palette-*` 变量不生效。
- 跨窗口数据刷新走 `v1/data:changed` 广播 + `dataTick`，不要自己轮询。
- 提交信息用中文 conventional 前缀（`feat` / `fix` / `docs` / `test` / `chore`），涉及迭代请带版本号（如 `V3.17`）。
- 版本按 **V3.x** 逐版推进；阶段性产出由主理人核验后再合入 `main`。

## 六、PR 流程

1. Fork → 从 `main` 建分支 → 小步提交。
2. 跑上表门禁，把结果贴进 PR。
3. 提 PR 到 `main`，说明动机、改动范围、验证方式与截图；一个 PR 只解决一件事。
4. 主理人核验后合入；需要取舍时会给 A/B/C 选项再定，不会跳步。

## 七、还没做的事（欢迎认领）

- 把 `README.md` 从 v1 快照重写为当前版本说明
- 补 GitHub Actions（至少 `view:check` / `verify` / `smoke` 三条）
- 清理历史文档与 QA 日志里的本机绝对路径

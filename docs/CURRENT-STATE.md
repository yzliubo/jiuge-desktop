# 项目现状（2026-11-15）

> 本文件用来补 `README.md` 的时效差。`README.md` 写于 v1（单文件 exe、v6/v7 导入、纯本地零网络），**不代表当前主线**。

## 当前主线

- 主进程：Electron 31.x + CommonJS（`src/`）；渲染层：Vue 3 + TypeScript + Vite（`renderer-v2/`），三个 HTML 入口 `index.html` / `finance.html` / `library.html`。
- 最近迭代：**V3.14 → V3.17** —— 图书馆独立三栏窗（左栏文件夹层级树）、主题文件紧凑表格、PDF HiDPI 高清渲染、PDF 可选中 / 复制 / 摘录进笔记 / 全书搜索与命中定位。
- 数据仍以本地 `store.json` 为主，但**已有联网模块**：`src/weather/client.js`（天气）、`src/reading/cover-net.js`（封面）、`src/worktime/client.js`（工时）。因此 README 第九节「纯本地零网络、无 HTTP 请求」**已不成立**，以代码为准。

## 门禁基线（V3.17 实测）

| 项 | 结果 |
|---|---|
| `view:check` | 93/93 PASS |
| golden / smoke / verify | 158 / 28 / 69 PASS |
| weather | 16 PASS / 0 FAIL |
| asar 探针 | 421/421 |
| exe E2E | 17/17 |
| 真 GUI | 189 PASS / 6 FAIL —— 余 6 条为环境基线（#109 / #110 语料库、#112a–d AW_OFFLINE），非功能缺陷 |

## 已知边界

- exe 未购买代码签名证书，Windows SmartScreen 会拦一下。
- `renderer-v2/reader/` 为静态页，不进 Vite 构建；改完必须重打包 exe 才生效。
- 扫描件 / 自定义字体编码的 PDF 无法提取文字（pdf.js 限制），画布照常显示，文本层自动降级。
- **许可证：MIT**（根目录 `LICENSE`）。`renderer-v2/reader/vendor/` 内的 pdf.js 为 **Apache-2.0**，许可文本见同目录 `LICENSE-pdfjs.txt` / `NOTICE-pdfjs.txt`；分发 exe 时须一并保留。
- `tests/qa-tmp/`、`tests/qa-logs/` 是开发期探针留档，含本机路径，不是产品代码。

## 公开后的清理状态（2026-11-15）

- **文档与 QA 日志**里的本机绝对路径已统一替换为 `<仓库根>` / `<文档根>` / `<工作区>` / `<用户目录>` 占位符（30 个文件）；45 个 JSON 结构未受影响（`bom-backup.json` 的 BOM 为原有格式，用 `utf-8-sig` 读取即可）。
- **例外（23 处 / 6 文件）**：`tools/` 下 4 个脚本、`tests/qa-unit.js` 与 `src/.copy-manifest.json` 仍引用外部小程序源码目录的绝对路径。`npm run verify` / `smoke` 直接依赖这些路径，改成占位符会让门禁失效（实测报找不到源码），因此本轮保留原样。彻底清理需先把它们重构为 `JIUGE_SOURCE_DIR` 环境变量。
- 提交历史中的旧路径与作者邮箱仍在历史对象里；**后续提交已改用 GitHub noreply 邮箱**。是否重写历史由主理人决定（重写会使所有旧 commit SHA 失效）。

## 参与入口

见根目录 [`CONTRIBUTING.md`](../CONTRIBUTING.md)；Issue 里标 `good first issue` 的任务适合第一次参与。

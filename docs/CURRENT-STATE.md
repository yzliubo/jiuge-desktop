# 项目现状（2026-11-15）

> 本文件用来补 `README.md` 的时效差。`README.md` 写于 v1（单文件 exe、v6/v7 导入、纯本地零网络），**不代表当前主线**。

## 当前主线

- 主进程：Electron 31.x + CommonJS（`src/`）；渲染层：Vue 3 + TypeScript + Vite（`renderer-v2/`），三个 HTML 入口 `index.html` / `finance.html` / `library.html`。
- 最近迭代：V3.14 → V3.17（图书馆独立三栏窗、主题文件紧凑表格、PDF HiDPI 渲染与可选中可搜索）；**2026-11-16 下午** 再扩四项：①图书馆休闲阅读接进九格第 7 格专属页（当日读满 5 分钟的书名/时长自动写进 `cells.dream`，当日摘录与想法同页展示，右栏给阅读账）；②关系经营主栏改「正文记录窗 + 记一次流水」，通讯录整块退到右栏；③家庭亲子成员登记退到右栏、主栏加正文记录窗，生日支持阳历/农历（内置 1900–2049 换算表）并可勾「设为纪念日提醒」（右栏卡 + 全局轻提醒）；④九格 9 格格头加「事项」按钮，按行拆成下一步行动任务，`source = g9|日期|格键|行号`，完成后原行末自动追加〔已完成〕。数据键 `dream/relation/emotion` 均未改，历史正文原样保留。
- **2026-11-16 上午** 三项打通：①九格第 9 格改为「三合一自由记录的当天摘要 + 一句快记」，闪念、长文、格内快记、右栏「留一句」四处统一写入 `md_freewrite`；②关系经营从时间轴二级目录并回九格第 4 格，一处入口；③「情绪觉察」整格重构为「家庭亲子」（成员 / 时刻 / 足迹三 tab，`md_family`），数据键 `emotion` 与历史 `cells.emotion` 正文一个字节不动。打包前又清掉设置页模板名、四语 `tplEmotion` 与引导语模板里残留的旧情绪问法：第 6 格现在无论选哪套模板都固定走家庭亲子题组（模板 id `emotion` 仅为兼容老设置保留）。
- 数据仍以本地 `store.json` 为主，但**已有联网模块**：`src/weather/client.js`（天气）、`src/reading/cover-net.js`（封面）、`src/worktime/client.js`（工时）。因此 README 第九节「纯本地零网络、无 HTTP 请求」**已不成立**，以代码为准。

## 门禁基线（2026-11-16 实测）

| 项 | 结果 |
|---|---|
| `view:check` | 101/101 PASS |
| golden / smoke / verify | 183 / 28 / 69 PASS |
| `build:view`（vue-tsc + vite） | PASS |
| weather | 16 PASS / 0 FAIL（本轮未重跑） |
| asar 探针 | **453/453 PASS**（新增休闲页/通讯录/农历/事项文案 + `src/family/lunar.js` 进包检查，2026-11-16 16:35 重打包后实测） |
| `artifact:check` | PASS（交付 exe 唯一、asar 不早于 dist、逐字节含当前 4 个 js 资产） |
| exe E2E | **17/17 PASS**（重打包后实测） |
| 交付 exe | `build-v2/九格手记-v2-便携版.exe`，71,899,148 B，SHA256 `0e68ce2c9f67ef924ab1dbd622b7dec01dd5d6afa49dffa42471befdcf5de4d7`，app.asar 3,889,613 B —— **下午四项改动已进包** |
| 真 GUI | **192 PASS / 8 FAIL**（200 条）——8 条都不是本轮改动域：#78c 阅读 WIP 主题表单、#109/#110 语料库、#112a–d 本机时间源离线（AW_OFFLINE）、#149 主题书单在读联动。新增 #190/#191/#192 全 PASS，#120/#120b/#124 改版后复验 PASS；打包后再抽 6 条（#120/#120b/#124/#190/#191/#192）全 PASS |

## 已知边界

- exe 未购买代码签名证书，Windows SmartScreen 会拦一下。
- `renderer-v2/reader/` 为静态页，不进 Vite 构建；改完必须重打包 exe 才生效。
- 扫描件 / 自定义字体编码的 PDF 无法提取文字（pdf.js 限制），画布照常显示，文本层自动降级。
- **许可证：MIT**（根目录 `LICENSE`）。`renderer-v2/reader/vendor/` 内的 pdf.js 为 **Apache-2.0**，许可文本见同目录 `LICENSE-pdfjs.txt` / `NOTICE-pdfjs.txt`；分发 exe 时须一并保留。
- `tests/qa-tmp/`、`tests/qa-logs/` 是开发期探针留档，含本机路径，不是产品代码。

## 公开后的清理状态（2026-11-15）

- **文档与 QA 日志**里的本机绝对路径已统一替换为 `<仓库根>` / `<文档根>` / `<工作区>` / `<用户目录>` 占位符（30 个文件）；45 个 JSON 结构未受影响（`bom-backup.json` 的 BOM 为原有格式，用 `utf-8-sig` 读取即可）。
- **例外（23 处 / 6 文件）**：`tools/` 下 4 个脚本、`tests/qa-unit.js` 与 `src/.copy-manifest.json` 仍引用外部小程序源码目录的绝对路径。`npm run verify` / `smoke` 直接依赖这些路径，改成占位符会让门禁失效（实测报找不到源码），因此本轮保留原样。彻底清理需先把它们重构为 `JIUGE_SOURCE_DIR` 环境变量。
- **历史已重写**（2026-11-15）：17 个提交的作者 / 提交者邮箱统一为 GitHub noreply，以 `--force-with-lease` 推送，旧 commit SHA 全部失效；本地 `refs/original/refs/heads/main` 保留重写前快照。历史提交文件内容里的旧路径未改动，仍可在历史 diff 中翻到。

## 参与入口

见根目录 [`CONTRIBUTING.md`](../CONTRIBUTING.md)；Issue 里标 `good first issue` 的任务适合第一次参与。

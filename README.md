# 应声 · 快捷输入（DSH 插件）

输入框左边的九宫格，**常驻**在那里、**和输入框等高**。点一格，预设好的文字就**插到草稿的光标处**。

```
   ┌───────────────┐  ┌──────────────────────────┐
   │ 继续  │先给结论│  │  输入你的消息…            │
   │ 说短点│ 列步骤 │  │                          │
   │ 说人话│表格对比│  │                          │
   │‹1/2› ✎ ✕     │  │ [⊞][模型]       [发送]   │
   └───────────────┘  └──────────────────────────┘
     常驻在输入框左边，与它等高
```

- **常驻**：点一次 ⊞ 就开着（记在浏览器里，刷新页面、换会话都还在），再点 ⊞ 或 ✕ 收起。
- **等高**：面板高度跟着输入框卡片走（草稿变长卡片长高，面板一起长）。
- **九宫格**：每页 3×3，最多 12 页；格子里的文字 11px、最多两行。
- **插入语义**：插在光标处（可撤销的一次编辑），不是覆盖草稿。连点几格就依次接在后面。
- **控制栏**（面板底部那一条）：`‹ 1/2 ›` 翻页、中间显示**当前页名（tab 名称）**、`✎` 进编辑、
  `✕` 收起；插入结果之类的提示会临时顶替页名，2.4 秒后自动换回来。
- **中英切换**：界面文案跟随 DSH 的**语言设置**（设置 → 通用 → 语言），中文显示中文、English 显示英文。
  首次生成的示例短语也按当时的界面语言给（中文用户拿到「常用 / 代码」，英文用户拿到「Common / Code」）；
  你自己改过的内容不会被翻译。
- 改预设：点 `✎` → 点某一格 → 改名称和内容 → 保存。空格子点一下就是新建；右键任意格子也能直接改。

---

## 安装（只有这一步要动手）

**从插件市场装**（发布后）：DSH 左侧边栏 → **插件** → 添加插件 → 填 `dsh-quick-input`。

**从本地装**（开发/未发布时）：

1. DSH 左侧边栏 → **插件** → **添加插件**
2. 粘贴这个**绝对路径**（整个文件夹，不是文件名）：

   ```
   C:\Users\mac\Downloads\应声插件
   ```

3. **安装** → **立即启用** → 回到对话页 **刷新一下页面**

装好后输入框工具行最左边会出现 ⊞。

> 也可以让 Agent 装：对它说「用 `plugin_manager` 的 `install_bundle`，把
> `C:\Users\mac\Downloads\应声插件` 装到当前 profile」。

仓库：<https://github.com/cm860712ch-cloud/dsh-quick-input>　·　包名：`dsh-quick-input`

---

## 怎么用

| 操作 | 结果 |
|---|---|
| 点 ⊞ | 展开/收起（常驻在输入框左边） |
| 点某一格 | 该格文字插到草稿光标处，面板不关（可以连点） |
| `‹` `›` | 翻页；中间是当前页名，页名左边是 `当前页/总页数` |
| 点 `✎` | 进入编辑态：每格右侧出现 ✎，左键从「插入」变成「改这一格」；再点「完成」退出 |
| 编辑态点某一格 | 打开该格编辑器：改名称、内容，保存 / 清空此格 / 返回 |
| 右键格子 | 不进编辑态也能直接改那一格 |
| 点 `✕` | 收起面板（⊞ 也会跟着灭） |

---

## 预设放在哪

```
C:\Users\mac\.dsh\quick-input\presets.json
```

- 第一次使用会写入内置的两页示例（常用 / 代码）作为种子。
- 之后界面里改的所有内容都落在这个文件里，刷新页面、换浏览器都不丢。
- 想恢复出厂：删掉这个文件，再刷新页面即可（会重新播种）。
- 格式：`{ "version": 1, "pages": [ { "title": "常用", "cells": [ { "label": "继续", "text": "继续" }, null, ... ] } ] }`，每页固定 9 格，空格子是 `null`。

`cordis.patch.yml` 里的 `config.presets` 只在**文件还不存在**时当种子用（默认那段是注释掉的示例）。

---

## 离线自检

不装任何东西、不连网、不碰 profile：

```powershell
cd C:\Users\mac\Downloads\应声插件
node dev\verify.mjs
```

147 项检查，分三层：静态清单 → 宿主半区（假 ctx 真注册路由、真收发请求、真落盘）
→ 浏览器半区（`node:vm` + 迷你 React 真渲染，真点 ⊞、真点格子、真翻页、真保存）。
它**不能**替代真机验证：真实槽位、主题、光标位置只能在页面里看。

**这 107 项验不到什么**（诚实说明）：

- **面板在真实 DOM 里的几何**：自检里的 `elementFromPoint` 是桩，所以「侧挂」分支在自检里
  从未真的出现过；会不会被祖先的 `overflow` 裁掉、看起来正不正，只能人眼确认。
- **`store 变化 → 界面刷新` 这条链路**：迷你 React 不自动重渲染，断言都靠手动重挂组件观察，
  真实 React 的时序没有覆盖到。
- **卸载路径**（effect cleanup、订阅退订）没有覆盖。

---

## 已知限制

- **面板位置**：默认常驻在输入框左边、与它等高。空草稿时输入框卡片约 102px，比"装得下两行
  文字"所需的最小高度（116px）还矮，所以那种情况下面板会稍微高出一点（多出来的高度全放在
  上方，下沿和输入框对齐，不会被底部裁掉）；草稿变长、卡片高过 116px 之后就严格等高。
  编辑预设时面板会临时向上生长（编辑框需要空间）。
- **宽度是按实测空隙自适应的**，不写死：插件量出「输入框左边到会话列左边缘」还剩多少空隙，
  面板宽度就取「空隙 − 8px」，夹在 120～232px 之间——所以窗口越窄、面板越窄，仍然贴左边。
  空隙连 120px 都放不下时，才退回「输入框上方浮层」。想改上下限改 `PANEL_MIN_WIDTH` /
  `PANEL_MAX_WIDTH`；想固定成浮层把 `SIDE_BY_SIDE` 改成 `false`。
- **不接管键盘**：Esc、数字键都不会被面板抢走——你在输入框里打字永远不受影响。
  关面板请点 ✕。
- **插入偶尔被拒**，两种原因分开说：
  - 正在发送/裁决 → 提示「正在发送，等这轮结束再点」，也不会白试；
  - 草稿版本刚变（你正好在打字）→ 自动重抓一次光标再试，仍失败才提示「草稿刚变过，再点一次」。
- **改完 `client.js` / `index.js` 要重启 DSH**（Node 的模块缓存换不掉）；只改
  `presets.json` 不需要。想知道页面正在跑哪一份客户端代码：

  ```powershell
  Invoke-RestMethod http://127.0.0.1:19387/quick-input/health
  # client.version 就是页面报到时的构建号（页面没报到过则是 null）
  # client.layout  是版面实测数字：{ dock, width, card, free, probe, innerWidth }
  #   free = 输入框左边还剩多少空隙；dock = 'side'（贴左边）/ 'above'（浮层）
  #   排查「为什么没贴在左边」时先看这两个数
  ```

---

## 卸载

插件页 → 找到这一行 → 先关掉，再删除。
想连预设一起清掉，删掉 `C:\Users\mac\.dsh\quick-input\` 目录。

---

## 文件一览

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半区：预设落盘 + `/quick-input/*` 路由（零依赖，只用 Node 内置模块） |
| `client.js` | 浏览器半区：⊞ 按钮 + 九宫格面板 + 插入草稿（React 由宿主模块表提供，带中英字典） |
| `presets.js` | 纯逻辑：默认种子（中/英各一套）+ 规范化 |
| `cordis.patch.yml` | 往 profile 插一行 |
| `icon.svg` | 插件图标 |
| `dev/verify.mjs` | 离线自检 |

---

## English

**Quick phrases, one click away — a 3×3 grid docked to the left of the composer.**
Click a cell and its preset text is inserted at the caret. The pad stays resident (remembers being open across
page reloads), matches the composer's height, and adapts its width to the space left of the input box.

- **UI language** follows the DSH language setting (Settings → General → Language): Chinese UI shows Chinese,
  English UI shows English. The starter phrases seeded on first run follow the UI language too
  (`Common` / `Code` for English); your own edits are never translated.
- **Paging**: 9 cells per page, up to 12 pages. The bottom bar shows `‹ 1/2 ›`, the current page name,
  `✎` (edit) and `✕` (hide).
- **Editing**: click `✎` → click a cell → edit name and text → Save. Empty cells create a new entry;
  right-clicking any cell jumps straight into its editor.
- **Insertion** uses the official `inputActions.insertText` API, so it inserts *at the caret* as one undoable
  edit instead of replacing the draft, and it is rejected (with a clear message) while a turn is sending.

### Install

Repository: <https://github.com/cm860712ch-cloud/dsh-quick-input> — package name on npm: `dsh-quick-input`.

1. DSH sidebar → **Plugins** → **Add plugin**
2. Paste the absolute path to this folder (or `dsh-quick-input` once published)
3. **Install** → **Enable** → refresh the page

### Where the presets live

`%DSH_HOME%\quick-input\presets.json` (default `C:\Users\<you>\.dsh\quick-input\presets.json`).
Delete it to get the starter phrases back.

### Offline self-check

```powershell
node dev\verify.mjs
```

147 checks across three layers: manifest, host half (routes, normalisation, disk writes) and browser half
(real render via `node:vm` + a mini React: registration, insertion, paging, editing, i18n). It does **not**
replace eyeballing the real page.

### Known limitations

- Docked left by default; if the space left of the composer is under 120px the pad falls back to a floating
  panel above it.
- No keyboard shortcuts are taken: Esc and digits still belong to the composer.


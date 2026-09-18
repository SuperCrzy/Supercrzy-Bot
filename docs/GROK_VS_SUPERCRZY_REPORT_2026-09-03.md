# GROK BOT 拆包研究报告 & SUPERCRZY BOT 差距对比

> 日期：2026-09-03
> 依据：① 刘小排文章《Grok Bot才是Jarvis》(mp.weixin.qq.com/s/Fxdy9y-TTS7a46YPMEK31Q)
> ② 本机 `/Applications/Grok Bot.app` v0.36.0 Electron 应用实拆（app.asar 反编译）
> ③ SUPERCRZY BOT 源码实证（packages/server/src）

---

## 一、Grok Bot 是什么（文章 + 实拆证据）

`Grok Bot` = **拥有本机+云端两台完整电脑权限、以当前最强模型为大脑、AI 全自主干活** 的桌面 Agent。作者用它替代了 OpenClaw/Hermes/Codex。

### 本地 app 实拆得出的技术构成（v0.36.0）

| 组件（app.asar 内）| 作用 | 证据 |
|---|---|---|
| `electron-main` | 主进程（2MB main-app + 1.4MB main-core）| 业务核心 |
| `local-exec-daemon`（3.5MB）| **本地电脑执行守护**，搞定"操作你电脑"| cursor×348 / display×168 / permission×170 / screenshot×72 / mouse / type / **OCR / VISION** |
| `node-agent-coordinator` | **多 Agent 协调** | Manager / Subagent / Worker 词汇高频 |
| `electron-preload` | 桥接 | — |
| `dist/deps/cursor-proclist` | 原生光标/进程监听 | cursor node 模块 |
| `dist/deps/tree-sitter`(+bash 等) | **代码语法树解析**（理解/改代码语境）| 多语言 bindings |
| Mantle / ReactiveObjC / Squirrel | macOS 原生 UI / 自动更新 | Frameworks |
| main-app/cil+core | **compute / sandbox / image** | 云端沙箱+生图能力标识 |

### 关键能力抽查（main-app.cjs 字符串计数）
`transcript`×12、`memory/recall/remember`、`browser`×5、`MCP`×6、`preview`×7
→ 佐证文章：抓 YouTube 字幕做博客、内置记忆"越用越懂你"、接浏览器、支持 MCP、能发布预览。

---

## 二、Grok 的护城河（文章主张的产品差异）

1. **双电脑权限**：本机 + 云端完整权限（云端优势≈无限算力+极快网速[作者称上传 4.3GB/s]），可当 Tailscale 出口节点。
2. **生图 + 生视频**：找不到截图就 AI 生成，交付出图文并茂成品。
3. **无障碍执行（"不装 B"）**：不因版权洁癖拒绝「看 YouTube→取字幕→截图→发布」这类综合任务。
4. **记忆/懂你**：自动读你 X/关注/历史，按"你会关心什么"过滤信息，而非给你全量噪音。
5. **数字员工**：读你产品全部数据 → 总结用户哪里不爽。
6. 架构上开放：**MCP**（接外部生态）、多 Agent（Manager/Subagent/Worker）、原生桌面控制。

---

## 三、SUPERCRZY BOT 当前真实能力（源码实证）

| 能力 | 我方现状 | 达到 Grok 级别? |
|---|---|---|
| 记忆 | ✔ services/memory-search / agent_memory / memory-RAG | 中（结构化表，无云端画像）|
| MCP | ✔ services/mcp-manager + routes/mcp | 等同 |
| 桌面控制 | ✔ services/computer-use（MCP 接入）+ 权限弹窗 | 同思路（computer-use-mcp）|
| 网页/浏览器 | ✔ services/ai-browser（Playwright 截图）+ 右栏浮层 | 基础到 |
| AI 浏览器实机 | ✔（上轮已实接）| 有 |
| 多模型协作/议院 | ✔ 串行引擎 + DeepSeek/Kimi 多品牌议院 | Grok 无此步(单人最强)；**我方差异化** |
| 收敛闭环/人控 | ✔ 质检/议院/优化 | Grok 偏自治 |
| 深度研究 | ✔（有 deep_research 骨架）| 需补齐 |
| **云端沙箱电脑** | ✘ 无 | **大差距** |
| **本机全方位自动化**(点鼠标/拖拽/OCR我画屏) | △ computer-use 存在但弱于 daemon 级 | 差距 |
| **生成图片/视频** | △ 有 draw_svg/占位，无真 image-gen 全流程 | 差距 |
| **技能/自我进化** | ✔ skill-evolve/maybeRepairSkill | 前沿 |
| 无障碍"不装B"自主执行 | ✘ 有安全收敛/审批，但非"全自主无人问" | 设计取向不同 |

数据来源：packages/server/src 实际 grep。

---

## 四、对比结论：**我们还要提升什么**（按优先级）

### 🔴 P0（决定"像真人全能助理"的差距）
1. **云端沙箱/云端电脑**（最大鸿沟）
   - Grok: 云端独立机器，Agent 能上传/下载大文件、跑重活、当节点。
   - 我方无。→ 需自建或接一个可编程沙箱（如可调度容器/VPS Node API）。
2. **本机全自动化执行升级**：把 computer-use 从"MCP 基本点击"提升到 Grok daemon 级——原生级 cursor/mouse/type/**OCR 读取屏幕我并回复**。我方 ai-browser 只控浏览器，没控整机。
3. **真·多模态生成闭环**：不只 svg 占位，要"找不到截图就调用 image-gen 真生成图、排版完成品"。这是文章反复强调的卖点。

### 🟡 P1（"懂你/好用"体感）
4. **主动记忆画像 + 机会雷达**：Grok "越用越懂你"——建议把我们已建 agent_memory 升级为**画像化 + 被 Agent 主动读取并据此过滤/推荐**（我们现在是存了但被动）。
5. **自动字幕/内容抓取链**:transcript(browser 拉字幕→截图→发布) 这条全能综合任务流要能一次自主跑完，需打通 ai-browser+OCR+mcp。

### 🟢 P2（架构/对齐）
6. **多 Agent Worker 化**：我方"议院串行/并行"是好差异化，可再融合 Grok 的 Manager/Subagent/Worker 常驻后台模式。
7. 生视频、跨设备发布预览（publish 插件）。

---

## 五、一句话总评

> **Grok 赢在"容器化的全能(双电脑+多模态+记忆)"，我们赢在"开放的协作+多模型议院+记忆/技能自进化架构"。**
> 最该追的不是模型(我们同样接最强/多品牌)，而是**把三种能力从"有"到"闭环可用"**：
> ① 云端沙箱算力  ② 本机 OS 级自动化(不只浏览器)  ③ 真生成与"一次跑完综合任务"。
> 这三样补上，就摸到"像真人一样替你干活"的边了。

---
*注：GroK 结论来自本机 app.asar 反编译与文章主张，非 xAI 官方文档；我方结论来自源码 grep。拆解文件存 /tmp/grok_as（可再深挖）。*

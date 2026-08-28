# WorkBuddy 架构与目录研究（2026-08-26）

> 目的：为 SUPERCRZY BOT 的模块化拆分提供对照参照（当前正在拆 ChatView/P0-1）。
> 研究对象：WorkBuddy Desktop 5.3.14（/Applications/WorkBuddy.app，app.asar 解包实测，version 5.3.14）
> 基于 08-19 引擎机制深挖 + 本次目录结构实测。

---

## 一、顶层架构：三层进程边界（WorkBuddy 模块化的核心哲学）

```
┌────────────────────────────────────────────────────────────┐
│ Electron 主进程（main/，约 90+ 个扁平 JS 文件）              │
│   入口 main/index.js → 窗口/IPC/深链/更新/菜单/安全          │
│   职责拆分成文件：auth/mcp/logger/fs-protection/crash...    │
└─────────────┬──────────────────────────────────────────────┘
              │ ACP HTTP（Agent Client Protocol）
┌─────────────▼──────────────────────────────────────────────┐
│ Sidecar 引擎进程（cli/dist/codebuddy.js，21MB Agent bundle）│
│   Agent 引擎：会话/模型/工具/思考/上下文（独立进程，隔离）    │
│   cli/vendor/：sandbox 沙箱 + ripgrep + trash              │
└─────────────┬──────────────────────────────────────────────┘
              │ HTTPS + keep-alive
┌─────────────▼──────────────────────────────────────────────┐
│ 模型 API（DeepSeek / 各家）                                │
└────────────────────────────────────────────────────────────┘
```

**核心结论**：WorkBuddy 的模块化 = **按进程边界硬切**，而非目录深嵌套。
- `renderer/`（前端 UI）是独立的渲染进程，打包成 assets/*.js chunk（源码不可见）
- `main/`（主进程）负责应用外壳
- `cli/`（sidecar）是真正干 Agent 活的引擎，独立进程隔离

---

## 二、目录实测（重点）

### 顶层（app.asar 解包后）
```
app.asar/
├── package.json          # main: main/index.js, version 5.3.14
├── main/                 # Electron 主进程（扁平 JS，约 90+ 文件）
│   ├── index.js          # 主入口
│   ├── acp.js            # Agent Client Protocol 通信
│   ├── auth.js           # 认证
│   ├── mcp.js            # MCP 连接器
│   ├── logger.js         # 日志
│   ├── fs-protection.js  # 文件系统安全
│   ├── cli-prewarm-pool.js # sidecar 预热池（核心加速）
│   ├── network-gate.js   # 网络安全
│   ├── menu-builder.js   # 菜单
│   ├── crash-reporter.js # 崩溃上报
│   ├── wechat-chat-history.js  # 微信聊天
│   └── ...（扁平，无深目录）
├── cli/                  # Sidecar Agent 引擎（独立进程）
│   ├── dist/codebuddy.js # 21MB 引擎 bundle
│   └── vendor/           # sandbox 沙箱 + ripgrep + genie-trash
├── renderer/             # 前端 UI（渲染进程，已打包）
│   ├── index.html
│   └── assets/*.js.css   # 编译产物 chunk（源码不可见）
├── preload/
├── native/
├── resources/
└── tencent-docs/         # 腾讯文档集成
```

### main/ 主进程的功能切分清单（模块化黄金参照）
按**单一职责扁平成文件**，一文件一能力：
`acp / auth / mcp / logger / fs-protection / crash-reporter / network-gate / menu-builder / cli-prewarm-pool / service / contract / handlers / http / gateway / readonly / daemon-* / desktop-monitor-* / wechat-* / tdoc-*` …

---

## 三、WorkBuddy 模块化哲学 → 对 SUPERCRZY 的启示

### 3.1 三层进程边界 = SUPERCRZY 的对应
| WorkBuddy | SuperCrzy | 状态 |
|---|---|---|
| renderer（打包前端） | packages/client（Vue3） | ✅ 已分 |
| main（Electron 主进程） | packages/desktop | ✅ 已分 |
| cli sidecar（Agent 引擎） | packages/server（Koa） | ✅ 已分 |

**关键差距：WorkBuddy 把 Agent 引擎做成独立 sidecar 进程（cli/），SUPERCRZY 的 server 也是独立进程（Koa 常驻）——进程边界已等价。** 这也说明 SUPERCRZY 的三层已符合业界做法，无需推翻。

### 3.2 主进程的核心手法：按单一职责扁平化，不深嵌套
- WorkBuddy 的 main/ 是**几十个扁平 .js**，每个负责一个横切能力（auth/mcp/logger/fs-protection），**不建深层目录**。
- **启示**：SUPERCRZY client 的拆分也可参照——**把大文件拆成"按横切职责"的扁平模块，而非追求目录层级**。

### 3.3 对当前 P0-1（拆 ChatView）的直接指导
WorkBuddy 前端虽然打包不可见，但其主进程的命名风格给了清晰范式：
- **不追求"一个功能一个大目录"，而是"一个职责一个文件"**。
- ChatView 6212 行 = 职责过多 → 应拆成：`chat-stream`(流式引擎) / `chat-actions`(分享/工具菜单) / `chat-UI-state`(UI 状态) 等**横切职责模块**，而不是"视图里建一堆子目录"。
- 这与我们方案一致（抽到 stores/ + composables/），WorkBuddy 印证了方向正确。

### 3.4 值得借鉴但当前不必做
- sidecar 预热池（SUPERCRZY 是常驻 Koa，无进程启动成本，无需）
- ACP 协议抽象（SUPERCRZY 用 SSE 直连，已够）

---

## 四、结论

WorkBuddy 的架构与目录 = **三层进程边界（renderer/main/sidecar）+ 主进程按单一职责扁平分文件**。**SUPERCRZY 的三层已等价实现，无需架构级改动**；模块化拆分只需在"包内"参照 WorkBuddy 的"一职责一文件"手法水平切分超大单例（ChatView/tools.ts/agent.ts），方向与我们已批准的方案一致。

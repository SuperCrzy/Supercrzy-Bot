# SUPERCRZY BOT 当前待办主清单（2026-08-27 晚整理）

> 综合 docs/SUPERCRZY_TODO(已过时)、HANDBOOK §6、GAP_FULL_2026-08-27、及 8-27 当天开发状态。
> 原则：先修"用户喜欢/稳定"（战略价值观），再补体验，远期看差异化。

## ✅ 8-27 已完成（含清单之外追加）勿重复
- 写文件卡片 / file_read 行号 / 撤销"显示更早 N 条"
- 开源快照 supercrzy-open / 开源 CI 修复
- provider 删中转留 13 + Token Plan 内部切换(mimo/qwen) + 实测 /models
- 生图 6 Provider / video_edit 剪辑
- **内联任务列表卡 PlanCard**（create_plan 挂对话流内 #N 标序 + 进度,对齐 WorkBuddy todo 卡）
- **图片产物落盘**：生成图下载按钮（DetailPanel 预览 + 对话图卡右下角, dataURL/URL 都支持）
- **权限多档 AcceptEdits**：后端 accept-edits 分支(自动批 file_write,拦 shell/delete) + 前端档位
- **历史消息按天分隔**：跨天插入"──今天/昨天/日期──"分隔线
- **主动记忆引导半做**：agent.ts Memory 段扩详细教学(何时存/召回/不存)
- **提问/授权框改造**：固定对话工作区居中(非全屏) + 从底部上滑 + 闪烁脉冲(提问框青/授权框紫)
- **修 ask_user 死工具**：复用 ask_question 交互链路
- **修提问选项 [object Object]**：后端 normalizeQuestionOptions + ask_user/ask_question 源头提取 label
- **修询问窗残留**：stopGeneration/done/error 三处清 pendingQuestion

---

## 🔴 P0（先做，直接影响稳定与体验）

### A. 架构稳定性（老板战略"更稳"核心）
- [ ] **并发隔离评估**：单进程 Koa+SQLite 多会话长任务互相占资源；幽灵多 Agent / 超长会话压在单进程。要不要 sidecar 独立进程（取舍评估，非立即做）
- [ ] **回归验证**：8-20~8-27 ~50 处改动仅过类型检查未全量回归；手动过：流式/思考/画图/读文件/刷新历史/多任务胶囊/搜索时效/记忆召回/生图/剪辑

### B. dev 仓库版本固话（防丢）
- [ ] **dev main 分支 200+ 处改动提交**（快照已兜底，但 dev 工作区仍是裸奔；提交意义=本地回退+渐进记录）
- [ ] 清理 dev 根目录杂项试验页（pet.html/snake/login.html/"SUPERCRZY BOT.app" 等，可先加 .gitignore，不删）

---

## 🟡 P1（补体验，用户价值导向）

### C. 体验补全（对照 WorkBuddy 已研究）
- [~] **记忆后台自动提取服务独立化**（现为每轮同步 memory-sync + 异步 reflection，非独立后台 service）
- [ ] **ChatView 瘦身**：实测 **6198 行** + **32 个 SSE case** 事件分发仍在组件内（打字机已抽到 chat-stream.ts；折叠状态机 foldTimers/applyCollapse + 打字机 stream 深度耦合，需专项目重构 + 折叠回归测试护航）
- [ ] **搜索 provider 抽象**：无 WebProvider 插件式抽象（Tavily/SearXNG 是硬编码搜索链）

### D. 双轨单轨化（技术债，root 根治 source）
- [ ] SINGLE_TRACK_MIGRATION_PLAN_2026-08-20.md 三阶段（根治 content/flow 同步 bug）

---

## 🟢 P2 / 远期（差异化 / 重投入）

| 事项 | 状态 |
|---|---|
| **App 真机打包验证 Electron**（desktop:dist dmg，需 GUI Mac） | 未做，化债：App 是双形态战略一半 |
| **App 自动更新签名** | 有用户后做（mac 签名/Win CodeSign） |
| **开源 push（supercrzy-bot 新仓库）** | 快照已就绪，remote 换新仓库名后 push |
| **新闻生态接入**（差异化：自带内容源的 Agent） | 技术路线/形态待定（news_search 工具/skill 包/简报/热点） |
| **AI 同事协作 / ACP 协议** | 大投入，多 agent |
| **知识库 RAG** | 远期，依赖搜索+记忆 |
| **手机版 Capacitor** | 暂缓 |
| **云服务化**（邮箱登录/多用户/云端搜索后端） | 未来 |
| **创新候选 I-4~I-9**：自适权限/记忆遗忘/省钱引擎(复杂度→模型路由)/错误自愈/产物中心/专家团路由 | 按需评估 |
| **tunnel 默认开启** | 8-12 遗留，核实现状 |
| **真虚拟列表** （react-virtuoso 式窗口化，需高度测量） | 列后续 |

---

## ⚠️ 备注
- 快照 supercrzy-open 会过期：下次开发后再 rsync + commit（命令在快照 README-SNAPSHOT.md）
- Token Plan 端点会变：做成"预设+可自填"，维护成本低；国家超算等可后续配 planBaseUrl 字段加

# AI 自主驾驶浏览器 · 端到端流程规格（2026-09-03）

> 目的：让用户对 AI 说一句目标（"去某站搜X、点第一个、读给我"），AI 自主驱动浏览器办完，
> 全程右边实时给他看画面、对话区给动作轨迹，人可随时接管/改道。
> 本文把每环节、数据流、并发/失败/人机切换全部写死，供直接实现。

---

## 0. 三个对象（职责单一）
| 对象 | 文件/位置 | 职责 |
|---|---|---|
| **Driver(驾驶器)** agent 循环 | 复用 runAgentLoop；注入 browser 工具集 | 每轮 LLM 决策→调 browser 工具→等结果→再决策，直到 done/fail |
| **Bridge(桥)** 唯一全局面板** aiBrowserDriver | services/browser-driver.ts（新）| 持一个浏览器实例；是 AI 动作与前端画面的**唯一汇合点**（一次只有一方在开）|
| **Panel(壳)** 右栏 DetailPanel | 现有 browser tab 升级 | 展示画面 + 顶部"谁在开"，接收 feed |

---

## 1. 一次会话的完整状态机（核心）
`idle → user_goal_received → ai_running → (human_takeover → human_active → return_to_ai) → ai_running… → done | failed`

每态必须定义清楚。

### 1.1 触发（idle）——【2026-09-03 老板改定】不靠用户点名
- **浏览器是 AI 的普通工具之一，按需自我唤醒，不做特殊模式、不要求用户说"用浏览器"。**
- 判定：AI 在推进任务时自己判断"需要 →"就触发：
  - 要上网核实事实来源 / 拿一个网页实时精确内容（比 web_search 摘要更完整）→ 需要浏览器；
  - 要看**视觉/排版/截图长啥样**（页面真实外观、按钮在哪、响应式、有无坏图）→ 必须浏览器（LLM 视觉看截图）；
  - 要在某网站内执行交互（点某结果、填某字段、翻页、查某账号里的数据）→ 浏览器。
- 一旦它判定，就自动把该目标交给 Driver（右栏自动切/浮 badge"AI 正在用浏览器"，用户无需操作）。
- 非可视化/非网页内交互的普通查询 → 不进浏览器，走 web_search/问答（省资源）。

### 1.2 开启驾驶（user_goal_received）
- **模式默认"接住已有登录会话当用户登录过"**：浏览器保留用户登录态 cookie（用户曾在里面登过 BOT 就用登录后的会话，不代填帐密）。见 1.7。
- 若目标含**系统认为需凭据/账号敏感**的动作 → 打开 1.7。
- 面板置 ai_running；对话加系统行 "AI 开始驾驶浏览器：<目标>——右侧可实时看；想接管点右上暂停"；右栏 autofocus browser tab/浮 badge。
1. Bridge 检查浏览器可用（Chrome OK / key 有 / full 或无 sensitive）。
2. 若目标含**敏感**(下单/支付/登录/发公开内容)—— spec 默认当前**不强行全自主**，改走 ask_confirm（1.7）。
3. 面板状态置 ai_running；对话追加系统行"AI 开始驾驶浏览器：<目标> —— 右侧可实时看；想接管点右上"。右栏 autofocus browser tab（若用户在别的 tab 也给它浮动 badge "AI 正在用浏览器"）。

### 1.3 AI 决策循环（ai_running，Driver 内 while）
每轮严格顺序：
1. **看一眼屏**：Bridge 截图(P1) + 读 URL/title。把截图压缩后连同**可交互元素清单**（l3 命名 anchor "#3 → button『Learn more』") 打包给 LLM。
2. **LLM decide**：输出 {"action": navigate|click|type|back|scroll|done|ask_user, "arg": {url/text/text_into/selector/key}, "note": 给用户的一句话"我正要做…"}。
3. **执行**：Driver 调对应 browser 工具（走 Bridge）。结果 = ok + 新 URL + 是否页面变了。
4. **每步 3 件事同步给前端（这一步关键，见 §3 消息协议）**：①对话区追加一条动作卡（可折叠：工具名+note+当前URL）②右栏刷新画面 ③Bridge 若动作改变了 URL/可点元素显著变化，喂新结构给下轮。
5. **是否结束判定**：LLM 若 judge "目标已达成" → 输出 done + 把拿到内容整理成正常答复 → 撞 user 回；判"做不到/死循环"→ failed（原因给 user；≤ step 上限或 ≤ ~90s）。

### 1.4 并发/节流规定
- **一次只一个动作**（点完→刷新→再看）不做多并行点击（网页是顺序态）。串行；永不并发浏览器动作。
- 截图每次最多 ~<=90KB jpeg；可交互清单 ≤ 60 条；防 context 撑爆：当某站已在 context，后续只给"网址变了才换新清单"，否则回 "仍在上站X"。
- 整体该驾驶任务 ≤ (约)12 浏览器动作 或 2 分钟，防无限开。

### 1.5 右栏画面（人盯）
- 右栏 = 当前页截图实时刷（AI 每次动作/到达就刷新 base64）。
- 在截图上方加一行状态胶囊：`AI 驾驶中 (第3步: navigate) · 点画面或按⏸ 接管`。
- 在截图 top 绘一层 `:hover` 高亮正在操作的元素（可选进阶）。先给"看到截图 + URL + 步骤数"即可。

### 1.6 人接管（human_takeover，UI 右侧）
- 右栏出现 `暂停` 按钮（或你在画面点一下即暗示接管）。
- 按 → Bridge.setState(human_active)。**Driver 收到"stop 请求"**（复用 requestStop）在下一个动作前停下；已发的不落库。
- human_active：你能直接在画面里点/输入（已有点击→click_at + type）。画面仍实时；对话加一条"你已接管，可操作画面；完成后说‘继续’让 AI 接手"。
- 你不再动 >8s 或说"继续" → 切回 ai_running（把当前 URL/新清单给 LLM 它继续）。

### 1.7 登录 / 账号凭据 ——【2026-09-03 老板改定：一律 user 本人，AI 不代填】
要点：**AI 从不持有/代填账号密码**。凡进入需登录/凭据页面：
1. Driver 检测到需要登录的步（登录页/401/被引导到 login）→ **暂停自主**，把控制交给用户（画面切给你、光标回到你）。
2. **由你本人输入账号密码登录**（或站跳转/二次验证都由你完成）—— AI 不参与、不偷看、不代填。
3. 登录完成 → driver 用这个"已登录会话"继续后续任务（拿的是你登录后的权限）。
4. 登录态：driver 实例保留该站 cookie → **Driver 主动问**："记住这个网站的登录态，下次 AI 直接用已登录会话（不用你再登）？[记住] [本次用完即清]" —— 你选。
   - 「记住」→ 存浏览器 profile（下次打开即已登录）；
   - 「清」→ 本次结束销毁私密留痕。
> 对"AI 下单/在已登录会话做动作"不单独拦（账号已授权、是你登录后环境延伸）；真正的红线是**凭据只能本人输入**。把"自主干活"与"凭据安全"分开 —— 干活可自主、登入只本人。

### 1.8 结束交付（done/failed）→ 回 idle
- done: 对话区给最终可读结果（翻译/摘录/数据/动作汇总"我在 X 站做了 3 步拿到…"），右栏停，状态回 idle，browser tab 保留画面（可你继续人用）。
- failed: 对话区诚实给原因 + 它试过的步骤 +建议（"该站需登录/没搜到/超时"），建议你手动或改目标。

---

## 2. 消息协议（AI/前端之间 §3 定义的每条）
Driver → 前端 的 Feed 事件为 SSE (沿用 /api/chat)。新增事件：
- `browser_state {phase, step, note, url, action}` 对话动作卡+
- `browser_frame {jpegBase64, url, ts}` 右栏画面（节流:动作后推，最多 ~2/s）
- `browser_ask {prompt, confirmId}` 敏感确认
- `browser_human {reason}` 你接管时的广播
前端 → Driver（fetch 现有 act/navigate 或经 Driver 暴露）：
- user "接管"/"继续" toggle。

前端触发结构：ChatView(发驾驶目标→收到第一帧自动开右栏browser tab) + DetailPanel(browser tab 消费 browser_frame/browser_state，渲染动作胶囊可点开；接管按钮调用 /api/collab/browser/takeover )。

---

## 3. 前置缺口核对（实现清单）
| # | 要做 | 现况 |
|---|---|---|
| D1 | agent 循环暴露 browser 工具集(navigate/click/type/back/render清单)供 LLM 自主 | agent 未 import ai-browser；工具未注册 → **新注册** |
| D2 | Bridge 单例 + browser-driver.ts：把"动作→截图/元素清单→下一轮/喂前端"串成一个可暂停可接管的状态机 | 无 → 新建 |
| D3 | 动作执行统一回调：每次动作后把第3帧推 + 判定 URL/结构变化 | 现前端是前端 fetch，无 AI 驱动帧 → 新增 |
| D4 | 截图轻量化 feed(≤90k) + 可交互清单进 LLM 亦进 UI 轨迹 | 有 → 需节流打包 |
| D5 | 敏感步 ask_confirm(1.7) + 全程 stop/接管(1.6) 与现有 requestStop 挂钩 | 现有 stop 主体；接管要扩 |
| D6 | 前端 ChatView 触发 + DetailPanel 消费 browser_* 渲染动作卡/画面/接管钮 | 现有 tab 是纯 fetch → 升级 |

优先级建议 D1→D2→D3/D6(前端一对) →D4 →D5。

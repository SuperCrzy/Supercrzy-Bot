# Stripe 收购 OpenRouter 深度研究报告

> 调研日期：2026-08-23 | 数据源：Stripe newsroom、OpenRouter 官方博客、CNBC、TechCrunch、The Information 转载、Payments Dive、menuagentic、Forbes、Bloomberg（均为 8/16-8/23 一手/权威报道，已交叉验证）

---

## 一、交易全景：从 13 亿到 70 亿的 82 天

### 1.1 交易时间线

| 时间 | 事件 |
| --- | --- |
| 2023年2月 | Alex Atallah（OpenSea 联合创始人/CTO）创立 OpenRouter，联合创始人 Chris Clark（COO）、Louis Vichy（CTO，Atallah 在 Discord 结识） |
| 2025年6月 | 完成 4000 万美元种子+A轮，估值约 5.47 亿美元 |
| 2025年12月 | Stripe 宣布收购 Metronome（约 10 亿美元，按量计费平台，2026年1月完成） |
| 2026年3月 | Stripe 在 Billing 内推出 LLM token 计费 |
| 2026年4月 | Stripe Sessions 发布流式支付（Stream Payments，按 Token 实时结算） |
| 2026年5月26日 | OpenRouter 完成 1.13 亿美元 B轮，估值 13 亿美元（CapitalG 领投） |
| 2026年7月23日 | WSJ 首次报道 Stripe 洽谈收购，传估值约 100 亿美元 |
| 2026年8月16日 | Bloomberg 确认交易落定，价格超过 70 亿美元 |
| 2026年8月19日 | Stripe 与 OpenRouter 正式宣布（官方公告，未披露金额） |
| 预计数周内 | 完成交割（customary closing conditions） |

### 1.2 价格与结构

- **金额**：媒体口径不一——NYT 报道 75 亿美元、Bloomberg "over $7 billion"、FT 报道约 80 亿美元。双方官方均未披露。
- **分配**（NYT）：创始人获约 15 亿美元，投资者获约 60 亿美元。
- **估值对比**：82 天前 B轮估值 13 亿美元 → 本次约 70-75 亿，**5.4-5.8 倍溢价**；对应约 **50 倍市销率**（年化收入约 1.4 亿美元，The Information 2026年7月数据，半年增长约 3 倍）。
- **竞购**：Stripe 击败了包括 **Databricks** 在内的竞购者。
- **定位**：Stripe 成立以来最大一笔并购（此前最大为 Metronome 约 10 亿美元）。

### 1.3 关键判定

50 倍市销率不是为当期盈利买单，而是为**战略卡位**支付溢价：买的是"AI 时代模型调用流经谁的口袋"。

---

## 二、OpenRouter 是什么：模型路由的"交换机"

### 2.1 业务本质

OpenRouter 是一个**智能反向代理/模型聚合网关**：一个 OpenAI 兼容 API，背后聚合 80+ 供应商、400+（官方口径，部分报道称 500+）模型。开发者改一行 `base_url` 即可在任意模型间切换，或使用 `openrouter/auto` 自动路由。

### 2.2 核心运营数据（截至 2026年8月）

| 指标 | 数值 | 来源 |
| --- | --- | --- |
| 日处理 token | 10+ 万亿（官方博客）；约 25 万亿/周（2026年中，6个月前约 5 万亿/周） | OpenRouter 官方 / menuagentic |
| 开发者/公司用户 | 1000 万+ | OpenRouter 官方 |
| 基于其构建的应用 | 25 万+，触达 420 万用户 | happyrock 编译 |
| 供应商 / 模型 | 80+ / 400-500 | 官方 / 多源 |
| 团队规模 | 约 90 人（官方博客口径；PitchBook 早期数据 48 人） | 官方 / PitchBook |
| 年化收入 | 约 1.4 亿美元（2026年7月） | The Information |
| 边缘延迟 | 大多数请求仅增加 15-25ms | happyrock 编译 |

### 2.3 商业模式

- **收入模式**：对开发者购买 Credits 收取 **5-5.5% 平台服务费**；BYOK（自带密钥）100 万免费请求/月后收 5% 费用。模型供应商列表价格透传，无 token 加价。
- **毛利率**：接近纯软件水平（推理成本透传给客户）。
- **人均产出**：按 48-90 人计算，人均年化收入约 160-290 万美元，处于顶级软件公司水平。
- **差异化能力**：多维路由决策（成本/延迟/能力/健康监控/故障切换）、零完成保险（失败不收费）、以 token 粒度的用量计量——最后一项是 Stripe 支付溢价的真正原因。

---

## 三、Stripe 为什么买：从支付通道到 AI 操作系统

### 3.1 战略拼图（两年收购链）

| 时间 | 收购/发布 | 回答的问题 |
| --- | --- | --- |
| 2025年12月 | 收购 **Metronome**（~10亿美元，按量计费引擎） | "怎么计量" |
| 2026年3月 | Billing 内置 LLM token 计费 | "怎么计费" |
| 2026年4月 | **Stream Payments** 流式支付（按 token 实时结算） | "怎么结算" |
| 2026年8月 | 收购 **OpenRouter**（~70亿美元，模型路由） | "路由什么 / 钱从哪流经" |

Stripe Sessions 2026 的主题即 **"building the economic infrastructure for AI"**（构建 AI 的经济基础设施）。

### 3.2 闭环逻辑

- **OpenRouter（路由层）**：决定一次任务调用哪个模型、流经哪条路径——掌控"智能流（intelligence flow）"。
- **Metronome + Stream Payments（计量结算层）**：把每次调用的 token、成本、归属方记成可审计的账本——掌控"资金流（money flow）"。
- **Stripe 支付（结算层）**：最终收钱。
- **Agentic Commerce Suite**（x402 协议、MPP 机器支付、Link Agent 钱包授权）：为"Agent 替用户花钱"的未来铺路。

### 3.3 官方口径

- Stripe 公告标题：*"Stripe agrees to acquire OpenRouter to help businesses optimize token routing and usage"*——帮助企业优化 token 路由与用量。
- 泄露的 Stripe 创始人致投资者信（Eric Newcomer 发布，TechCrunch 验证）：半开玩笑提到 "the singularity"，1月1日视为奇点起点；信中称 "OpenRouter is exceptionally useful for any developer and Stripe is one of the world's largest developer platforms"。
- Stripe 数据：88% 的 Forbes AI 50 公司使用 Stripe（含 OpenAI、Anthropic）；100% 的 Brex 增长最快创业公司使用。
- OpenRouter 官方博客承诺：**保持独立运营**——同名、同产品、同路线图；路由决策只基于"对用户最好"；使命是"智能将是多模型的（intelligence will be multi-model）"。

### 3.4 真正的稀缺资产：不是路由，是账本

menuagentic 的深度拆解（*Stripe bought the meter, not the router*）指出：AI 网关的五个职能（路由/故障切换、密钥托管、缓存、策略执行、**计量与归因**）中，前四个"一个周末 + 一个 Redis 实例"就能做，唯独第五个随规模增长越来越难：

- 跨供应商归一化（不同字段名、缓存命中口径、reasoning token 处理、各自调价）；
- 把花费关联到结果（每 Agent 任务、每租户、每任务成本）；
- 强制（预算超限时拒绝下一次调用——成本控制与成本报告的分水岭）。

聚合整个开发者生态的这套账本，会从运营工具变成**市场数据**：哪些模型在哪些品类增长、什么价格、比任何供应商披露早数周。加上 Metronome（同一笔交易的另一侧，为 AI 供应商计量），一家公司能同时看到"什么在被买"和"什么在被卖"——这才是可防御的资产。

---

## 四、行业影响

### 4.1 对开发者生态

- **短期无感，长期改变归属**：延迟不变，变的是"组件路线图归谁所有、为谁优化"。
- **费率结构性担忧**：5% 的"循环深度税"——Chat 1 次调用是小钱，Agent 完成任务 10-40 次，失败重试 60+ 次——**费用最高的时刻恰是运行产出为零的时刻**。按花费比例收费的网关，激励与用户利益存在错位。
- **可用性乘数下降**：99.9% 网关 × 99.9% 供应商 ≈ 99.8% 总体可用性；网关成为新的单点。
- **建议**：保持自有供应商账户作为 bypass、验证 fallback、用 OpenAI 兼容接口而非厂商 SDK、合同关注费率条款与用量数据可导出性。

### 4.2 对竞争格局

| 玩家 | 动向 |
| --- | --- |
| **Databricks** | 竞购失败，自研 Unity AI Gateway |
| **Cloudflare** | AI Gateway 是 OpenRouter 最直接竞品，面临"支付巨头入局"压力 |
| **Rippling / Ramp** | 均在 8 月推出 AI 支出管理/ROI 工具，卡位"AI 费用管理"赛道 |
| **模型供应商（OpenAI/Anthropic/Google）** | Stripe 掌握其 API 调用流量数据与分发通道，议价关系微妙（Stripe 同时是它们的支付服务商） |
| **PitchBook 分析师 Franco Granda** | 评论：这是 Stripe "刻意嵌入 AI 时代资本流中心" |

### 4.3 对中国 AI 生态的影响

- **OpenRouter 是中国开源模型最大的国际分发渠道**（DeepSeek、Qwen、GLM、Kimi 均在其列，也是 supercrzy.com Rank 榜关注的中国模型在海外的主力出口）。
- 被 Stripe 收购后，中国模型的出海通道、路由中立性、结算通道（涉及跨境支付合规）成为关注点。
- 云厂商与模型公司对"中间层"（网关/计量/结算）的争夺会加速。

### 4.4 风险与不确定性

- **独立性承诺 vs 整合压力**：官方承诺独立运营，但 70 亿美元收购后路线图终将向 Stripe 的计费/支付闭环倾斜。
- **路由商品化**：开源代理与超大规模云都在做路由，5% 费率模式的可持续性承压（开源模型 + 价格战）。
- **监管**：非直接竞争者收购，预计反垄断阻力低，但跨境数据与支付合规（尤其涉中国模型流量）需观察。
- **人才**：OpenRouter 90 人团队并入 Stripe 的保留与激励（创始人已获 15 亿美元对价）。

---

## 五、结论

1. **交易本质**：Stripe 用成立以来最大一笔并购（约 70-75 亿美元、50 倍市销率），买下"AI 推理流量入口 + token 计量账本"，完成"路由 → 计量 → 结算 → Agent 支付"的 AI 经济基础设施闭环。
2. **稀缺资产是账本不是路由**：路由正商品化，跨供应商、可归因、可强制执行的用量账本才是护城河。
3. **格局影响**：支付巨头正式入局 AI 中间层，Cloudflare/Databricks/Ramp 等直接承压；模型供应商的流量与支付双重依赖 Stripe，权力格局微妙变化。
4. **对开发者**：短期无感、长期需重新评估网关依赖；"按花费比例收费"的激励错位在 Agent 时代会被放大。
5. **对中国生态**：OpenRouter 作为中国开源模型出海主通道，其"去中立化"风险值得持续跟踪。

---

*报告完。主要来源：Stripe Newsroom、OpenRouter Blog、CNBC、TechCrunch、Payments Dive、Forbes、The Information（经转载）、menuagentic、Bloomberg、WSJ。*

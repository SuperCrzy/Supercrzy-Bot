# WorkBuddy 折叠逻辑深度研究报告（2026-08-25）

> 来源：解包 /Applications/WorkBuddy.app/Contents/Resources/app.asar（cb-chat-ui 包，270MB bundle 实代码提取）
> 目标：搞清 WorkBuddy 折叠的**时间**（何时折）、**技巧**（怎么折）、**关系**（谁折谁豁免），对照 SUPERCRZY 折叠实现找差距

---

## 一、全景：折叠是"两级 + 一个开关"

```
isCompactMode = true   ← 硬编码开启（聊天视图默认紧凑模式，非可选）
        │
        └─> enableMetaFold
              │
      ┌───────┴────────┐
      ▼                ▼
  L1 段级折叠         L2 turnFold
 (执行中,逐段折)     (完成态,整体折)
 computeFoldResult   turnFoldActive
```

- **折叠默认全开**：`const isCompactMode = true`，`enableMetaFold: isCompactMode`——WorkBuddy 的聊天界面**折叠不是可选项，是默认形态**（8/21 研究文档曾写"紧凑模式开关下才启用"，实际代码硬编码 true）。
- **数据模型**：消息 = content blocks 顺序数组（`reasoning` / `tool-call` / `text` / 其他），折叠基于这个数组做分段。

---

## 二、折叠关系：什么能折、什么豁免

### 2.1 可折叠判定 `isFoldableContent(content, isUnfoldable)`

| 内容类型 | 可折叠？ | 说明 |
|---------|---------|------|
| `reasoning`（思考） | ✅ 永远可折叠 | |
| `tool-call`（工具） | ✅ 默认 | 但三个豁免 ↓ |
| ↳ `show_widget` 工具 | ❌ 不折 | `SHOW_WIDGET_NAMES` = show_widget / visualize:show_widget 等——**图是交付物，常显** |
| ↳ 微信支付卡 | ❌ 不折 | `isPaidWeixinpayContent` |
| ↳ 宿主 unfoldable 谓词 | ❌ 不折 | 如 agent-mail 业务错误卡片（`unfoldableToolCall` 注入） |
| `text`（正文） | ❌ **永不折** | **text 不是 foldable 项**——正文是"锚点/内容"，不是"过程" |

**关键**：WorkBuddy 里**可折叠的只有思考 + 工具**，正文（text）永远不属于折叠对象。折叠条里装的永远是 reasoning/tool，正文原位保留。

### 2.2 分段规则 `computeSegments`（段 = 折叠的最小单位）

```
连续 ≥2 个 foldable 项（thinking/tool）→ FoldableSegment（可折叠段）
连续 1 个 foldable 项            → NormalSegment（不折，直接显示）
```

- **单个工具不折叠**：只有连续 2 个以上思考/工具才聚成可折叠段。单工具直接平铺显示。
- 分段带 stats（`computeMetaFoldStats`：toolCallCount / messageCount / errorCount）和 topToolName（首个工具名做图标）。

---

## 三、折叠时间：三个时机（核心）

### 3.1 时机一：段级折叠（执行中）——"段后有正文就折"

```js
function computeFoldResult(allContents, hasEnd, enableMetaFold, isRunning, isUnfoldable) {
  if (!enableMetaFold || allContents.length < 2) return EMPTY_FOLD;
  if (hasUnfoldableToolContent(allContents, isUnfoldable)) return EMPTY_FOLD;
  const segments = computeSegments(...);
  if (!segments.some(s => s.kind === "foldable")) return EMPTY_FOLD;

  let bodyTextAfter = false;
  for (let i = segments.length - 1; i >= 0; i--) {   // ← 从后往前扫描
    const seg = segments[i];
    if (seg.kind === "foldable") seg.shouldFold = bodyTextAfter || hasEnd;
    else if (seg.items.some(isBodyText)) bodyTextAfter = true;   // ← 遇到正文标记
  }
  if (!segments.some(s => s.kind === "foldable" && s.shouldFold)) return EMPTY_FOLD;
  ...
}
```

**核心逻辑 = 从后往前扫描，每个可折叠段问一句："你后面还有正文吗？"**
- `seg.shouldFold = bodyTextAfter || hasEnd`
  - **后面有正文 → 折叠**：说明这只是中间过程，后面还有结果要出 → 收起来等结果
  - **流结束（hasEnd）→ 全部折叠**：不管后面有没有正文，结束了就全收
- **这段判定不需要等 done**：只要模型在工具之后输出了正文（哪怕正文还在打字机播），前面的工具段立即折叠——**这就是 WorkBuddy 折叠"快"的原因**。

> 与我们对照：我们用"800ms 延迟确认"判断"后面还会不会有工具"，WorkBuddy 用"段后面是否已经有正文"判断——前者是前瞻（赌），后者是回看（确定）。**回看更稳，不会误折叠。**

### 3.2 时机二：turnFold（完成态整体折叠）

```js
const turnFoldActive =
  enableMetaFold &&          // 开关
  hasEnd &&                  // 流结束
  !isReceiving &&            // 不再接收
  lastBodyTextContent != null &&  // ★ 有最终正文才整体折
  allContents.length > 1 &&  // 多于一个内容块
  !hasUnfoldableTool;        // 无豁免工具

const [turnCollapsed, setTurnCollapsed] = useState(() => turnFoldActive);
useEffect(() => { if (turnFoldActive) setTurnCollapsed(true); }, [turnFoldActive, groupIdentity]);
```

- **turnFold 触发 = hasEnd && !isReceiving 的瞬间**（effect 强制 setTurnCollapsed(true)）。
- **★ 关键条件 `lastBodyTextContent != null`**：**有最终正文才整体折叠**。纯工具任务（无正文）不折叠——折叠的意义是"过程收起来只留结果"，没结果就不折。
- 折叠后消息收成头部（Avatar + 折叠条），只渲染锚点 + widget。

### 3.3 时机三：工具结果卡片级折叠（ToolCallBlock）

- 工具卡片结果默认折叠（`card-content hidden: !resultVisible`），点击展开；`defaultShowResult` 控制执行中是否展开（紧凑模式下执行中默认不展开）。

---

## 四、折叠技巧：折叠条怎么"讲清楚发生了什么"

### 4.1 锚点选择：最长正文，不是最后正文

```js
function computeTurnFoldAnchors(allContents) {
  const bodyEntries = [];
  let maxLength = 0;
  allItems.forEach(item => {
    const length = getBodyTextLength(item.content);  // text.trim().length
    if (length <= 0) return;
    bodyEntries.push({...item, length});
    if (length > maxLength) maxLength = length;
  });
  if (bodyEntries.length === 0) return [];
  const anchorIndexes = new Set();
  for (const entry of bodyEntries) if (entry.length === maxLength) anchorIndexes.add(entry.index);
  ...
}
```

- **折叠后保留的正文 = 长度最大的正文段**（并列最长都保留）。
- 不是"最后一段"——防止"中间说明很长、最终结果很短"时把结果折掉。
- `buildTurnFoldSegments` 把整轮切成：**hidden（折叠条内容）+ anchor（最长正文，常显）+ widgetContents（图提升到末尾）**。

### 4.2 摘要：工具语义原子，不是数字统计

```
computeFoldSummary(items)
  → extractAtom(tool)：工具名(canonical) + 动作词(actionKey) + 参数压缩对象(object) + 状态
  → selectSummary(atoms)：决策（运行中/已完成/失败/混合）
  → renderTemplate(decision)：渲染成一句话
```

- 折叠条文案 = **"搜索 AI 行业新闻"** 这类**动词+宾语**语义摘要，不是"工具 5 次"。
- 参数对象压缩（`compressObject`）只保留关键字段，避免长参数撑爆折叠条。
- 运行中显示 isRunning 状态（"正在搜索…"），完成显示静态统计。

### 4.3 展开：分批展开，防 DOM 爆炸（★ 最重要技巧）

```js
function computeVisibleStart(itemCount, itemCosts, batchCount, maxItems = 15, maxChars = EXPAND_MAX_CHARS) {
  // 从最新内容往前数：每批最多 15 项 + 字符预算，batchCount 决定批数
  // 点一次「显示更早」→ batchCount+1 → 再往前显示一批
}
```

- **展开不是一次性全展开**：从最新内容开始，每批 ≤15 项 + 字符预算（EXPAND_MAX_CHARS）。
- 折叠条头部有"显示更早"按钮，点一次加一批；**折叠再展开不重置**（保留用户进度 batchCount）。
- **长任务（30 轮工具）展开不卡**——只渲染最近的 N 批。

### 4.4 耗时：真实时钟计算

```js
function computeTurnDurationMs(hasEnd, group, allGroups, groupIndex) {
  // startTime = 本轮第一条 user 消息的 createTime
  // endTime = 结束时间 → 折叠条显示"已完成 1m23s"
}
```

- 从消息的真实 createTime 算，不是前端计时器（刷新/重连不丢）。

---

## 五、折叠关系总结图

```
消息 = [思考1 工具1 思考2 工具2 说明text 工具3 正文text(结果)]
                  │
        computeSegments：连续≥2 foldable 聚段
                  │
  [foldable段(思考1工具1思考2工具2)] [text说明] [tool3] [text结果]
                  │            │         │        │
  从后往前：bodyTextAfter=true → 折叠   不折    不折   锚点(最长正文)
                  ▼
  执行中：折叠条(MetaFold)  ←—— 摘要: "搜索 xx" + stats
                  │
  hasEnd && 有正文 → turnFold 整体折叠
                  ▼
  [Avatar头部 + MetaFold折叠条] + [text结果(锚点)] + [show_widget图]
                  │
  点击展开 → 分批显示（15项/批）
```

---

## 六、与 SUPERCRZY 折叠实现对照

| 维度 | WorkBuddy | SUPERCRZY 现状 | 差距/借鉴 |
|------|-----------|---------------|----------|
| **折叠时机** | 段后有正文即折（回看）+ 流结束全折 | 800ms 延迟确认（前瞻）+ done 全折 | WB 判定稳不误折；我们的 800ms 是补偿"工具节点卡死"的次优解 |
| **正文处理** | text 永不折，正文是锚点 | text 段也折叠（只留最后一段）| 我们更激进（用户需求驱动）；WB 把工具间说明当正文保留 |
| **锚点** | **最长正文**（防说明比结果长）| 最后一个 text 段 | **可借鉴**：防"中间说明长"边缘 |
| **单个工具** | 不折（≥2 才聚段）| 收进折叠条 | 可借鉴：单工具直显更清晰 |
| **摘要** | 工具语义（动词+宾语+参数压缩）| 静态统计（N 次工具·M 轮思考）| **可借鉴**：语义摘要信息密度高 |
| **展开** | **分批（15项/批+字符预算）** | 一次性全展开 | **可借鉴**：长任务展开防 DOM 爆炸 |
| **豁免** | show_widget/支付卡/宿主谓词 | 无（图靠 diagram 段常显）| 已用 diagram 段实现等价能力 |
| **折叠开关** | isCompactMode=true 硬编码 | processCollapsed 运行时态 | 均默认折叠 |

### 六点可落地的借鉴

1. **锚点用"最长正文"**：替换"最后一个 text 段"，防中间说明比最终结果长时把结果折掉（MessageFlowRenderer shouldShowText）。
2. **摘要语义化**：折叠条从"3 次工具调用 · 2 轮思考"升级为"搜索 AI 新闻 · 读取 src/utils.ts"，用工具名+参数宾语生成（需工具描述注册表，我们 tools/registry 已有雏形）。
3. **展开分批**：`computeVisibleStart` 同款——折叠条展开时只渲染最近 15 项+字符预算，"显示更早"按钮加批。
4. **单个工具不折叠**：连续 1 个工具保持直显（我们当前全收）。
5. **豁免清单**：show_widget 类工具卡片不折叠（我们用 diagram 段已等价，但工具卡片本身仍可豁免）。
6. **耗时用真实 createTime**：elapsedMs 已实现（done 时算），对齐。

---

## 附：关键代码位置（asar bundle）

| 逻辑 | 函数 |
|------|------|
| 折叠总开关 | `isCompactMode=true` → `enableMetaFold` |
| 可折叠判定 | `isFoldableContent` / `classifyPart` |
| 分段 | `computeSegments`（≥2 foldable 聚段）|
| 段级折叠判定 | `computeFoldResult`（`shouldFold = bodyTextAfter \|\| hasEnd`）|
| 整体折叠 | `turnFoldActive`（hasEnd && !isReceiving && 有正文 && >1 && 无豁免）|
| 锚点 | `computeTurnFoldAnchors`（最长正文）|
| 折叠后结构 | `buildTurnFoldSegments`（hidden+anchor+widget）|
| 折叠条组件 | `MetaFold`（stats+summary+headIcon+分批展开）|
| 摘要 | `computeFoldSummary` → `extractAtom` / `selectSummary` / `renderTemplate` |
| 统计 | `computeMetaFoldStats`（toolCall/message/error）|
| 分批展开 | `computeVisibleStart`（15项/批 + EXPAND_MAX_CHARS）|
| 耗时 | `computeTurnDurationMs`（user createTime→end）|

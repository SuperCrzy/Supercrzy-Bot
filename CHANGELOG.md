# CHANGELOG

> SUPERCRZY BOT 版本更新记录。最新版本在顶部，历史版本完整保留。
> 此文件为官网更新日志页的数据母版；应用内弹窗仅展示当前版本。
>
> **发布节奏（2026-10-18 起）：每周发布一版。**
> 周期内累积的修复与新功能统一进本文件对应版本；版本号按 `MAJOR.MINOR.PATCH` 递增，
> 补丁类修复走 PATCH，含新能力走 MINOR。

---

## v1.3.8 (2026-11-24) — 目标可见，过程可读

### 新功能

- **长任务的回复可以读懂了。** 完成后的回复不再是"一大段结果 + 一条把过程全吞掉的折叠条"：旁白保留在原位，每段工具调用收成自己的一行摘要（如"读取 3 · 编辑 1"），最终答案固定为三段——总起一句、带数字的事实、一句说明"还有什么没做完"。长任务不再合并成一条摘要条（合并会把中途的发现一起藏掉，用户只能看到开头和结尾）。改动见 `MessageFlowRenderer.vue`：完成态旁白常驻、去掉长任务合并、折叠行复用 P1-02 阶段词表。（e7be5f9）
- **回复结构写进系统提示。** 开场旁白说明要做什么、为什么、失败怎么办；工具批次之间只讲"发现了什么 + 接下来做什么"，禁止复述工具卡里已有的命令与输出；最终答案按三段式输出。这条**取代了 2026-10-21 的"执行后不要回顾"**——那条措辞过强，直接把中段旁白也禁掉了，过程区因此一片沉默。（25b7dd7）
- **助手可以为大项目提出持续目标。** 新工具 `propose_goal`（按需加载，常驻工具仍为 12 条）：只在"跨多轮的明确大项目 + 用户说清了做成什么样 + 本会话还没有目标"三条同时成立时提出；提出来的是**暂停态**目标，带「AI 提议」徽标，只有用户点「开始推进」才执行，助手不得自行启动。日常任务、头脑风暴、单纯提问一律不提议，每会话最多一次。数据库增加 `source('user'|'ai')` 列并带老库迁移。（2c3172d）
- **`/goal` 命令与未登录提示。** `/` 命令菜单新增 `/goal`（仅在目标功能可用时出现，避免承诺一个界面上不存在的控件），选中后打开输入框上方的目标编辑框。目标功能改为默认开启（`VITE_GOALS=0` 可关闭）。未登录点发送不再把请求发出去等 401：发送前直接弹「需要登录 / 去登录」，对话中途会话过期也走同一提示，并在跳转前先刷新账号状态——否则路由守卫会把"仍显示已登录"的人从登录页弹回聊天页。（0d0e26c）
- **写入被读回核实的目标可以继续推进。** 原来任何非只读工具调用都会让目标停在第一轮（写一个文件就结束，等于没有长任务）。现在 `file_write` / `multi_edit` 之后，若同一轮内读回了同一路径（resolve 归一化比对）并被引为证据，就允许继续；网络、终端、设备控制等无法在轮内自证的操作仍然一轮即停，未经读回的写入也停。目标栏文案同步改为"写入后读回核实"。（25b7dd7）

### 修复

- **技能列表不再丢条目。** 已安装技能索引超出长度预算时会整条丢弃（列表看起来"少了几个技能"，且没有任何提示）；现在按预算内保留一句话摘要，超出部分明确告知"另有 N 个，可用 skill_list 查看"。重名技能现在会打开其中一个（按启用状态与使用频次取一条），而不是点了没反应。（6ac0988）

### 工程

- 新增测试：`propose-goal.test.ts`（4 条）、`slash-commands.test.ts`（2 条）、`chat-auth.test.ts`（2 条）、`MessageFlowRenderer.test.ts` 补 2 条结构断言、`goal-turn-continuation.test.ts`（9 条）。服务端 146 文件 1396 项通过，客户端 75 文件 773 项通过，`tsc` / `vue-tsc` 0 错，`validate:tools` 契约 4 项全绿。

### 已知限制

- 回复结构模板与目标提议只有单元测试覆盖，本版是它们**第一次跑真实模型**：如果小任务也冒出目标卡，或回复没按三段式输出，属于需要下一版修的问题。
- 目标执行仍需登录账号：未登录可以创建或收到目标，但「开始推进」会返回 401 并提示登录。
- 未签名构建：macOS 首次启动右键打开，Windows 弹一次 SmartScreen。

---

## v1.3.7 (2026-11-24) — 不再被随机踢下线

### 修复

- **刷新令牌撞车不再导致退出登录。** 账号服务判定"这个刷新令牌已被使用"时（两个进程同时刷新的常见结果），客户端原来把它当成"用户已登出"，删除本地登录文件并对所有请求返回 401——表现是"明明登录了，点什么都没反应"，只能重新登录。现在识别这一种拒绝，保留登录态，返回"暂时无法确认"而不是"未登录"。真正被吊销的令牌仍会报告无效，但不再擅自删除本地文件——退出登录应该是你主动做的事。
- **写文件改为全有或全无。** 原来是先截断再写新内容，中途崩溃会留下半截文件且原内容已丢。现在写入临时文件、刷盘、再原子替换，读到的要么是旧版本要么是新版本。写入失败时原文件完好，也不留临时文件。
- **明确要求用技能时，现在真的会打开技能。** 索引只列名字和一句话描述，中文请求"用 brainstorming 技能帮我理清需求"会直接反问用户，三次尝试都没查过技能。现在有硬规则：你点名技能时，先找工具、查准确名字、读取技能说明再动手。已用真实模型验证。
- 目标栏输出在运行结束后不再重复显示两遍
- 前端计划状态与服务端对齐：中断时不再把所有步骤标为完成
- 日期解析拒绝不可能存在的日期（2月30日、13月），不再被静默顺延
- 切换账号后目标执行会重建执行器，不会沿用上一个账号

### 说明

**持续目标仍处于关闭状态**（`VITE_GOALS` 未设置）。目标栏代码已就绪并通过测试，但执行链路还没有在打包版里用真实模型跑完整的多轮验证。等验证完成再放开，不作为默认。

**已知未修**：进程在写入过程中被强杀时，这次写入仍会丢失（旧内容保留，新内容不会落地）。要恢复半途的编辑需要日志机制，不在本次改动范围内。

---

## v1.3.6 (2026-11-24) — 安全加固与持续目标

### 安全

- **诊断包不再包含日志正文与自由文本设置。** 原来会导出最近日志最多 12 万字符、
  全部设置键值以及本机数据目录。诊断包会被贴进 issue 和聊天窗口，而日志里可能有
  对话内容、路径和错误信息中的凭据片段——脱敏 API key 并不能解决这些。现在只导出
  配置状态、表计数和日志元数据。
- **上传的 HTML/SVG 不再作为同源可执行内容返回。** 预览接口原来按扩展名设置
  Content-Type 并 inline 返回，一个带脚本的 `.svg` 会在应用源上执行。现在只有
  图片/PDF/文本等被动格式内联，其余一律下载，并带 `nosniff` 与沙箱 CSP。

### 修复

- **回滚不再覆盖任务结束后你自己的修改。** 回滚前比对当前文件与快照，不一致则跳过并逐文件报告；变成符号链接的路径也跳过。
- **AI 浏览器不再挡住点击。** 它是盖在页面之上的原生视图，会吃掉落点在其矩形内的指针事件，导致点设置没有反应。现在面板收起时、以及点击送达应用之前都会主动隐藏。
- **AI 浏览器不再盖住更新日志。**
- **搜索结果按日期排序。** 原来的比较器只判断"有没有日期"，同一组内的顺序完全没动。
- **带时间过滤的搜索不再返回空。** 搜索引擎返回的是本地化日期格式，解析失败后被当成超期全部丢弃。现在无法判定日期的结果会保留并排在最后。
- **计划不再因为"跑完了"就把所有步骤标为完成。** 中断时会显示全部完成。
- **工具返回 `failed` 不再被渲染成成功。**
- **会话只有服务端确认存在才显示。** 创建失败时不再留下一个服务端没有的本地会话；响应丢失后重试会复用同一 ID。
- **上传与 OCR 结果回到发起它的会话**；消息保存失败时草稿不再被清空。
- **附件超限有明确提示**（单文件 20MB / 单次 5 个），中英文都有。
- **DNS 挂起不再卡住网页抓取**；响应长度上限 10 万字符。

### 持续目标

会话现在可以持有一个长期目标，含目标描述、验收条件、累计运行时间和状态，显示在输入框上方的目标栏。

目标默认暂停，不会自动恢复执行：中断后恢复前会询问你是否已检查过进度，因为重跑副作用未知的工具正是重复操作的来源。暂停先进入"正在暂停"，只有当前运行确认停止后才显示"已暂停"。

**尚未用真实多轮任务做端到端验证**——执行链路已接通并有测试覆盖，但没在打包版里用真实模型跑过。

---

## v1.3.5 (2026-11-23) — 网页抓取与回答保存的稳定性

### 修复

**抓取**
- **gzip 响应体被当文本解码**：NetEase 等站点返回 `Content-Encoding: gzip` 但头声明 `text/html`，正文被逐字节当 utf-8 读，实测 17,395 个替换字符。现在按 `Content-Encoding` 先解压（gzip/deflate/br），压缩体与解压后均限 5MB。
- **样式表模板被当正文提取**：百度把样式表放在隐藏 `<textarea>` 里且非法嵌套（外层 textarea 装转义 CSS，内含一个字面 `<textarea>` 标签），`htmlparser2` 对一次 open emit 了两次 close，深度计数提前归零，1,813 段 CSS 规则成为页面正文，把真实内容挤到 `maxLength` 之外。修法是把 `textarea` 整体加入忽略集合——**实测栈式计数重写无效**，故保持简单计数并注明。
- **握手阶段被断开**：传输层未协商 ALPN，本网络下百度连续三次 `socket hang up`；显式指定 `http/1.1` 后三次均 200。最初误判为 `lookup` 回调问题，经对照实验排除。
- **GBK 页面乱码**：三级识别（BOM / 响应头 / `<meta charset>`），失败回退 utf-8。
- **元数据窗口过窄**：读取服务返回的 `Markdown Content:` 实测在第 9 行，原 12 行窗口余量仅 3 行；扩到 128 行 + 32KB 上限。
- **HTML 提取**：剔除 script/style，保留段落分隔，解码实体；纯文本不再被当 HTML 删除尖括号。

**安全**
- **SSRF**：逐跳校验重定向，解析结果逐条检查（任一私有即拒），连接钉死到已校验地址。fake-IP（`198.18.0.0/15`，Clash 类代理返回）不直接放行，改用 1.1.1.1/8.8.8.8 独立解析后走同一套校验。
- **preview 路径**：解析真实路径，拒绝越出工作区或指向 `.env`/`.key`/`.db` 的链接（含 HTTP 处理函数内部）。
- **开发免登录**：改用 socket 真实地址 + Koa IP 双重判定，伪造 `Host` 不再够用（修正了 11-21 引入的缺陷）。
- **账号密钥**：缺失或损坏时不再生成替换 key，避免毁掉已有加密会话的恢复线索；写入改为原子操作。

**对话**
- `done` 事件不再等同任务成功（`finished === false` 不播成功提示、不发队列）。
- 长回答收尾时按消息 ID 保存，不会覆盖下一条；已删除消息不会被旧保存请求写回；删除与保存共用同一会话队列。
- 流式中途出错时保留打字机缓冲中已收到的内容；收到「正在重试」不再提前关闭流；提示在回答结束后清除。
- `keyCode 229` 视为输入法组合中，避免选词回车误发送。
- 停止落在正确的会话；请求失败时提示后台任务可能仍在执行。
- 草稿与待发队列按会话隔离。

**渲染**
- 来源链接不再从流式正文消失；普通 XML 不再被误判为 SVG 图表；代码块与图片内的 URL 不再列为来源；「来源」改名「相关链接」。
- 多模型对比结果不再重复显示原始 JSON；产物组恢复父组件样式；快速切换会话不再被旧请求覆盖。

### 新功能

- **逐文件 diff + 单文件回滚**：`file_write` 上报改前/改后内容，按检查点存快照；新增 `GET /api/checkpoints/:id/diff` 与 `POST /api/checkpoints/:id/restore`（指定 paths 或 all），按文件返回结果，部分成功也能如实报告。短任务此前只留快照没有检查点可挂，现在收尾时补存。
- **人格文件层**：`~/.supercrzy/{SOUL,USER,IDENTITY}.md` 注入提示词，首次启动生成模板且永不覆盖用户编辑；每份限 2k 字符，超长从中间裁剪并标注。
- **诊断包导出**：`GET /api/diagnose/bundle` 返回版本/环境/能力计数/设置快照（密钥仅报有无）/日志尾部，日志页可下载。
- **制品中心**：`/api/artifacts` 跨会话聚合（带会话标题），新增独立视图。
- **后台任务接入 L3 沙箱**：此前 `sandboxify` 只包前台执行，同一条命令前台隔离、后台不隔离；现统一，探测不可用时降级而非失败。

### 工程

- 新增 `check-artifact-reporting` 门禁：碰文件系统的工具必须走统一 writer。
- `ChatView` 与 `DetailPanel` 两次拆分以通过体量门禁。
- 新增真实网络回归脚本 `verify-public-web-fetch.mts`（依赖外部网络，不进 CI）。

## v1.3.4 (2026-11-20) — 横栏降到 36px，左侧成为菜单栏

### 新功能

- **顶部菜单栏（文件 / 视图 / 帮助）**：横栏从 56px 降到 36px，LOGO 归位到侧边栏顶部，左侧空间变成菜单。文件 = 新建对话 / 新建协作空间 / 设置 / 退出；视图 = 侧边栏、右栏、放大缩小重置、深色模式、全屏；帮助 = 检查更新 / 关于 / 日志目录 / 数据目录（37084ca）
  - 菜单严格限制在侧边栏宽度内（实测 Windows 40–140px、macOS 115–215px，均在 220px 列内），标题始终对齐工作区左缘
  - 收起侧边栏时菜单**全部隐藏**（实测 0 项），48px 里放不下会把标题挤掉
  - 新增 5 个 IPC：`app:quit`、`app:zoom`、`app:fullscreen`、`shell:open-dir`

### 修复

- **Windows 上会话标题压在 LOGO 上**：早先"标题最左"方案遗留的 `margin-left: 12px` 覆盖，把标题拉到 LOGO 所在的 x=12px。已删除（e2faaf4）
- **Windows 深色模式下窗口按钮消失**：`titleBarOverlay.symbolColor` 在创建时固定为深灰 `#1f2328`，切深色后不可见。`theme:set` 现在每次都重新应用（深色 `#e5e7eb` / 浅色 `#1f2328`），高度同步 36px（37084ca）
- **搜索为挂掉的实例空等**：实例失败或超时后 60 秒内跳过（`DEAD_INSTANCES`），连续查询实测 6.2s → 0.95s（5584879）
- **macOS 构建被华为镜像 429 卡住**：`ELECTRON_MIRROR` 的覆盖逻辑原本只在 `PACK_TARGET` 分支内，CI 走 `pnpm dist` 时被忽略。已提到分支外（a26618f）
- **发版验证误报 404**：`release-publish.sh` 有 5 处硬编码 `SUPERCRZY BOT-$VER`，但品牌统一后产物叫 `SUPERCRZY-$VER`，真实文件 200 却报失败。改为动态探测 + 从 `latest-mac.yml` 读名（e4ee31a）

### 新功能

- **逐文件 diff + 单文件回滚**：`file_write` 上报改前/改后内容，按检查点存快照；新增 `GET /api/checkpoints/:id/diff` 与 `POST /api/checkpoints/:id/restore`（指定 paths 或 all），按文件返回结果，部分成功也能如实报告。短任务此前只留快照没有检查点可挂，现在收尾时补存。
- **人格文件层**：`~/.supercrzy/{SOUL,USER,IDENTITY}.md` 注入提示词，首次启动生成模板且永不覆盖用户编辑；每份限 2k 字符，超长从中间裁剪并标注。
- **诊断包导出**：`GET /api/diagnose/bundle` 返回版本/环境/能力计数/设置快照（密钥仅报有无）/日志尾部，日志页可下载。
- **制品中心**：`/api/artifacts` 跨会话聚合（带会话标题），新增独立视图。
- **后台任务接入 L3 沙箱**：此前 `sandboxify` 只包前台执行，同一条命令前台隔离、后台不隔离；现统一，探测不可用时降级而非失败。

### 工程

- 本轮新增注释统一英文（95083cb）
- 修复过程中一并处理：i18n key 路径错误（`menu.*` → `nav.menu.*`）、菜单溢出侧边栏（323px vs 220px）、macOS 收起态 `calc(48-87)` 为负导致 toggle 只剩 2px

## v1.3.3 (2026-11-19) — 搜索恢复可用，Windows 白屏根治

### 新功能

- **双自建搜索后端**：中文查询走中国大陆实例（快、中文源），英文与技术类查询走海外实例（Google/Brave、官方文档），任一实例故障自动切换。**不产生任何按次搜索费用**（64c8a78）

### 修复

- **搜索几乎每次都没有结果**：`readSetting` 的 `require('./database')` 在 ESM 下抛 `ERR_UNSUPPORTED_DIR_IMPORT`，被 catch 吞成空串，导致五个引擎里的四个（deepseek/searxng/tavily/serper）恒判「未配置」，只剩会陷入重定向循环的 bing。改为静态 import + 异常打日志（cb3fbee）
- **Windows 安装后白屏**：后端等待改为实际监听地址、数据迁移失败不再崩溃、启动失败显示真实原因而非白屏（d404c77）
- **桌面端后端启动即崩溃**：构建剪掉的 342MB `openclaw` peer 依赖仍被静态引用，后端在监听端口前退出。两个 helper 已 vendored 到本地，依赖彻底移除（e78e331、251cb87）
- **AI 浏览器被误判为死循环**：`snapshot`/截图重复调用是浏览器的正常工作方式，浏览器工具已豁免，通用阈值 4→6（b238630）
- **发消息时两段朗读重叠**：`handleSend` 现在先停掉上一段朗读（9d2a3eb）
- **上下文用量弹窗被裁掉**：`.traffic-spacer` 的 `overflow:hidden` 裁掉了 absolute 弹层，改为 `position:fixed` + 按圆环坐标定位（bade658）
- **Windows 顶部横栏布局**：标题压在侧边栏上、LOGO 上方留空。Windows 现将 LOGO 移入该栏（macOS 不动），侧边栏顶部 LOGO 在 Windows 隐藏（938d4c4、6ba19ae、c13a2aa、92d1014）
- **产品名统一为 SUPERCRZY**：此前在「Super Crazy」「SUPERCRZY BOT」之间漂移（337c5d3）

### 新功能

- **逐文件 diff + 单文件回滚**：`file_write` 上报改前/改后内容，按检查点存快照；新增 `GET /api/checkpoints/:id/diff` 与 `POST /api/checkpoints/:id/restore`（指定 paths 或 all），按文件返回结果，部分成功也能如实报告。短任务此前只留快照没有检查点可挂，现在收尾时补存。
- **人格文件层**：`~/.supercrzy/{SOUL,USER,IDENTITY}.md` 注入提示词，首次启动生成模板且永不覆盖用户编辑；每份限 2k 字符，超长从中间裁剪并标注。
- **诊断包导出**：`GET /api/diagnose/bundle` 返回版本/环境/能力计数/设置快照（密钥仅报有无）/日志尾部，日志页可下载。
- **制品中心**：`/api/artifacts` 跨会话聚合（带会话标题），新增独立视图。
- **后台任务接入 L3 沙箱**：此前 `sandboxify` 只包前台执行，同一条命令前台隔离、后台不隔离；现统一，探测不可用时降级而非失败。

### 工程

- 从微信 SDK vendored 两个 helper（MIT，保留 Tencent 版权，逻辑逐字节一致），移除 342MB 依赖树，根除「剪掉了但仍在 import」这一类启动崩溃（251cb87）
- CI：macOS runner 换成 macos-15（macos-14-arm64 被 GitHub 下线）、Docker 镜像 429 绕过 + 退避重试、Windows 打包门禁恢复到正确工作目录（190b76b、3ed1e79、4f18588、9cfb308、f18236f）
- 打包 productName 临时锁定旧值，保证已装用户能继续自动更新（a63654b）

## v1.3.2 (2026-11-18) — 账号体系与多设备远程任务；Android 应用与移动端界面

本次是本项目单版改动最大的一次：账号与加密同步、远程任务链路、一轮系统性安全加固，
以及 Android 应用（内置运行时/AI 浏览器）与移动端界面的整体落地。自动化测试 1826 项全绿。

### 新功能

- **账号体系与端到端加密同步（459ead6）**
  - 邮箱验证码登录；设备管理（查看/撤销即时生效）；登录设备级令牌绑定。
  - 会话/消息/执行过程/交付摘要以 E2E 加密备份上传：口令不出设备，服务器只存密文。
  - 版本核对（CAS）+ 整批回滚 + 持久版本序列 + 墓碑语义，旧设备上传不会覆盖新数据。
  - 分页游标、单页 4MB 字节预算、UTF-8 字节配额、单会话失败不中断整批。
- **多设备远程任务（459ead6、47d599b）**
  - 设备注册（账号绑定凭据）+ 实时在线状态 + 选设备发任务。
  - 桌面任务桥：原子记录、幂等去重、并发拒绝、状态四态、取消穿透到运行中的任务。
  - 投递语义如实：`delivered/queued:false/executionConfirmed:false` —— 写入连接不等于已执行。
  - relay 清理无响应连接、WS 载荷上限 256KB、方法白名单。
- **移动端界面改版（7735af5）**：空间停靠栏、内嵌站点页、沉浸式设置、关于页。
- **Android 应用（7f851b2、6a70e7e、24fc05d、6c641bb、3da00c0）**
  - 内置运行时（proot 启动，载荷 258MB 精简至 50MB）；WebView 壳；手机控制（P3）与 AI 浏览器；应用内自更新；崩溃记录与前台服务加固。
- **AI 浏览器改进（daac898、664a706）**：手机侧栏不再截屏 Chrome 做镜像；浏览器不可用时给出明确错误而非 500。

### 修复

- **TTS 中国大陆 IPv4 直连（130964a）**：IPv6 路径被重置，直连固定走 IPv4。
- **安全加固（c4184f1、459ead6）**
  - 服务默认绑定回环；无令牌远程请求拒绝（Origin 精确白名单，非子串匹配）。
  - 终端 WS 30 秒单次票据（绑定账号、登出即断）。
  - 文件路径解析真实符号链接（路由层 + 通用校验器）；服务器日志不再写请求体；密钥/令牌只返回掩码。
  - 工具确认归属改为服务端反查（伪造请求体无效）；web-fetch 协议/私网/元数据 IP 拦截。
- **登录容错（d5fff4e、47d599b）**：账号服务不可达不再等同于登出；登出过程不会被旧轮询拉回登录态。
- **布局修复（3eb994e、310c35f）**：最大化面板从侧边栏边缘起算并在切换会话时恢复宽度；下拉菜单任意选项后关闭。
- **Android 稳定性（3da6a6e、e23abdf、f744c38、f4f9654）**：端上崩溃记录、设备桥与 tar 读取的 Kotlin 修复。
- **CI 修复（b2aab51、f77a5bb、f2e2169、c4184f1）**：单测门禁恢复绿灯（慢 runner 的超时与时序假设）、Android 工作流锁定 JDK 17。

### 新功能

- **逐文件 diff + 单文件回滚**：`file_write` 上报改前/改后内容，按检查点存快照；新增 `GET /api/checkpoints/:id/diff` 与 `POST /api/checkpoints/:id/restore`（指定 paths 或 all），按文件返回结果，部分成功也能如实报告。短任务此前只留快照没有检查点可挂，现在收尾时补存。
- **人格文件层**：`~/.supercrzy/{SOUL,USER,IDENTITY}.md` 注入提示词，首次启动生成模板且永不覆盖用户编辑；每份限 2k 字符，超长从中间裁剪并标注。
- **诊断包导出**：`GET /api/diagnose/bundle` 返回版本/环境/能力计数/设置快照（密钥仅报有无）/日志尾部，日志页可下载。
- **制品中心**：`/api/artifacts` 跨会话聚合（带会话标题），新增独立视图。
- **后台任务接入 L3 沙箱**：此前 `sandboxify` 只包前台执行，同一条命令前台隔离、后台不隔离；现统一，探测不可用时降级而非失败。

### 工程

- 测试 1826 项（client 655 / server 1064 / auth 102 / relay 5）。
- 新增备份写入校验、游标校验、迁移 WAL 一致性快照（VACUUM INTO + link 安装）。
- 发布管线（门禁→tag→三构建→发布器）文档化、可复现。

### 已知限制

- **本机会话尚未按账号隔离**：上传包含该设备全部会话，设置页已明示；隔离为下一个大项。
- **手机端任务结果回传未闭环**：桌面执行与状态已就位，但 relay 目前丢弃上行工作区事件，手机消费端未做。
- **同步为手动**（上传/下载），非自动双向；冲突合并无 UI。
- **真实微信/QQ 通道未联调**：安全路径假设官方文档的 CDN 行为。
- **Windows 构建通过但未在真机验证。**
- **产物预览为沙箱渲染**：外部脚本/图片/样式受限（设计取舍），依赖第三方资源的页面可能显示不完整。

## v1.3.1 (2026-10-29) — Windows 登录修复 + 窗口细节三处

### 新功能

_本次无新功能。_

### 修复

- **Windows 端登录失败已修（4736f40）**
  - 根因：`cmd /c start` 把登录 URL 在第一个 `&` 处当命令分隔符切开，浏览器只收到
    `?returnPath=...`，`code_challenge`/`state` 丢失，登录页报「回环重定向必须发送PKCE挑战」。
  - VPS nginx 日志实锤：Windows 尝试的 referer 只有 returnPath（400），mac 尝试带完整 query（200）。
  - 改用 `rundll32 url.dll,FileProtocolHandler` 直启（不经 cmd 解析），URL 单参数完整；
    `browserOpenCommand` 抽成纯函数并加 3 个单测锁死。
- **放大右侧面板不再吃掉标题栏（64ab474）**
  - 根因：放大态 `position:absolute` 缺 positioned 祖先，`top:0` 相对视口 ⇒ 盖掉 56px 顶栏，
    Windows 上面板关闭键叠进系统按钮区 ⇒ 点不到。
  - `.app-body` 补定位基准；`min-width` 夹进容器宽；退出路径 ×4：tab 行还原按钮 / Esc / 切 tab / 关面板。
- **Windows 登录页中文/English 切换让开系统按钮区（3fd6636）**：win 右缘让位 160px，mac 维持 22px 原样。
- **更新源发布改用固定路径（1685097）**：发版脚本不再把含换行的路径写进更新源，应用内检查更新解析更稳。

### 新功能

- **逐文件 diff + 单文件回滚**：`file_write` 上报改前/改后内容，按检查点存快照；新增 `GET /api/checkpoints/:id/diff` 与 `POST /api/checkpoints/:id/restore`（指定 paths 或 all），按文件返回结果，部分成功也能如实报告。短任务此前只留快照没有检查点可挂，现在收尾时补存。
- **人格文件层**：`~/.supercrzy/{SOUL,USER,IDENTITY}.md` 注入提示词，首次启动生成模板且永不覆盖用户编辑；每份限 2k 字符，超长从中间裁剪并标注。
- **诊断包导出**：`GET /api/diagnose/bundle` 返回版本/环境/能力计数/设置快照（密钥仅报有无）/日志尾部，日志页可下载。
- **制品中心**：`/api/artifacts` 跨会话聚合（带会话标题），新增独立视图。
- **后台任务接入 L3 沙箱**：此前 `sandboxify` 只包前台执行，同一条命令前台隔离、后台不隔离；现统一，探测不可用时降级而非失败。

### 工程

- 新增 `scripts/diag/check-panel-maximize.mjs`、`scripts/diag/check-login-lang.mjs`：
  真实浏览器里量几何断言，均带 `--control` 对照跑法（关掉修复 ⇒ 复现 bug），防"恒真断言"。

### 已知限制

- 两处 Windows 修复（登录、语言切换）依据服务端日志与浏览器实测几何验证，
  **尚未在真实 Windows 机器上回归**；面板放大修复未在打包后的 Electron 壳里复测。

---

## v1.3.0 (2026-10-28) — 先登录才能用

### 新功能

- **必须先登录，登录在浏览器里完成（0999348）**
  - 首次打开会停在登录页，一个按钮拉起默认浏览器 → 邮箱收六位验证码 → 授权后自动回到应用。
  - 凭据不进应用：浏览器向 `auth.supercrzy.com` 证明身份，一次性码（60 秒、单次）交回本机回环端口，
    且与发起登录的进程绑定（PKCE S256），本机其它程序截到码也换不出 token。
  - 会话以 AES-256-GCM 加密落在 `~/.supercrzy/data/auth.json`，密钥独立文件（0600）；
    "已登录"的判定是 refresh 落在 30 天离线窗口内，而不是 access 未过期——否则每 15 分钟误判掉线。
  - 服务端 `requireAccount` gate；健康检查、账号状态、登录/登出、一次性 TTS 流豁免。
  - 静默续期用共享 promise 串行化：并发多个 401 只能触发一次 refresh，否则 auth 服务会判定
    token 重用并吊销整个 family（表现为"一直退不出去也进不来"）。
  - 前端 401 拦截器先重新读状态再跳转；直接假定掉线会和路由守卫互斥（守卫会把已登录用户从 /login 弹回）。
  - 登录页：图案 + 文字 lockup、中英切换、明确写"没有账号也能直接登录，首次自动创建"、浏览器被拦时的手动链接。

- **本地 OCR，带视觉模型兜底（87eaf7d）**
  - 原来取字依赖机器上装没装 Python RapidOCR；没装或坏掉时，结果是"截了图没有文字、也没有报错"。
  - macOS：`scripts/vision_ocr.swift` → `build:ocr` 编译出 `scripts/bin/vision_ocr`（Vision 框架，约 88KB，无运行时依赖）。
  - Windows：`scripts/win_ocr.ps1` 走 `Windows.Media.Ocr`，零依赖。
  - 兜底：本地引擎无结果时由 `services/model-vision.ts` 交给视觉模型，降级而不是静默失败。
  - 打包链路同步更新：`sync-backend.mjs` 会把 `ocr_service.py`、`win_ocr.ps1`、`bin/` 一并带进 App。
  - 编译产物不进仓库（已 gitignore），由 `pnpm build` 重新生成。

- **一条命令完成发版（32c1c89）**
  - `pnpm release prepare <ver>`：从提交日志起草发布说明、CHANGELOG、应用内更新面板。
  - `pnpm release ship <ver>`：门禁 → 提交 → 打标签 → 等 CI → 发布更新源与下载页。
  - 目的是消掉手工步骤：更新源版本号与下载页不一致，历史上发生过。

### 修复

_本次无修复。_

### 新功能

- **逐文件 diff + 单文件回滚**：`file_write` 上报改前/改后内容，按检查点存快照；新增 `GET /api/checkpoints/:id/diff` 与 `POST /api/checkpoints/:id/restore`（指定 paths 或 all），按文件返回结果，部分成功也能如实报告。短任务此前只留快照没有检查点可挂，现在收尾时补存。
- **人格文件层**：`~/.supercrzy/{SOUL,USER,IDENTITY}.md` 注入提示词，首次启动生成模板且永不覆盖用户编辑；每份限 2k 字符，超长从中间裁剪并标注。
- **诊断包导出**：`GET /api/diagnose/bundle` 返回版本/环境/能力计数/设置快照（密钥仅报有无）/日志尾部，日志页可下载。
- **制品中心**：`/api/artifacts` 跨会话聚合（带会话标题），新增独立视图。
- **后台任务接入 L3 沙箱**：此前 `sandboxify` 只包前台执行，同一条命令前台隔离、后台不隔离；现统一，探测不可用时降级而非失败。

### 工程

- 三个新文件注释改为英文，符合 English-first 约定；`language-baseline.json` 继续缩短（7538af7）。
- 更新面板去掉提交哈希行：它每次提交都变，给不出可执行结论；面板现在始终显示应用版本，
  没有 git 工作树时隐藏源码区块（e4bab57）。
- 忽略临时产出物（`/output/`）与编译出的 OCR helper（`packages/server/scripts/bin/`）（2b3caf0）。

### 已知限制

- **登录链路尚未由真人在打包版上走完一次。** 生产 auth 服务已按协议层验证：JWKS 200、portal 含
  `code_challenge` 透传与 loopback 回跳分支、DB `user_version=6`、临时库实测
  `pkce_required` / `pkce_mismatch` / 重放 `used` / 浏览器流仍可无 verifier 兑换；打包版已验证
  生成的登录 URL 指向生产 auth 且带 S256 挑战，界面停在登录页。"真人输码登录"留给本版验收。
- 从应用内首次注册的账号**没有端到端加密信封**：信封在首次登录 `supercrzy.com/account` 时创建。
  跨设备同步需要它，使用应用不需要。
- GitHub / Google 登录未实现，当前只有邮箱验证码。
- 构建未签名：macOS 首次右键 → 打开，Windows 一次 SmartScreen 提示。
- Windows 版由 CI 产出，本轮未真机验证；只安装并验证了 macOS arm64。

---

## v1.2.4 (2026-10-26) — Windows 全平台修复

### 修复

- **Windows：8 个工具一次性恢复可用。** 根因只有 3 个：
  ① `spawn('npx.cmd')` 返回 EINVAL —— Node 自 CVE-2024-27980 修复起拒绝在不带 shell 的情况下启动
  `.cmd`，`computer_use` 与**所有** MCP stdio 服务器都在启动阶段就死；
  ② 沙箱用 `startsWith(a + '/')` 比路径，在 Windows 上拼出 `C:\...\Documents/`（反斜杠 + 正斜杠），
  **每一个路径都判越权**，与权限档位无关 —— 这就是"PowerShell 能写、file_write 报越权"的真因；
  ③ 终端默认 shell 写死 `/bin/bash` + 硬编码 `-i`，Windows 上两样都不存在。
- **完全访问在 Windows 上确实生效了**：`HOME` 取自 `process.env.HOME`（Windows 通常为空）⇒ full 档
  放行代码整段被跳过；放行列表也没有 `%TEMP%` 和 `~/.supercrzy`（读不回自己刚写的报告）。
- **安全缺口（Windows）**：`SENSITIVE_DIR` 与 `CREDENTIAL_FILE` 只认 `/`，`C:\...\.ssh`、`.env`
  在 Windows 上**从来没被拦过**。现同时认 `\` 并按平台大小写不敏感。
- **MCP 服务器在 Windows 上能起**：`mcp-manager` 与 `computer_use` 有同样的两个缺陷，且各自独立实现；
  平台规则收敛到一处，顺带删掉那个只收 stderr、退出时还会清空正常连接的孤儿进程。
- **记忆去重改在写入侧**：`upsertMemory` 原本只做精确 key 匹配，同一件事换个说法就是两条。
  试过降合并阈值，但实测"真正改写"与"同前缀不同产物"都落在 0.5000，阈值分不开 ⇒ 改为写入时拦截：
  同分类、阈值 0.75、内容追加而非覆盖。`任务反思:A/B/C` 曾被误合成一条，故词元少于 4 个不判定。
- **`create_plan` 现在返回 id**：此前建了行、生成了 id 却只返回标题，`task_update` 永远拿不到合法 id，
  计划卡片卡在第一步。
- **`memory_store` 不再把"已合并"报成"未存储"**：`merged` 曾落进 default 分支返回「⛔ 记忆未存储」，
  模型会因此重存一遍，等于去重白做。

### 界面

- **Windows 沉浸式标题栏**：原生标题栏此前只在 macOS 隐藏，而 56px 横栏在 Electron 里一律渲染、
  左侧固定留 87px 给 macOS 红绿灯 ⇒ Windows 上那条横栏是空的，还把侧边栏下推一个标题栏高度
  （即"LOGO 上方空一档"）。现在窗口控制按钮画进同一条横栏右端。
- **「关于」只显示一个版本**：此前并列「应用 v1.2.3 / 引擎 v0.4.0」，后者是无人校验的常量。

### 已知限制

- Windows 的几何布局与进程启动只做了代码路径断言，**未在 Windows 实机测量**。
- `terminal_signal` 的 SIGINT 在 Windows 上会**关闭整个会话**（pipe 而非 pty，Ctrl-C 无法传递）。
- 完全访问仍不含系统目录（`C:\Windows`、`/etc`）。

---

## v1.2.3 (2026-10-26) — 手机端终于能收到回复

### 修复

**所有 IM 渠道都收不到回复（本次重点）**
- 六个渠道（Telegram / Discord / Slack / 钉钉 / 飞书 / 企业微信）全部返回 "No response"，
  而 Agent 实际上已经跑完并产出了内容。根因两处：
  ① **事件名完全对不上** —— 六个 `*-bot.ts` 各抄了一份 `callAgent()`，都在找
  `d.type === 'block'`，而 `/api/chat/agent` 发的是**命名 SSE 事件**（`event: content_chunk`，
  且带 `id:` 行）⇒ 匹配恒为假，永远取不到正文；
  ② **半行被解析又被丢弃** —— `for (const line of buf.split('\n'))` 先遍历整个缓冲区（含最后一段
  不完整的行），然后才 `buf = ...pop()` 把尾巴丢掉 ⇒ 任何跨 TCP 分片的 JSON 都会被截断或丢失。
- 收敛为一份共享实现 `gateway/agent-bridge.ts`：真正的增量 SSE 帧解析器（按空行切帧、缓冲未完成
  的尾巴、支持 LF/CRLF）、只累加 `content_chunk`（思考旁白不进答案）、`stopped`/`paused` 不算错误、
  真失败上报而非吞掉、带超时。六个渠道改为调用它，**净删 168 行重复代码**。
- 14 个测试钉住这些不变量：7 字节切块强制帧边界落在 JSON 中间、CRLF、截断 JSON、HTTP 500、连接被拒。

**朗读音色与语种不匹配**
- 三个问题叠加：① 前端 `stores/app.ts` 把 `ttsVoice` 默认写死成**英文音色**并每次请求都发出去
  ⇒ 服务端"未指定就按语言选"的规则**永远走不到**；② 即使走到，`cjkRatio` 把日文汉字算进中文占比
  （日文正文汉字可达 45%）⇒ 日文被当成中文、用中文音色读假名；③ 上游 12 天内两次改握手协议，
  第二次是"软失败"（HTTP 200 但不升级成 ws）。
- 实测（同句中文）：英文音色 **9.77s / 过零率 0.189**，中文音色 **8.66s / 0.136**，而两者
  **RMS 几乎相同（2694 vs 2706）** —— 不是声音小，是**发音不准**。
- 现在按语种选音色，判定顺序 **假名 → 谚文 → 汉字 → 西里尔 → 拉丁**（与前端 `detectSpeechLang` 一致）。
  端到端实测：中文→晓晓 45,216 B / 英文→Emma 40,032 B / 日文→**Nanami 64,512 B**（修复前是中文音色
  44,352 B）/ 韩文→**SunHi 34,848 B**。前端默认值改为空 = 自动。

**中国用户的中继形同虚设**
- 加速握手的中继一直健康（实测 0.875s，直连要 1.5~30s），但**告诉客户端"中继在哪"的清单，
  就放在中继要转发到的那台境外机器上** —— 那次查询走的正是让它慢的那条跨境链路。3 秒超时后
  中继列表为空，中继连被探测的机会都没有。
- 清单（259 B）改为**随包分发**，拉取失败/非 200/返回空数组三种情况都回落到包内那份；
  拉取成功仍以线上为准（换中继不必重新发版）。`copy-assets.mjs` 补上 tsc 不复制 JSON 的缺口，
  否则自建版会静默丢清单。

**兜底朗读"听不清在读什么"**
- 合成失败时回落系统 TTS。macOS 暴露的八个"新代 Siri 音色"在未下载语音包时**只输出 1.756 秒、
  有声占比 41%**（时长完全一致）—— 根本没读这句话。而优选表把它们排在最前 ⇒ 每次兜底都只有
  断续几个字。
- 现在把它们降到**最后**，实测能完整朗读的（婷婷 8.76s/85%、美嘉 8.65s/86%）排在前面。
  韩语 Sora 实测 0.35s / RMS=1 / 有声 0%（纯静音）⇒ 保持 Yuna 在前。
- 顺带修掉：`getVoices()` 在 Chromium/Electron 里是**异步填充**的，首次同步调用返回空数组 ⇒
  `pickVoice()` 直接放弃、退到浏览器默认音色。现在模块加载即预热，`voiceschanged` 监听 +
  轮询兜底（Electron 实测不总派发该事件）。
- **Windows 侧补齐**：优选表此前全是 macOS 音色名，Windows 上一个都命中不到 ⇒ 落到列表
  第一个，很可能正是 Windows 7 时代的拼接式"慧慧"。现按系统版本新旧排序：Windows 11 的
  OneCore 神经音色（晓晓/晓伊/云希/云扬）→ Windows 10 的 Tracy / 瑶瑶 → 慧慧 / 康康 放最后。
  ⚠️ Windows 音色名**未实机验证**（手头无 Windows 环境），只钉"优先级方向"。

### 新增

**第二个实例不再崩在端口上**
- 端口被占时原来直接抛 EADDRINUSE 堆栈 + 白窗口。现在自动试 `PORT..PORT+19`，并把**实际绑定的
  端口写回 `process.env.PORT`**（通道桥与桌面壳都从它解析地址，不回写会继续打占用端口）。
  实测：`Port 3000 was busy; bound to 3001 instead.`，3001 健康检查 200。

**更新改为差分**
- electron-builder 写出 `.blockmap` 却不写 `blockMapSize`，electron-updater 因此**从不请求**它
  ⇒ 每次更新都是完整 170 MB。现由 `scripts/inject-blockmap-size.mjs` 补写（幂等、支持 `--check`），
  已接入 mac 打包与 Windows workflow（Windows 不走 build-dmg.sh）。

**发版脚本入库**
- `release-publish.sh`（一条命令走完 preflight → 取 token → 列产物 → VPS 代下 → 备份 yml →
  传 8 文件 → 建 Release）、`vps-fetch.sh`（本地 50 KB/s vs VPS 8.1 MB/s）、
  `check-language.mjs`（English-first 门禁，此前**既没入库也没接线**）、`language-baseline.json`、
  `ops/{health-probe,prune-releases}.sh` —— 这些此前只存在于一台机器上，换机即失。
  语言门禁已接进 `pnpm verify`（实测 251 个存量文件、0 新增违规）。

### 已知限制

- 上游拒绝 48 kHz 输出（`1007 Unsupported Edge output format`），24 kHz 已是顶格。
- 拉丁语系（法/德/西/意/葡）仍走英文多语言音色 —— 仅凭字形无法区分，需要客户端传 locale。
- 兜底音色表仅在 macOS 上验证；Windows / Android 的系统音色池完全不同。

---

## v1.2.2 (2026-10-23) — 朗读不再中途断掉

### 修复

**朗读读到一半停住（本次重点）**
- 根因四处，全部修掉：① 切句正则不认英文句号 —— 真库 2724 字英文语料实测 **65% 的切点落在句子中间**，
  Edge 念到半句被掐；② 客户端 `push`/`end` 都是「发出即忘」，`end` 抢在最后一段之前到达时
  服务端直接丢弃（实测音频只有前半 62784 字节）；③ 服务端重试不判「这一轮是否已经写过音频」，
  断流重发把同一段念两遍（实测 8192 → 16384 字节）；④ 客户端暂停超过 30s 被当成上游断流误杀。
- **攒批控制量从「字数」换成「未播音频秒数」**：旧机制按 40~120 字切，仿真（4 条真实回复 ×
  快/慢生成）显示固定字数在慢速生成下**断粮 46.6 秒**；新机制未播 ≥ 6s 就继续合并、
  < 6s 才把已成句的整串推走 —— 快链路 7 个接缝 / 断粮 0.6s，且切点永远落在句末。
- 首段改为**三级取最早**：第一句完 / 攒满 30 字后的第一个逗号 / 60 字兜底 —— 第一句再长也能尽快出声，
  又不会把首段切碎。
- 断粮救急**不再推碎片**：不足 24 字或没有软停顿就继续攒（推 5 个字换 1 秒音频是净亏，语调还最生硬）。
- 实测口径（`scripts/diag/measure-speech-chunks.mts`）：中英样本 5 段 / 4 段、**句中硬切 0**、
  断粮 0.0s、首段 13 / 52 字。

**朗读中断后无声无息**
- 服务端合成中途失败时会给客户端一个「和正常结束一模一样」的 ended —— 用户只能感觉"读一半停了"。
  现在服务端记 `failed` 并提供 `GET /api/tts/live/status`，客户端据此在朗读条上显示
  **「朗读中断：部分内容没能播出」+「续读」**：从最后一次推送起点之后的第一个句末继续读，
  绝不从词中间开口（宁重复半句，不丢内容）。

**中继地址下发**
- 中继服务一直在 VPS 上运行，但装机 App 的环境变量里从来没下发过地址 —— 等于白建。
  现在服务端启动时从 `updates.supercrzy.com/releases/tts-relays.json` 拉取清单
  （10 分钟缓存、3 秒超时、拉不到非致命），环境变量配置仍然优先；换中继地址不必重新打包。

### 变更
- 英文回复的句末补标点按语种选（英文 `.` / 中文 `。`），不再给英文段落补中文句号。

### 新增

**后台任务浮条（跑长任务不再干等）**
- 命令进后台后，输入框上方出现常驻浮条：`N 个后台任务运行中`，点开原地向上铺开列表（把消息顶上去，不遮盖内容），
  鼠标悬停行尾才出现删除按钮，删除有二次确认。
- 任务跑完**自动回报并接着做**：SSE 推 `running → 终态` 的跳变，前端把这轮的结论（退出码 + 末尾 2000 字输出）
  作为一条注入消息续跑，不需要用户手动催。刷页面不影响（状态在服务端，已处理记录在 `sessionStorage`）。
- 右栏可看单个任务的命令与**增量输出**（`?from=cursor` 轮询，跑完自动停），可取消。

**过程折叠改成自适应（短任务不再"证据消失"）**
- 以前完成态无条件把所有过程合成一条顶到消息最上面 —— 只跑了 3 步的任务也被收成一行摘要，
  而且打乱了「旁白 → 过程 → 结论」的阅读顺序。
- 现在按规模判断：工具 ≤3 且过程节点 ≤8 的**短任务平铺展示**，让用户看见做过什么；
  超过阈值的长任务仍合成一条，但**插在过程第一次出现的位置**（保持时间顺序）。
- 阈值抽成 `utils/process-fold.ts` 的纯函数，有 4 条断言钉住（这是产品规则，不是样式）。

**工具召回换成 BM25（"能搜到调不到"的根因）**
- 旧的召回是一行 `name.includes(query)` —— 纯子串、无排序、无 top-k；中文 query 必然 0 命中
  （工具名全英文，`query="图像"` 查不到 `generate_image`），无命中时还把 34 条按需工具**全量倒给模型**。
- 现在手写 BM25（零新依赖，k1=1.2 / b=0.75）：字段权重 名称×3 + 别名×2 + 描述×1，
  中文按 bigram 切；相对截断（低于最高分 30% 丢弃），无命中只给换词建议 + 5 个常用示例。

**能力清单收敛（`tool_search` 激活不再靠正则）**
- 白名单从**手抄 39 条**改成由注册表全量派生 —— 手抄版曾漏掉 `file_delete` / `memory_consolidate` /
  `make_article` / `browser`，一旦哪个从按需转常驻就会被静默丢掉。
- `tool_search` 发现工具后的激活，以前是**对返回文案做正则**（`已加载，可直接调用` + 抠行首工具名）——
  文案改一个字，按需工具就永久调不到且不报错。现在用本次调用的实参重放同一份检索，文案与激活彻底解耦。
- 会话能力清单带来源（builtin / skill / mcp）与稳定哈希，可回答"这个工具是谁带来的""关掉某 skill 后谁消失了"。

**闲置能力建议**
- 43 个注册工具里有 16 个从未被真实调用过，系统自己不知道。现在按天记账：闲置 ≥14 天在用量页列出，
  给出闲置天数与最近使用；当天新装的不推（刚装 ≠ 闲置）；"本版本不再提醒"带版本号，能力描述变了会重新出现。

**工具专属视图补齐 3 个**
- `tool_search`：搜索词 + 激活名单（一眼看出搜了什么、真激活了哪几个）。
- `browser` / `computer_use`：动作徽标 + 目标 + 结论三层，取代把参数 JSON 整坨贴出来的通用卡。
- 至此 top10 调用里已无工具落在兜底渲染。

### 新功能

- **逐文件 diff + 单文件回滚**：`file_write` 上报改前/改后内容，按检查点存快照；新增 `GET /api/checkpoints/:id/diff` 与 `POST /api/checkpoints/:id/restore`（指定 paths 或 all），按文件返回结果，部分成功也能如实报告。短任务此前只留快照没有检查点可挂，现在收尾时补存。
- **人格文件层**：`~/.supercrzy/{SOUL,USER,IDENTITY}.md` 注入提示词，首次启动生成模板且永不覆盖用户编辑；每份限 2k 字符，超长从中间裁剪并标注。
- **诊断包导出**：`GET /api/diagnose/bundle` 返回版本/环境/能力计数/设置快照（密钥仅报有无）/日志尾部，日志页可下载。
- **制品中心**：`/api/artifacts` 跨会话聚合（带会话标题），新增独立视图。
- **后台任务接入 L3 沙箱**：此前 `sandboxify` 只包前台执行，同一条命令前台隔离、后台不隔离；现统一，探测不可用时降级而非失败。

### 工程

- **CSS 门禁**：删掉 16 个零引用的僵尸 token，44 处历史别名用法映射到真 token
  （`--danger*` → `--error`、`--code-bg` → `--bg-code` 等）；`check-css-vars` 新增僵尸守门
  （声明了没人用即失败），接入 stylelint。CSS 变量与样式的违规从此在 `pnpm verify` 阶段拦下。
- **权限契约**：新增 `validate:permission`，钉住前端显示层与服务端决策层的档位清单逐项一致、
  `TIER_META` 覆盖全档、desktop 部署拷贝与源头逐字相等。
- **能力清单契约**：`validate:tools` 新增 4 条断言（白名单必须派生、激活必须走数据、检索确定性、按需名录文案必须真实存在）。

---

## v1.2.1 (2026-10-22) — 版本号统一 + 用量口径可信化

### 变更

**版本号只留一个（本次重点）**
- 此前同一个产品有四个手写版本号：根 `0.4.1`、client/server `0.4.1`、desktop `1.2.1`，
  git tag 是 `v1.2.0`，装机产物 `1.1.3`，而 `/api/system/version` 兜底写着 `0.3.0`。
  结果是「设置-关于显示 0.3.0」与「更新横幅提示发现新版本」并排出现，用户无法判断自己在哪个版本。
- 现在 **唯一源 = 根 `package.json` 的 `version`**，由 `scripts/version.mjs` 派生到各子包；
  `pnpm verify` 第一步跑 `version.mjs --check`，桌面 `pack`/`dist` 前置自动同步（漂移即失败）。
- 桌面主进程启动后端时注入 `APP_VERSION = app.getVersion()`，`/api/system/version` 与
  `app:info`／设置-关于 从此同源；后端不再用任何写死的假版本号做兜底。
- ⚠️ 版本线由 `0.4.1` 并到 `1.2.1`：`1.x` 是用户实际安装的线（1.1.3 → 1.2.0 → 1.2.1），
  `0.x` 只存在于 CHANGELOG 与仓库，从未对外发布。

### 修复

**用量与费用（数据可信度）**
- 上下文窗口写死 128K，而官方 V4 全系是 **1M**：顶部圆环分母错 8 倍，且压缩阈值
  （`window × 0.55`）让长任务在 **70.4K** 就被压缩（应为 576.7K）。现按模型解析，存量数据自动抬到 1M
- 用量页模型名错配：实际调用 `deepseek-v4-flash`，却全部记在 `deepseek-v4-pro` 名下。
  根因是统计按「建会话时的模型」分组；现在逐条消息记录真实模型（含 fallback 切换后的），
  老数据标记为「归因不可靠」
- 费用低估约 4.7 倍：旧价格表 `¥2/1M` 对官方 `$1.32/1M`，且不分缓存命中与峰谷时段。
  现按官方 USD 定价计算（缓存命中/未命中分档 + UTC 峰谷），并修正英文界面把人民币金额
  显示成 `$` 的问题（等于把费用缩小 7.2 倍）
- 切换会话后顶部上下文用量不重置，新会话开局显示上一会话的占用

**新增**
- 用量页可直接查看 API 余额（服务端代理，密钥不下发前端），低于 ¥5 时启动时提示充值
- 授权收敛为两档（只读 / 询问）：`prompt`、`accept-edits`、`auto` 行为本已完全一致；
  不可逆操作（删除、高风险命令）不再受「超时自动放行」影响，永远需要确认

**安全与数据保护**
- 修掉一条**审批旁路**：同样一句 `rm -rf ~/x`，走 `shell_exec` 会被拦，走终端工具的
  `terminal_send` 却直接执行。现在两条通道共用同一套命令分级；顺带补上四个真实绕过写法
  （全路径 `/bin/rm`、`\rm`、`sh -c '...'` 包裹、`find -delete`）
- 「整理记忆」在删行前先整表落盘快照（默认留在数据库旁的 `memory-snapshots/`，保留最近 20 份）；
  快照写不进去就一条都不删。误整理后可用 `node scripts/diag/restore-memory.mjs --restore <快照>`
  按 id 补回，只补不覆盖
- 权限档位的判定只留在服务端：此前前后端各写一份，漂移会让界面显示「仅查看」而实际按
  「执行前询问」跑；同时修掉 `permissionTier` 列里残留的 `deny` 被另一列顶掉（等于悄悄解锁）的问题

---

## v0.4.1 (2026-10-18) — 启动器可靠性 + AI NEWS 图片 + 模型选择器

### 修复

**启动器（桌面快捷方式 / `start.sh`）**
- 修复 macOS 报错「"SUPERCRZY BOT.command" 无法打开，因为不允许在"终端"中打开文稿」：
  根因是 `do script` 命令串里出现 `./start.sh` 相对引用，被 Automation 推断成"要打开的文稿"。
  改为绝对路径 + `bash -lc`，不再触发 TCC 拦截
- 修复新用户双击桌面图标后**没有终端窗口、看不到任何启动过程**（此前为绕 TCC 把 Terminal 整个移除）
- 修复浏览器打开时机：此前把 `open` 放在 `/api/health` 就绪之后，而 `app.listen()`
  在所有初始化完成（实测 40–55s）才执行 ⇒ 点完近一分钟才弹浏览器。
  现在依赖检查完即刻打开（实测 **4.3s**），健康检查降级为终端提示、不阻塞
- 修复**点击一次打开两个浏览器窗口**：`start.sh` 的两条路径（正常启动 / 服务已在运行复用）
  与 applet 兜底各自都会 `open`。改为标记文件 + 轮询协调，三条路径均只打开一次
- 修复服务已在运行时**误把别的副本当成自己**：判活增加「监听者 cwd 是否属于本仓库」校验，
  不再出现 B 副本显示 A 副本界面的情况
- 修复孤儿进程（父进程退出、子进程仍占端口）导致「拒绝启动」，改为识别真实监听者
- 新增：启动成功后自动关闭终端窗口（按 tty 精确匹配，不误关其他窗口；服务未就绪时保留窗口）
- 新增：新用户跑一次 `./start.sh` 即自动生成桌面 App 与桌面图标，无需另跑安装器
- 修复 `install.command` 输出乱码（`$LINK_NAME` 紧贴全角括号被吞字符）
- 桌面图标统一为安装版 App 同一张图（`build/icon.icns`，1024 源、十档齐全），不再由 512 图放大

**AI NEWS 图片**
- 修复图片频繁加载失败、且加载缓慢。实测外网串行拉同一张 772 KB 图 6 次，
  其中 2 次返回 `HTTP 200` 但字节不足（620 KB / 751 KB）并超时；
  而服务器本机 8 次全部字节一致 ⇒ 抖动发生在公网链路，但后端三项防护全缺
- 新增磁盘缓存（`~/.supercrzy/cache/news-images/`，URL+宽度 哈希，TTL 7 天）+ 进程内 LRU。
  实测第二次起 **0.003s**（原 5.86s，约 2000 倍）
- 新增重试：单次超时 8s × 最多 3 次，指数退避，4xx 不重试
- 新增完整性校验：比对 `Content-Length`，短读视为失败并重试，且不写入缓存
  （此前 `arrayBuffer()` 在连接提前关闭时返回不完整缓冲且不抛错，半张图会被当成功返回）
- 失败降级为 1×1 透明 PNG 占位图，不再返回 502 裂图

**模型选择器**
- 修复欢迎页下拉框选中短模型名（如 `V4 Flash (DeepSeek)`）时，文字后出现 60–70px 大空隙。
  根因：原生 `<select>` 宽度由最长 option 决定，叠加 `max-width: 180px`。
  新增 `ModelSelect` 组件，宽度随当前文字自适应、右侧间距固定，下拉面板按内容自适应宽度

### Features
- Weekly release cadence starting 2026-10-18

### 修复（英文摘要）
- Launcher: fixed macOS TCC "cannot open document in Terminal" error; restored terminal window;
  browser now opens at 4.3s instead of waiting for full init; eliminated double browser launch;
  detects when port 3000 is held by another clone; auto-closes the terminal window after startup;
  new users get a desktop icon from a single `./start.sh` run
- AI NEWS images: added disk+memory cache, retry with exponential backoff, `Content-Length`
  integrity check, and placeholder fallback (cache hit: 0.003s vs 5.86s)
- Model picker: new `ModelSelect` component, width adapts to the selected label instead of the
  longest option

---

## v0.3.0 (2026-08-13) — 多平台网关 + 角色化 Agent

### 新功能
- 接入 8 个消息渠道：微信 / QQ / 企业微信 / 钉钉 / 飞书 / Telegram / Discord / Slack，全部支持长连接免公网回调
- 角色化 Agent：任务按类型自动分发到设计 / 开发 / 数据分析 / 文案专家，各角色独立系统提示与记忆
- 任务结果主动推送：定时任务完成后推送到指定渠道（含全部渠道选项）
- 渠道感知输出：同一回复按平台能力自适应格式化（Markdown / 纯文本）
- 网关功能区完善：凭据脱敏、错误原因持久化、状态轮询、开发中渠道诚实标注
- 聊天区改为气泡布局：用户消息右侧品牌色气泡、AI 消息左侧浅色气泡
- 统一品牌视觉：官方 LOGO 全站应用（欢迎区 / 消息头像），浅色纯白、深色纯黑主题背景
- 版本更新：更新日志弹窗 + 一键更新（提交改动 → 拉取 → 装依赖 → 构建）
- 一键启动产品化：macOS 桌面 App（品牌图标）/ Windows start.bat / 双击即用 + 自动开浏览器

### 修复
- 修复 vite 开发代理缓冲 SSE 导致流式输出一次性到达的问题
- 修复历史对话 Markdown 表格不渲染（双重 JSON 序列化兼容）
- 修复 Agent 收尾空转（推理模型纯思考轮误判为空回复）

### Features
- 8 messaging channels: WeChat / QQ / WeCom / DingTalk / Feishu / Telegram / Discord / Slack, all via long-connection without public webhooks
- Role-based agents: tasks auto-routed to design / dev / data / copywriting experts, each with dedicated system prompt and memory
- Proactive result push: scheduled task results delivered to chosen channels (including "all channels")
- Channel-aware output: replies auto-formatted per platform capability (Markdown / plain text)
- Gateway improvements: credential masking, error persistence, status polling, honest "in development" labels
- Chat UI switched to bubble layout: user messages as brand-colored bubbles on the right, AI on the left
- Unified branding: official logo across the app, pure-white / pure-black theme backgrounds
- Version updates: changelog modal + one-click update (commit → pull → install → build)
- One-click launch: macOS desktop app (branded icon) / Windows start.bat / double-click to run + auto-open browser

### Fixes
- Fixed vite dev proxy buffering SSE, causing streamed output to arrive all at once
- Fixed history chat Markdown tables not rendering (double JSON serialization compatibility)
- Fixed agent tail-spinning (reasoning-only rounds misread as empty replies)

---

## v0.2.0 (2026-08-12) — 开源准备 + 安全加固

### 新功能
- 全仓库敏感信息清除，git 历史重写，开源审计通过
- 引入技能系统：技能库管理、GitHub 技能安装、触发词自动匹配
- Agent 经验复盘（Playbook）：同类任务自动注入历史经验
- 幽灵模式：工作区文件变化自动监控

### 修复
- shell_exec 危险命令黑名单（删根 / sudo / fork 炸弹 / 下载即执行）
- 文件预览路径穿越防护、CORS 白名单、可选 API Token 鉴权
- xlsx 安全漏洞修复（升级 exceljs）

### Features
- Cleared sensitive info repo-wide, rewrote git history, open-source audit passed
- Skills system: skill library, GitHub skill install, keyword auto-matching
- Agent playbook: auto-injects lessons from similar past tasks
- Ghost mode: automatic workspace file-change monitoring

### Fixes
- shell_exec dangerous command blacklist (rm -rf /, sudo, fork bombs, download-and-execute)
- File preview path traversal protection, CORS allowlist, optional API token auth
- xlsx vulnerability fix (upgraded to exceljs)

---

## v0.1.0 (2026-05) — 初始版本

### 新功能
- SUPERCRZY BOT 核心对话能力（Web / 微信 / QQ 三通道统一大脑）
- Agent 循环：8+ 工具（文件 / Shell / 网页 / 记忆 / 技能）
- 会话历史、记忆管理、模型多提供商配置
- 任务系统、自动化定时任务、用量统计

### Features
- SUPERCRZY BOT core chat (unified brain across Web / WeChat / QQ)
- Agent loop with 8+ tools (files / shell / web / memory / skills)
- Chat history, memory management, multi-provider model config
- Tasks, scheduled automations, usage stats

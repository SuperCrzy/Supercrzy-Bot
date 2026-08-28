const pptxgen = require("pptxgenjs");

const NAVY = "141C3A", CYAN = "19C3FB", ICE = "E8F4FD", MUTE = "9FB3D8", CARD = "1E2A4A";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = "SUPERCRZY BOT";
pres.title = "SUPERCRZY BOT 介绍报告";

function titleSlide() {
  const s = pres.addSlide();
  s.background = { color: NAVY };
  s.addShape(pres.ShapeType.rect, { x: 0.7, y: 2.2, w: 1.6, h: 0.10, fill: { color: CYAN } });
  s.addText("SUPERCRZY BOT", { x: 0.7, y: 1.0, w: 11, h: 1.0, fontSize: 60, bold: true, color: ICE, charSpacing: 2 });
  s.addText("你的全能 AI 助手 · 不只聊天，而是真正动手做事", { x: 0.7, y: 2.5, w: 11, h: 0.7, fontSize: 24, color: MUTE });
  s.addText("执行型智能体 · 交付可验证的结果", { x: 0.7, y: 5.6, w: 11, h: 0.6, fontSize: 18, color: CYAN });
  s.addNotes("开场：SUPERCRZY BOT 是一款全能 AI 助手，核心定位是执行型智能体，交付可验证的结果。");
}

function sectionHeader(s, num, title) {
  s.background = { color: NAVY };
  s.addShape(pres.ShapeType.roundRect, { x: 0.7, y: 0.55, w: 1.15, h: 1.15, rectRadius: 0.2, fill: { color: CYAN } });
  s.addText(num, { x: 0.7, y: 0.55, w: 1.15, h: 1.15, fontSize: 40, bold: true, color: NAVY, align: "center", valign: "middle" });
  s.addText(title, { x: 2.1, y: 0.62, w: 10, h: 1.0, fontSize: 34, bold: true, color: ICE });
  s.addShape(pres.ShapeType.rect, { x: 0.7, y: 1.85, w: 11.9, h: 0.03, fill: { color: "2A3A63" } });
}

function capabilitySlide() {
  const s = pres.addSlide();
  sectionHeader(s, "01", "核心能力");
  const items = [
    { t: "文档 & 办公", d: "Word / Excel / PPT / PDF，全套办公文件制作与编辑" },
    { t: "开发 & 工程", d: "代码生成、文件管理、Shell 操作、MCP 服务构建" },
    { t: "研究 & 信息", d: "实时网络搜索，权威媒体内容抓取与内容生产" },
    { t: "创意 & 设计", d: "算法艺术、海报、前端 UI、主题化视觉设计" },
  ];
  items.forEach((it, i) => {
    const row = Math.floor(i / 2), col = i % 2;
    const x = 0.7 + col * 6.25, y = 2.3 + row * 2.35;
    s.addShape(pres.ShapeType.roundRect, { x, y, w: 5.95, h: 2.05, rectRadius: 0.15, fill: { color: CARD }, line: { color: "2A3A63", width: 1 } });
    s.addShape(pres.ShapeType.roundRect, { x: x + 0.35, y: y + 0.35, w: 0.5, h: 0.5, rectRadius: 0.1, fill: { color: CYAN } });
    s.addText(String(i + 1), { x: x + 0.35, y: y + 0.35, w: 0.5, h: 0.5, fontSize: 18, bold: true, color: NAVY, align: "center", valign: "middle" });
    s.addText(it.t, { x: x + 1.05, y: y + 0.32, w: 4.7, h: 0.5, fontSize: 20, bold: true, color: ICE });
    s.addText(it.d, { x: x + 0.35, y: y + 1.0, w: 5.3, h: 0.9, fontSize: 14, color: MUTE, margin: 0 });
  });
  s.addNotes("核心能力分四大类：文档办公、开发工程、研究信息、创意设计。");
}

function channelsSlide() {
  const s = pres.addSlide();
  sectionHeader(s, "02", "多端触达 & 长期记忆");
  s.addText("多渠道无缝连接", { x: 0.7, y: 2.15, w: 5.5, h: 0.5, fontSize: 20, bold: true, color: CYAN });
  const ch = ["Web 聊天", "Telegram", "QQ", "微信", "钉钉", "飞书", "Slack", "Discord", "企业微信"];
  ch.forEach((c, i) => {
    const row = Math.floor(i / 3), col = i % 3;
    s.addShape(pres.ShapeType.roundRect, { x: 0.7 + col * 1.95, y: 2.8 + row * 0.95, w: 1.8, h: 0.78, rectRadius: 0.12, fill: { color: CARD }, line: { color: "2A3A63", width: 1 } });
    s.addText(c, { x: 0.7 + col * 1.95, y: 2.8 + row * 0.95, w: 1.8, h: 0.78, fontSize: 14, color: ICE, align: "center", valign: "middle" });
  });
  s.addText("长期记忆系统", { x: 7.0, y: 2.15, w: 5.5, h: 0.5, fontSize: 20, bold: true, color: CYAN });
  s.addText("记住你的偏好、项目事实与经验教训，跨对话不遗忘，越用越懂你。", { x: 7.0, y: 2.8, w: 5.6, h: 1.0, fontSize: 15, color: MUTE });
  const stats = [["28", "项技能"], ["9", "大渠道"], ["5", "星级记忆"]];
  stats.forEach((st, i) => {
    const x = 7.0 + i * 2.0;
    s.addText(st[0], { x, y: 4.1, w: 1.8, h: 1.0, fontSize: 48, bold: true, color: CYAN, align: "center" });
    s.addText(st[1], { x, y: 5.15, w: 1.8, h: 0.5, fontSize: 14, color: MUTE, align: "center" });
  });
  s.addNotes("支持 9 大渠道，并具备长期记忆系统，可跨对话存储用户偏好。");
}

function principlesSlide() {
  const s = pres.addSlide();
  sectionHeader(s, "03", "我的工作准则");
  const rows = [
    { t: "端到端交付", d: "任务从规划到执行，跑通、验证，给你看真实输出" },
    { t: "失败就换路", d: "一条路不通立即换方案，最多试两次再如实反馈" },
    { t: "绝不编造", d: "提供实时信息必须真实抓取，绝不糊弄你" },
    { t: "靠结果说话", d: "不吹能力，用实实在在的产出证明价值" },
  ];
  rows.forEach((r, i) => {
    const y = 2.3 + i * 1.22;
    s.addShape(pres.ShapeType.roundRect, { x: 0.7, y, w: 11.9, h: 1.02, rectRadius: 0.12, fill: { color: CARD } });
    s.addText("0" + (i + 1), { x: 1.1, y: y + 0.12, w: 0.9, h: 0.8, fontSize: 18, bold: true, color: CYAN, valign: "middle" });
    s.addText(r.t, { x: 2.1, y: y + 0.12, w: 2.6, h: 0.8, fontSize: 18, bold: true, color: ICE, valign: "middle" });
    s.addText(r.d, { x: 4.9, y: y + 0.12, w: 7.5, h: 0.8, fontSize: 15, color: MUTE, valign: "middle", margin: 0 });
  });
  s.addNotes("四条准则：端到端交付、失败换路、绝不编造、靠结果说话。");
}

function closingSlide() {
  const s = pres.addSlide();
  s.background = { color: NAVY };
  s.addShape(pres.ShapeType.rect, { x: 0.7, y: 2.0, w: 1.6, h: 0.10, fill: { color: CYAN } });
  s.addText("随时待命，开工！", { x: 0.7, y: 2.5, w: 11, h: 1.2, fontSize: 52, bold: true, color: ICE });
  s.addText("写报告 · 做表格 · 改代码 · 查资料 · 做设计 · 生成演示", { x: 0.7, y: 3.9, w: 11, h: 0.7, fontSize: 20, color: MUTE });
  s.addText("有任何活儿，直接丢给我——SUPERCRZY BOT", { x: 0.7, y: 5.7, w: 11, h: 0.6, fontSize: 16, color: CYAN });
  s.addNotes("结尾：欢迎随时安排任务，交给我来真正执行。");
}

titleSlide();
capabilitySlide();
channelsSlide();
principlesSlide();
closingSlide();

pres.writeFile({ fileName: "SUPERCRZY_介绍报告.pptx" })
  .then(() => console.log("OK: generated"))
  .catch(e => { console.error(e); process.exit(1); });

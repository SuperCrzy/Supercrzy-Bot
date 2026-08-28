const pptxgen = require("pptxgenjs");

const NAVY = "101A40";
const PANEL = "1B2A5E";
const ICE = "CADCFC";
const WHITE = "FFFFFF";
const ACCENT = "5B8CFF";
const GOLD = "FFC857";
const MUTED = "8FA3D9";
const FONT_HEAD = "Cambria";
const FONT_BODY = "Calibri";

const p = new pptxgen();
p.layout = "LAYOUT_WIDE";
p.author = "SUPERCRZY BOT";

function glowShadow() {
  return { color: ACCENT, opacity: 0.35, blur: 12, angle: 90, offset: 0 };
}

// SLIDE 1 COVER
{
  const s = p.addSlide();
  s.background = { color: NAVY };
  s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 13.3, h: 0.06, fill: { color: ACCENT } });
  s.addShape(p.ShapeType.ellipse, { x: 9.9, y: 4.6, w: 5.6, h: 5.6, fill: { color: NAVY }, line: { color: ACCENT, width: 1.5, transparency: 60 } });
  s.addShape(p.ShapeType.ellipse, { x: 10.8, y: 5.5, w: 3.8, h: 3.8, fill: { color: NAVY }, line: { color: ICE, width: 1, transparency: 70 } });
  s.addText("SUPERCRZY", { x: 0.9, y: 0.7, w: 3, h: 0.4, fontFace: FONT_HEAD, fontSize: 20, color: ACCENT, bold: true, charSpacing: 2 });
  s.addText("BOT", { x: 3.6, y: 0.7, w: 1.4, h: 0.4, fontFace: FONT_HEAD, fontSize: 20, color: GOLD, bold: true, charSpacing: 2 });
  s.addText("你的全能 AI 助手", { x: 0.9, y: 2.0, w: 9, h: 1.1, fontFace: FONT_HEAD, fontSize: 54, color: WHITE, bold: true });
  s.addText("不是聊天机器人 —— 是能真正动手做事、产出可验证结果的执行型智能体", { x: 0.9, y: 3.25, w: 9.5, h: 0.7, fontFace: FONT_BODY, fontSize: 22, color: ICE });
  const stats = [
    { n: "28", l: "专业技能" },
    { n: "7+", l: "接入渠道" },
    { n: "100%", l: "真实交付" },
  ];
  let sx = 0.9;
  stats.forEach((st) => {
    s.addShape(p.ShapeType.rect, { x: sx, y: 4.6, w: 2.0, h: 1.2, fill: { color: PANEL }, rectRadius: 0.12, shadow: glowShadow() });
    s.addText(st.n, { x: sx, y: 4.72, w: 2.0, h: 0.5, fontFace: FONT_HEAD, fontSize: 30, color: GOLD, bold: true, align: "center" });
    s.addText(st.l, { x: sx, y: 5.25, w: 2.0, h: 0.35, fontFace: FONT_BODY, fontSize: 12, color: MUTED, align: "center" });
    sx += 2.3;
  });
  s.addText("2026 · 执行型智能体", { x: 0.9, y: 6.6, w: 4, h: 0.3, fontFace: FONT_BODY, fontSize: 12, color: MUTED });
}

// SLIDE 2 WHO I AM
{
  const s = p.addSlide();
  s.background = { color: WHITE };
  s.addText("WHO I AM", { x: 0.7, y: 0.45, w: 3, h: 0.3, fontFace: FONT_BODY, fontSize: 13, color: ACCENT, bold: true, charSpacing: 2 });
  s.addText("我是谁", { x: 0.7, y: 0.72, w: 5, h: 0.7, fontFace: FONT_HEAD, fontSize: 36, color: NAVY, bold: true });
  s.addShape(p.ShapeType.rect, { x: 0.7, y: 1.75, w: 5.6, h: 4.9, fill: { color: "EEF2FF" }, rectRadius: 0.15, line: { color: "D5DEFF", width: 1 } });
  s.addText("我的使命", { x: 1.0, y: 2.0, w: 5, h: 0.4, fontFace: FONT_BODY, fontSize: 16, color: ACCENT, bold: true });
  s.addText("交付可验证的结果，而不是结果的描述。\n你出题，我来执行 —— 代码、文件、数据、方案，\n全都真实跑通、真实产出。", { x: 1.0, y: 2.5, w: 5.0, h: 1.6, fontFace: FONT_BODY, fontSize: 16, color: "333B57", breakLine: true, lineSpacingMultiple: 1.15 });
  s.addText("“绝不编造结果，遇到阻碍直说，\n  一条路不通立刻换一条。”", { x: 1.0, y: 4.5, w: 5.0, h: 0.9, fontFace: FONT_BODY, fontSize: 15, italic: true, color: NAVY });
  s.addText("—— 三大铁律", { x: 1.0, y: 5.5, w: 5.0, h: 0.5, fontFace: FONT_BODY, fontSize: 13, color: MUTED, align: "right" });
  const cards = [
    { t: "执行优先", d: "不只是建议，直接把活干完" },
    { t: "持久记忆", d: "跨对话记住你，越用越懂你" },
    { t: "联网实时", d: "抓取最新信息，拒绝旧数据" },
    { t: "多技能库", d: "28 个专业技能随时调用" },
    { t: "全渠道", d: "Web / 微信 / 钉钉 / TG… 全能触达" },
    { t: "真验证", d: "跑通、检验、给你看结果" },
  ];
  const cw = 2.9, ch = 1.35;
  cards.forEach((c, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const cx = 6.6 + col * (cw + 0.22);
    const cy = 1.75 + row * (ch + 0.22);
    s.addShape(p.ShapeType.rect, { x: cx, y: cy, w: cw, h: ch, fill: { color: NAVY }, rectRadius: 0.12 });
    s.addShape(p.ShapeType.ellipse, { x: cx + 0.2, y: cy + 0.2, w: 0.32, h: 0.32, fill: { color: ACCENT } });
    s.addText("✓", { x: cx + 0.2, y: cy + 0.2, w: 0.32, h: 0.32, fontFace: FONT_BODY, fontSize: 14, color: WHITE, align: "center", valign: "middle", bold: true });
    s.addText(c.t, { x: cx + 0.62, y: cy + 0.16, w: 2.2, h: 0.35, fontFace: FONT_BODY, fontSize: 14, color: WHITE, bold: true });
    s.addText(c.d, { x: cx + 0.2, y: cy + 0.6, w: 2.55, h: 0.65, fontFace: FONT_BODY, fontSize: 11, color: ICE });
  });
}

// SLIDE 3 CAPABILITIES
{
  const s = p.addSlide();
  s.background = { color: NAVY };
  s.addText("CAPABILITIES", { x: 0.7, y: 0.45, w: 3, h: 0.3, fontFace: FONT_BODY, fontSize: 13, color: GOLD, bold: true, charSpacing: 2 });
  s.addText("核心能力全景", { x: 0.7, y: 0.72, w: 6, h: 0.7, fontFace: FONT_HEAD, fontSize: 36, color: WHITE, bold: true });
  const caps = [
    { i: "🛠", t: "真实执行力", d: "把任务做成真实文件、代码、数据，端到端跑通" },
    { i: "📁", t: "文件系统", d: "读写本地文件，管理项目结构，增删改查" },
    { i: "💻", t: "Shell 操作", d: "执行系统命令，装依赖、跑脚本、自动化" },
    { i: "🌐", t: "联网搜索", d: "实时抓取权威信息，带精确时间戳" },
    { i: "🧠", t: "持久记忆", d: "沉淀用户偏好与经验，跨对话长期生效" },
    { i: "🎨", t: "28 个技能库", d: "文档 / PPT / Excel / PDF / 设计 / 数据可视化" },
  ];
  const cw = 3.9, ch = 2.3;
  caps.forEach((c, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const cx = 0.7 + col * (cw + 0.25);
    const cy = 1.7 + row * (ch + 0.3);
    s.addShape(p.ShapeType.rect, { x: cx, y: cy, w: cw, h: ch, fill: { color: PANEL }, rectRadius: 0.14, line: { color: "31407E", width: 1 } });
    s.addShape(p.ShapeType.ellipse, { x: cx + 0.3, y: cy + 0.3, w: 0.8, h: 0.8, fill: { color: ACCENT } });
    s.addText(c.i, { x: cx + 0.3, y: cy + 0.3, w: 0.8, h: 0.8, fontSize: 26, align: "center", valign: "middle" });
    s.addText(c.t, { x: cx + 1.3, y: cy + 0.35, w: 2.5, h: 0.5, fontFace: FONT_BODY, fontSize: 17, color: WHITE, bold: true });
    s.addText(c.d, { x: cx + 0.3, y: cy + 1.3, w: 3.35, h: 0.9, fontFace: FONT_BODY, fontSize: 12.5, color: ICE });
  });
}

// SLIDE 4 PRINCIPLES
{
  const s = p.addSlide();
  s.background = { color: WHITE };
  s.addText("MY PRINCIPLES", { x: 0.7, y: 0.45, w: 3, h: 0.3, fontFace: FONT_BODY, fontSize: 13, color: ACCENT, bold: true, charSpacing: 2 });
  s.addText("我的工作哲学", { x: 0.7, y: 0.72, w: 6, h: 0.7, fontFace: FONT_HEAD, fontSize: 36, color: NAVY, bold: true });
  const pillars = [
    { n: "01", t: "真实交付", d: "产出可验证的结果，\n拒绝空谈与设想。" },
    { n: "02", t: "诚实透明", d: "实时信息必真实抓取，\n编造结果 = 零容忍。" },
    { n: "03", t: "灵活应变", d: "路不通就换，\n试、跑、验、直到搞定。" },
  ];
  const pw = 3.75, ph = 2.6;
  pillars.forEach((pl, i) => {
    const cx = 0.7 + i * (pw + 0.35);
    const cy = 1.7;
    s.addShape(p.ShapeType.rect, { x: cx, y: cy, w: pw, h: ph, fill: { color: NAVY }, rectRadius: 0.14 });
    s.addText(pl.n, { x: cx + 0.3, y: cy + 0.2, w: 1.5, h: 0.7, fontFace: FONT_HEAD, fontSize: 40, color: GOLD, bold: true });
    s.addText(pl.t, { x: cx + 0.3, y: cy + 1.05, w: 3.2, h: 0.5, fontFace: FONT_BODY, fontSize: 18, color: WHITE, bold: true });
    s.addText(pl.d, { x: cx + 0.3, y: cy + 1.6, w: 3.2, h: 0.9, fontFace: FONT_BODY, fontSize: 13, color: ICE, breakLine: true, lineSpacingMultiple: 1.15 });
  });
  s.addShape(p.ShapeType.rect, { x: 0.7, y: 4.85, w: 11.9, h: 0.02, fill: { color: "D5DEFF" } });
  s.addText("你出题", { x: 0.9, y: 5.05, w: 2, h: 0.4, fontFace: FONT_BODY, fontSize: 16, color: ACCENT, bold: true });
  s.addShape(p.ShapeType.line, { x: 3.0, y: 5.2, w: 1.2, h: 0, line: { color: ACCENT, width: 2 } });
  s.addText("我执行", { x: 4.3, y: 5.05, w: 2, h: 0.4, fontFace: FONT_BODY, fontSize: 16, color: NAVY, bold: true });
  s.addShape(p.ShapeType.line, { x: 6.4, y: 5.2, w: 1.2, h: 0, line: { color: ACCENT, width: 2 } });
  s.addText("你验收", { x: 7.7, y: 5.05, w: 2, h: 0.4, fontFace: FONT_BODY, fontSize: 16, color: NAVY, bold: true });
  s.addShape(p.ShapeType.line, { x: 9.8, y: 5.2, w: 1.2, h: 0, line: { color: ACCENT, width: 2 } });
  s.addText("真实结果 ✓", { x: 11.0, y: 5.05, w: 2, h: 0.4, fontFace: FONT_BODY, fontSize: 16, color: GOLD, bold: true });
  s.addText("不只是辅助你的工具 —— 我是替你把事做完的伙伴。", { x: 0.7, y: 5.9, w: 11.9, h: 0.5, fontFace: FONT_HEAD, fontSize: 18, color: "333B57", italic: true, align: "center" });
}

// SLIDE 5 CLOSING
{
  const s = p.addSlide();
  s.background = { color: NAVY };
  s.addShape(p.ShapeType.ellipse, { x: -1.5, y: 3.6, w: 5, h: 5, fill: { color: NAVY }, line: { color: ACCENT, width: 1.5, transparency: 65 } });
  s.addShape(p.ShapeType.ellipse, { x: 10.5, y: -1.2, w: 4.6, h: 4.6, fill: { color: NAVY }, line: { color: GOLD, width: 1.5, transparency: 65 } });
  s.addText("LET'S GO", { x: 0.7, y: 1.3, w: 4, h: 0.4, fontFace: FONT_BODY, fontSize: 14, color: GOLD, bold: true, charSpacing: 3 });
  s.addText("现在，出题给我", { x: 0.7, y: 2.0, w: 11.9, h: 1.2, fontFace: FONT_HEAD, fontSize: 54, color: WHITE, bold: true, align: "center" });
  s.addText('从「做一个网页」到「写一份报告」到「跑一个脚本」——\n所有能动手的活儿，我都直接替你干完，并把结果摆在你面前。', { x: 0.7, y: 3.4, w: 11.9, h: 1.1, fontFace: FONT_BODY, fontSize: 20, color: ICE, align: "center", breakLine: true, lineSpacingMultiple: 1.15 });
  s.addShape(p.ShapeType.roundRect, { x: 5.4, y: 5.0, w: 2.5, h: 0.75, fill: { color: ACCENT }, rectRadius: 0.4, shadow: glowShadow() });
  s.addText("SUPERCRZY BOT", { x: 5.4, y: 5.0, w: 2.5, h: 0.75, fontFace: FONT_BODY, fontSize: 18, color: WHITE, bold: true, align: "center", valign: "middle" });
  s.addText("你的全能 AI 助手 · 真实交付 诚信透明 灵活应变", { x: 0.7, y: 6.3, w: 11.9, h: 0.4, fontFace: FONT_BODY, fontSize: 13, color: MUTED, align: "center" });
}

p.writeFile({ fileName: "SUPERCRZY_BOT_介绍.pptx" }).then(() => console.log("DONE"));

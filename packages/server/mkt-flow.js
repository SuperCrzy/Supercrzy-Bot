// MKT 流程图时间线控制
const steps = [
  {t:0,     txt:'🎬 MKT 工作流动画即将开始…', ph:0},
  {t:1000,  txt:'🔵 开始：营销工作流启动', ph:1},
  {t:2000,  txt:'📊 ① 市场调研：用户洞察 · 竞品分析', ph:1},
  {t:3000,  txt:'🎯 ② 策略制定：定目标 · 定预算 · 定打法', ph:1},
  {t:4100,  txt:'💰 预算审批：预算是否通过？', ph:1},
  {t:4600,  txt:'✅ 审批通过 → 进入执行阶段', ph:2},
  {t:5600,  txt:'📅 ③ 计划排期：选渠道 · 内容排期', ph:2},
  {t:6600,  txt:'🚀 ④ 执行落地：内容投放 · 活动执行', ph:2},
  {t:7600,  txt:'📈 ⑤ 数据监测：效果追踪 · 数据分析', ph:2},
  {t:8700,  txt:'🏁 效果判断：达标 → 复盘，不达标 → 应急调整', ph:2},
  {t:9300,  txt:'✅ 达标 → 进入复盘阶段', ph:3},
  {t:10300, txt:'🔍 ⑥ 复盘优化：ROI 评估 · 策略迭代', ph:3},
  {t:11300, txt:'🏆 结束：本轮流程完成', ph:3},
  {t:12000, txt:'🔄 分支①：预算不通过 → 弹回策略层调整', ph:1},
  {t:12900, txt:'🔄 分支②：效果不达标 → 绕行回执行层应急调整', ph:2},
  {t:13800, txt:'♻️ 大反馈回路：复盘结果持续回流策略层，闭环迭代', ph:3},
  {t:14500, txt:'✅ 完整闭环演示结束 · 点击「重播」再看一遍', ph:3}
];
const TOTAL = 15000;

let lastT = 0, paused = false, startTime = performance.now(), raf;
const stepBox = document.getElementById('stepBox');
const pbar = document.getElementById('pbar');
const phases = document.querySelectorAll('.phase');
const svg = document.querySelector('svg');

function updateUI(t){
  let cur = steps[0];
  for (const s of steps) if (t >= s.t) cur = s;
  stepBox.innerHTML = cur.txt;
  phases.forEach((p,i)=>p.classList.toggle('on', i+1 === cur.ph));
  pbar.style.width = Math.min(100, t/TOTAL*100) + '%';
}
function tick(now){
  if (!paused){ lastT = now - startTime; updateUI(lastT); }
  raf = requestAnimationFrame(tick);
}
raf = requestAnimationFrame(tick);

const btnPlay = document.getElementById('btnPlay');
btnPlay.addEventListener('click', ()=>{
  paused = !paused;
  if (paused){ svg.pauseAnimations(); btnPlay.textContent = '▶ 继续'; }
  else { startTime = performance.now() - lastT; svg.unpauseAnimations(); btnPlay.textContent = '⏸ 暂停'; }
  document.body.classList.toggle('paused', paused);
});
document.getElementById('btnReplay').addEventListener('click', ()=>location.reload());

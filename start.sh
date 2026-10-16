#!/usr/bin/env bash
# ============================================================
# SUPERCRZY BOT — 一键启动（生产模式）
# 自动检查环境 → 安装依赖 → 构建前端 → 启动 Web UI + API
# 单进程：http://localhost:3000 同时服务页面与 API，自动打开浏览器
# 用法: ./start.sh   （或双击 SUPERCRZY BOT.command）
# ============================================================
set -e
cd "$(dirname "$0")"

C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_CYAN='\033[0;36m'; C_NC='\033[0m'
info()  { echo -e "${C_CYAN}[SUPERCRZY BOT]${C_NC} $1"; }
ok()    { echo -e "${C_GREEN}✔${C_NC} $1"; }
warn()  { echo -e "${C_YELLOW}⚠${C_NC} $1"; }
fail()  { echo -e "${C_RED}✘${C_NC} $1"; exit 1; }

echo -e "${C_CYAN}=============================================="
echo -e "      SUPERCRZY BOT — 一键启动"
echo -e "==============================================${C_NC}"

# 停止服务：start.sh stop
# 开发模式：server + client（5173 热更新）—— 供 `supercrzy dev` 转发（2026-10-16）
# 与生产模式的差别：前台运行、带 HMR、不写 pid 文件、不开浏览器（由 vite 自己给地址）
if [ "$1" = "dev" ]; then
  echo -e "${C_CYAN}[SUPERCRZY BOT]${C_NC} 开发模式（ctrl-c 退出）"
  exec pnpm dev
fi

# 终端对话：转发到 server 的 cli.ts —— 供 `supercrzy cli` 转发（2026-10-16）
if [ "$1" = "cli" ]; then
  exec pnpm cli
fi


if [ "$1" = "stop" ]; then
  PID_FILE="${HOME}/.supercrzy/server.pid"
  stopped=0
  [ -f "$PID_FILE" ] && PID=$(cat "$PID_FILE" 2>/dev/null) || PID=""
  # 1. 杀记录的主进程（pnpm 父）
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then kill "$PID" 2>/dev/null && stopped=1; fi
  # 2. 补杀 pnpm/node 服务子进程（pnpm 起的 node 会继承，父死子成孤儿）
  pkill -f "tsx.*src/app.ts" 2>/dev/null || true
  pkill -f "packages/server/src/app" 2>/dev/null || true
  # 3. 兜底：杀占用 3000-3010 的进程
  for port in $(seq 3000 3010); do lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true; done
  rm -f "$PID_FILE"
  [ "$stopped" = "1" ] && ok "已停止服务" || warn "未检测到运行中的服务（已清理残留）"
  exit 0
fi

# 1. 检查 Node（engines 要求 >=22.18.0 <23，见 package.json / .nvmrc）
if ! command -v node >/dev/null 2>&1; then fail "未找到 Node.js，请先安装 Node 22.x (https://nodejs.org)"; fi
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then fail "Node 版本过低 (当前 $(node -v))，需要 22.x"; fi
if [ "$NODE_MAJOR" -gt 22 ]; then warn "当前 Node $(node -v)；仓库只在 22.x 上验证过，异版可能装不上依赖（见 .nvmrc）"; fi
ok "Node $(node -v)"

# 2. 检查 pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  warn "未找到 pnpm，正在安装..."
  npm install -g pnpm || fail "pnpm 安装失败，请手动执行 npm install -g pnpm"
fi
ok "pnpm $(pnpm -v)"

# 3. 安装依赖（首次或依赖变更时）
if [ ! -d node_modules ]; then
  info "首次运行，安装依赖（约 1-2 分钟）..."
  pnpm install || fail "依赖安装失败"
else
  ok "依赖已就绪"
fi

# 4. 生成 .env（不存在时自动从模板复制）
if [ ! -f .env ]; then
  cp .env.example .env
  warn "已生成 .env（使用默认配置）。"
  warn "API Key 两种配置方式任选其一："
  warn "  A. 编辑 .env 填入 OPENAI_KEY=sk-..."
  warn "  B. 启动后在 Web UI → 设置 → 模型/API Key 里填写（推荐，无需重启）"
else
  ok ".env 已存在"
fi

# 5. 构建前端（仅当 dist 缺失或源码更新过时）
DIST_HTML="packages/client/dist/index.html"
if [ ! -f "$DIST_HTML" ]; then
  info "首次构建前端（约 30 秒）..."
  pnpm --filter @supercrzy/client build || fail "前端构建失败"
else
  # 源码比 dist 新 → 重新构建（排除 node_modules 与 dist 自身）
  if find packages/client/src -newer "$DIST_HTML" -type f 2>/dev/null | grep -q .; then
    info "检测到前端源码更新，重新构建..."
    pnpm --filter @supercrzy/client build || fail "前端构建失败"
  else
    ok "前端构建产物已就绪"
  fi
fi

# 6. 后台守护启动（2026-08-26 老板：一键免命令 + 关窗/端口不挂）
# 用 nohup 后台起服务 + PID 文件管理：关终端窗不丢、重启不重复起、端口被占自动换。
PID_FILE="${HOME}/.supercrzy/server.pid"
LOG_FILE="${HOME}/.supercrzy/server.log"
mkdir -p "${HOME}/.supercrzy"

# 若已在运行 → 直接打开浏览器（不重复起服务）
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    ok "服务已在运行 (PID $OLD_PID)，直接打开界面"
    URL="http://localhost:$(grep -oE 'localhost:[0-9]+' "$LOG_FILE" 2>/dev/null | head -1 | cut -d: -f2 || echo 3000)"
    open "$URL" 2>/dev/null || true
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

# 自动选端口：3000 起，被占则 +1（≤3010）
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && ! curl -s -o /dev/null --max-time 1 "http://localhost:$1" 2>/dev/null; }
PORT=3000
for p in $(seq 3000 3010); do
  if port_free "$p"; then PORT=$p; break; fi
done
URL="http://localhost:${PORT}"

# nohup 后台启动（脱离终端，关窗不挂）；走 pnpm（第2步已确认）+ PORT 环境变量
info "后台启动服务... ${URL}"
nohup env PORT=$PORT pnpm --filter @supercrzy/server start >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
ok "已启动 (PID $SERVER_PID, 端口 $PORT)"

# 等待就绪（最多 30s）
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 1 "http://localhost:${PORT}/api/conversations" 2>/dev/null; then
    break
  fi
  sleep 1
done

# 自动打开浏览器
if command -v open >/dev/null 2>&1; then open "$URL"; fi
info "服务已就绪：${URL}（关掉本窗口不影响，服务后台保活）"
info "停止：bash start.sh stop"
if command -v supercrzy >/dev/null 2>&1; then
  info "也可以用：supercrzy status / supercrzy dev / supercrzy cli"
fi


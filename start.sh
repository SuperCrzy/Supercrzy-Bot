#!/usr/bin/env bash
# ============================================================
# SUPERCRZY BOT — 一键启动脚本
# 自动检查环境 → 安装依赖 → 生成 .env → 启动 Web UI + API
# 用法: ./start.sh
# ============================================================
set -e
cd "$(dirname "$0")"

C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_CYAN='\033[0;36m'; C_NC='\033[0m'
info()  { echo -e "${C_CYAN}[SUPERCRZY BOT]${C_NC} $1"; }
ok()    { echo -e "${C_GREEN}✔${C_NC} $1"; }
warn()  { echo -e "${C_YELLOW}⚠${C_NC} $1"; }
fail()  { echo -e "${C_RED}✘${C_NC} $1"; exit 1; }

echo -e "${C_CYAN}=============================================="
echo "      SUPERCRZY BOT — 一键启动"
echo "==============================================${C_NC}"

# 1. 检查 Node（需要 >= 20）
if ! command -v node >/dev/null 2>&1; then fail "未找到 Node.js，请先安装 Node >= 20 (https://nodejs.org)"; fi
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then fail "Node 版本过低 (当前 $(node -v))，需要 >= 20"; fi
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
  warn "  A. 编辑 .env 填入 DEEPSEEK_API_KEY=sk-..."
  warn "  B. 启动后在 Web UI → 设置 → 模型/API Key 里填写（推荐，无需重启）"
else
  ok ".env 已存在"
fi

# 5. 启动
info "启动中... 打开 http://localhost:5173 使用 Web UI（后端 http://localhost:3000）"
info "按 Ctrl+C 停止"
exec pnpm dev

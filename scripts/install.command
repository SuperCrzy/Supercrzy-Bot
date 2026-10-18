#!/usr/bin/env bash
# ============================================================
# SUPERCRZY BOT — 安装器
# 一键在桌面创建启动图标（双击桌面图标即可启动）
# 用法: 双击本文件（或 ./scripts/install.command）
# 原理: 在桌面创建指向项目内 .app 的符号链接
#       （.app 留在项目根 → 能正确找到 start.sh，无权限弹窗）
# ============================================================
cd "$(dirname "$0")/.."

C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_CYAN='\033[0;36m'; C_NC='\033[0m'
info()  { echo -e "${C_CYAN}[SUPERCRZY BOT]${C_NC} $1"; }
ok()    { echo -e "${C_GREEN}✔${C_NC} $1"; }
fail()  { echo -e "${C_RED}✘${C_NC} $1"; exit 1; }

APP_NAME="SUPERCRZY BOT.app"
PROJECT_DIR="$PWD"
APP_PATH="$PROJECT_DIR/$APP_NAME"
DESKTOP="$HOME/Desktop"
LINK_NAME="SUPERCRZY BOT"

echo -e "${C_CYAN}=============================================="
echo -e "      SUPERCRZY BOT — 安装器"
echo -e "==============================================${C_NC}"

# 1. 检查 .app，不存在则先生成
if [ ! -d "$APP_PATH" ]; then
  info "未找到 $APP_NAME，正在生成..."
  ./scripts/make-app.sh || fail "App 生成失败"
fi
ok "App 已就绪 ($APP_PATH)"

# 2. 定位桌面目录（兼容中英文系统）
[ -d "$DESKTOP" ] || DESKTOP=$(osascript -e 'tell application "Finder" to POSIX path of (desktop as alias)' 2>/dev/null || echo "$HOME/Desktop")
[ -d "$DESKTOP" ] || fail "无法定位桌面目录"
ok "桌面目录: $DESKTOP"

# 3. 清理旧链接（避免重复/失效残留）
rm -f "$DESKTOP/$LINK_NAME" 2>/dev/null

# 4. 创建符号链接（无权限弹窗，双击解析回真实 .app）
ln -s "$APP_PATH" "$DESKTOP/$LINK_NAME" || fail "创建桌面图标失败"

echo ""
echo -e "${C_GREEN}=============================================="
echo -e "  安装完成！桌面已出现「${LINK_NAME}」图标"
echo -e "  双击图标即可启动 SUPERCRZY BOT"
echo -e "  （提示: 若移动了项目文件夹，请重新运行安装器）"
echo -e "==============================================${C_NC}"

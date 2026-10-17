#!/usr/bin/env bash
# ============================================================
# SUPERCRZY BOT — Linux 安装器（生成桌面启动器）
# 用法: ./scripts/install-linux.sh
# 产物: ~/.local/share/applications/supercrzy-bot.desktop
#       ~/Desktop/supercrzy-bot.desktop（桌面图标，如存在）
#
# 与 macOS 的 install.command 对齐：不复制程序，只在桌面放一个指向
# 项目内 start.sh 的快捷方式。这样项目移动后重跑一次即可，不会出现
# "捷径指向旧路径" 的悬空条目。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$PWD"
START="$PROJECT_DIR/start.sh"

C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_CYAN='\033[0;36m'; C_NC='\033[0m'
info(){ echo -e "${C_CYAN}[SUPERCRZY BOT]${C_NC} $1"; }
ok(){   echo -e "${C_GREEN}✔${C_NC} $1"; }
fail(){ echo -e "${C_RED}✘${C_NC} $1"; exit 1; }

echo -e "${C_CYAN}=============================================="
echo -e "      SUPERCRZY BOT — Linux 安装器"
echo -e "==============================================${C_NC}"

[ -f "$START" ] || fail "未找到 start.sh（请把本脚本放在 <项目根>/scripts/ 下）"
chmod +x "$START" 2>/dev/null || true
ok "项目目录: $PROJECT_DIR"

# 图标：优先用仓库里的 logo
ICON=""
for c in "$PROJECT_DIR/packages/client/public/logo.png" "$PROJECT_DIR/packages/desktop/build/icon.png"; do
  [ -f "$c" ] && ICON="$c" && break
done

APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"

DESKTOP_ENTRY="[Desktop Entry]
Type=Application
Name=SUPERCRZY BOT
Comment=Self-hosted AI agent platform
Exec=bash \"$START\"
Path=$PROJECT_DIR
Terminal=true
Categories=Development;Utility;
StartupNotify=false
"
[ -n "$ICON" ] && DESKTOP_ENTRY="${DESKTOP_ENTRY}Icon=$ICON
"

printf '%s' "$DESKTOP_ENTRY" > "$APPS/supercrzy-bot.desktop"
chmod +x "$APPS/supercrzy-bot.desktop"
ok "已写入 $APPS/supercrzy-bot.desktop"

# 桌面图标（各发行版桌面目录可能是 Desktop 或 桌面）
DESK=""
for d in "$HOME/Desktop" "$HOME/桌面"; do [ -d "$d" ] && DESK="$d" && break; done
if [ -n "$DESK" ]; then
  cp "$APPS/supercrzy-bot.desktop" "$DESK/supercrzy-bot.desktop"
  chmod +x "$DESK/supercrzy-bot.desktop"
  # GNOME 需要标记为可信，否则双击会提示"不受信任"
  command -v gio >/dev/null 2>&1 && gio set "$DESK/supercrzy-bot.desktop" metadata::trusted true 2>/dev/null || true
  ok "已创建桌面图标: $DESK/supercrzy-bot.desktop"
else
  info "未找到桌面目录，跳过桌面图标（应用菜单里仍可用）"
fi

echo ""
echo -e "${C_GREEN}=============================================="
echo -e "  安装完成"
echo -e "  应用菜单里搜 \"SUPERCRZY BOT\" 即可启动"
echo -e "  （移动项目目录后请重新运行本脚本）"
echo -e "==============================================${C_NC}"

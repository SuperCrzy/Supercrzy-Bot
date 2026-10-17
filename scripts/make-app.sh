#!/usr/bin/env bash
# ============================================================
# SUPERCRZY BOT — 生成 macOS 桌面 .app（双击图标即启动）
# 用法: ./scripts/make-app.sh
# 产物: SUPERCRZY BOT.app（位于项目根，与 start.sh 同级）
# 说明: 双击 .app → 打开终端 → 运行 start.sh → 浏览器自动打开
# ============================================================
set -e
cd "$(dirname "$0")/.."

APP_NAME="SUPERCRZY BOT.app"
APP_PATH="$PWD/$APP_NAME"
# 权威图标源（见下方第 3 步）；此变量是 logo.png 回退路径
LOGO="packages/client/public/logo.png"

echo "[SUPERCRZY BOT] 生成桌面 App: $APP_NAME"

# 1. 检查 osacompile（macOS 自带）
if ! command -v osacompile >/dev/null 2>&1; then
  echo "✘ 未找到 osacompile（需要 macOS）"; exit 1
fi

# 2. 用 AppleScript 生成 app（点击后打开终端运行 start.sh）
rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" \
  -e 'on run' \
  -e '  set appPath to POSIX path of (path to me)' \
  -e '  set projectDir to do shell script "dirname " & quoted form of appPath' \
  -e '  tell application "Terminal"' \
  -e '    activate' \
  -e '    do script "cd " & quoted form of projectDir & " && if [ -f start.sh ]; then ./start.sh; else echo; echo \"[SUPERCRZY BOT] 未找到 start.sh\"; echo \"请将 SUPERCRZY BOT.app 放回项目根目录后再双击\"; echo; fi"' \
  -e '  end tell' \
  -e 'end run'
echo "✔ AppleScript 包装完成"

# 3. 应用品牌图标
#
# 🔴 图标源优先级（2026-10-17 老板确认「桌面图标需要用我们 App 的图标」）：
#   ① packages/desktop/build/icon.icns —— **权威源**，与 Electron 安装版 App 同图，
#      内含完整的 16→1024 十档尺寸，直接 copy 不做任何重采样。
#   ② 回退 packages/client/public/logo.png —— 仅 512×512，需放大到 1024，
#      Retina 上会发虚；只在 ① 缺失时兜底，并明确警告。
# 历史问题：旧脚本只用 logo.png（512）生成，导致桌面图标与安装版 App 是**两张不同的图**，
# 且 1024 档是把 512 强行放大出来的，视觉上模糊。
BRAND_ICNS="packages/desktop/build/icon.icns"
DEST_ICNS="$APP_PATH/Contents/Resources/applet.icns"

if [ -f "$BRAND_ICNS" ]; then
  cp "$BRAND_ICNS" "$DEST_ICNS" \
    && echo "✔ 品牌图标已应用（build/icon.icns，与安装版 App 同图）" \
    || echo "⚠ 图标拷贝失败，使用默认图标"
elif [ -f "$LOGO" ]; then
  echo "⚠ 未找到 build/icon.icns，回退到 logo.png（512，放大后略模糊）"
  ICONSET=$(mktemp -d)/logo.iconset
  mkdir -p "$ICONSET"
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$LOGO" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
  done
  # @2x 尺寸（retina）
  for s in 16 32 64 128 256; do
    d=$((s*2))
    sips -z $d $d "$LOGO" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
  done
  # 用 512 覆盖 512@2x（原图就是 512，放大无意义）
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png" 2>/dev/null || true

  if command -v iconutil >/dev/null 2>&1; then
    iconutil -c icns "$ICONSET" -o /tmp/applet.icns 2>/dev/null \
      && cp /tmp/applet.icns "$DEST_ICNS" \
      && echo "✔ 图标已应用（logo.png 回退路径）" || echo "⚠ 图标生成失败，使用默认图标"
  else
    echo "⚠ 未找到 iconutil，使用默认图标"
  fi
else
  echo "⚠ 未找到图标源（build/icon.icns / logo.png），使用默认图标"
fi

# 4. 完成
echo ""
echo "=============================================="
echo "  完成！桌面 App: $APP_PATH"
echo "  双击即可启动（首次若被拦截，右键 → 打开）"
echo "=============================================="

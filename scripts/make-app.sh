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

# 3. 生成品牌图标（logo.png → .icns）
if [ -f "$LOGO" ]; then
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
      && cp /tmp/applet.icns "$APP_PATH/Contents/Resources/applet.icns" \
      && echo "✔ 品牌图标已应用" || echo "⚠ 图标生成失败，使用默认图标"
  else
    echo "⚠ 未找到 iconutil，使用默认图标"
  fi
else
  echo "⚠ 未找到 logo.png，使用默认图标"
fi

# 4. 完成
echo ""
echo "=============================================="
echo "  完成！桌面 App: $APP_PATH"
echo "  双击即可启动（首次若被拦截，右键 → 打开）"
echo "=============================================="

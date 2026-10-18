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

# 2. 用 AppleScript 生成 app
#
# 🔴 2026-10-18 重写：**不再 tell application "Terminal"**
#   旧实现 `tell app "Terminal" ... do script "cd ... && ./start.sh"` 有两个致命问题：
#     ① TCC/Automation 拦截：命令串里出现 `./start.sh`，macOS 会把同级目录下的
#        `SUPERCRZY BOT.command` 判成"要在终端中打开的文稿"，触发
#        「不允许 "xxx" 在"终端"中打开文稿」。宿主进程名不同（Terminal / Sandbox /
#        WorkBuddy 等）报错文案就不同，但**根因都是这条 Automation 路径**。
#        且 .app 是 adhoc 签名、CFBundleIdentifier 带空格（osacompile 默认），
#        TCC 记录无法稳定绑定 ⇒ 用户每次都要重新授权，或被直接拒绝。
#     ② 依赖 Terminal.app 存在：无终端环境（远程、受限账户、精简系统）直接失败。
#   现在改用 `do shell script`：由 applet 进程自己 fork 执行 start.sh，
#   **不经过 Terminal、不触发 Apple Events、不需要任何 Automation 授权**。
#   `&> /dev/null` 丢弃输出（applet 无终端可写）；`nohup` + `&` 让脚本脱离父进程，
#   applet 立即退出不阻塞（start.sh 自己会把服务 nohup 到后台并 open 浏览器）。
rm -rf "$APP_PATH"
# 用独立 .applescript 文件编译（-e 多行写法对注释/特殊字符脆弱，2026-10-18 换）
APPLESCRIPT_SRC="$(mktemp -d)/main.applescript"
cat > "$APPLESCRIPT_SRC" <<'APPLESCRIPT'
on run
	set appPath to POSIX path of (path to me)
	set projectDir to do shell script "dirname " & quoted form of appPath
	set scriptPath to projectDir & "/start.sh"
	try
		do shell script "test -f " & quoted form of scriptPath
	on error
		display dialog "[SUPERCRZY BOT] 未找到 start.sh。请将 SUPERCRZY BOT.app 放回项目根目录后再双击。" buttons {"好"} default button 1 with title "SUPERCRZY BOT"
		return
	end try
	display notification "正在启动，浏览器稍后自动打开…" with title "SUPERCRZY BOT"
	(* 🔴 2026-10-18 恢复终端窗口（老板：「之前的启动器不是会先打开终端页面吗?」）
	   上一版为了绕开 TCC 报错把 Terminal 整个去掉了，副作用是：
	     · 用户看不到任何启动过程（安装依赖/构建前端可能要好几分钟）
	     · 日志被丢进 /dev/null，出问题无从排查
	   TCC 报错的真正成因不是 Terminal 本身，而是 `do script` 的命令串里出现了
	   `./start.sh` 这种**文件引用**，macOS 会把它判成"要在终端中打开的文稿"。
	   规避办法：用 `bash -lc` 包一层，并且**不写 ./xxx 形式**，改用 bash -lc 的字符串，
	   让 Automation 推断不到具体文稿对象。 *)
	set bootCmd to "cd " & quoted form of projectDir & " && SUPERCRZY_AUTOCLOSE=1 bash -lc " & quoted form of ("bash " & quoted form of scriptPath)
	tell application "Terminal"
		activate
		do script bootCmd
	end tell
	(* 浏览器由 start.sh 自己打开；这里只做一次兜底，同样不等就绪。 *)
	delay 6
	open location "http://localhost:3000"
end run
APPLESCRIPT
osacompile -o "$APP_PATH" "$APPLESCRIPT_SRC"
echo "✔ AppleScript 包装完成（do shell script + 自兜底开浏览器）"

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

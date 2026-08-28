#!/bin/bash
# ============================================================
# SUPERCRZY BOT 桌面 App 一键打包脚本（macOS）
# 固化所有已知打包坑：
#  1. 前端需先 pnpm build（dist 是静态产物，不 build 会打进旧版）
#  2. 后端部署目录必须用 npm 生成真实依赖（pnpm workspace 软链打包会断）
#  3. native 模块（better-sqlite3）必须 electron-rebuild 匹配 Electron ABI
#  4. 打包必须带 UPDATE_URL（electron-builder publish.url 用 ${env.UPDATE_URL}）
#  5. 主进程用 Electron 内置 Node 跑后端（GUI 双击 PATH 无 node，见 main.cjs）
# 用法: scripts/build-dmg.sh   （产物: packages/desktop/dist/*.dmg）
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NPM="${NPM:-/Users/chaojiphonekuang/.workbuddy/binaries/node/versions/22.22.2/bin/npm}"
REGISTRY="${REGISTRY:-https://registry.npmmirror.com}"
ELECTRON_VERSION="${ELECTRON_VERSION:-33.4.11}"
UPDATE_URL="${UPDATE_URL:-https://updates.supercrzy.com/releases}"

echo "═══ ① 构建前端 dist ═══"
cd "$ROOT"
pnpm --filter @supercrzy/client build

echo "═══ ② 重建后端部署目录（真实依赖 + Electron ABI）═══"
rm -rf packages/desktop/.deploy-server
mkdir -p packages/desktop/.deploy-server
cp -R packages/server/src packages/desktop/.deploy-server/src
cp packages/server/package.json packages/server/tsconfig.json packages/desktop/.deploy-server/ 2>/dev/null || true
cp -R packages/server/data packages/desktop/.deploy-server/data 2>/dev/null || true
cd packages/desktop/.deploy-server
"$NPM" install --omit=dev --no-audit --no-fund --registry="$REGISTRY"
"$NPM" install --no-save --no-audit --no-fund tsx --registry="$REGISTRY"
"$NPM" install --no-save --no-audit --no-fund @electron/rebuild --registry="$REGISTRY"
./node_modules/.bin/electron-rebuild -f -w better-sqlite3 -v "$ELECTRON_VERSION"

echo "═══ ③ 打包 dmg ═══"
cd "$ROOT/packages/desktop"
UPDATE_URL="$UPDATE_URL" pnpm dist

echo "═══ ④ 完成 ═══"
ls -lh "$ROOT/packages/desktop/dist/"SUPERCRZY*.dmg 2>/dev/null | awk '{print "  DMG:", $5, $9}'
echo "  安装: 打开 dmg 拖 SUPERCRZY BOT.app 到 Applications（首次右键→打开）"

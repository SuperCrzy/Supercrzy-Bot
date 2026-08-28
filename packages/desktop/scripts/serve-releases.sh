#!/usr/bin/env bash
# 本地发版源：把 electron-builder 产物复制到 releases/ 目录，并起本地静态服务器，
# 供 App（dev 形态读 dev-app-update.yml 指向 http://localhost:8080/releases）检测更新。
# 用法：bash scripts/serve-releases.sh   （先 pnpm desktop:dist 打包出新版）
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASES="$DIR/releases"
mkdir -p "$RELEASES"

# 复制最新打包产物：安装包 + 版本清单（latest*.yml 是 electron-updater 判断版本的关键）
# nullglob：避免不存在的模式（如 *.exe）导致 cp 整体失败
shopt -s nullglob
cp "$DIR"/dist/*.dmg "$DIR"/dist/*.zip "$DIR"/dist/*.exe "$DIR"/dist/*.AppImage "$DIR"/dist/*.yml "$RELEASES"/ 2>/dev/null || true
shopt -u nullglob

echo "=============================================="
echo "  Releases dir: $RELEASES"
echo "  当前发版源内容："
ls -lh "$RELEASES" | grep -E "\.(dmg|zip|exe|AppImage|yml)" || echo "  （暂无产物，请先执行 pnpm desktop:dist）"
echo "  App 将检测到此处最新版本（dev 形态 source = http://localhost:8080/releases）"
echo "  按 Ctrl+C 停止服务器"
echo "=============================================="

cd "$RELEASES" && python3 -m http.server 8080

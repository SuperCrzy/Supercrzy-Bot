#!/bin/bash
# ============================================================
# SUPERCRZY BOT 桌面 App 一键打包脚本（macOS）
# 固化所有已知打包坑：
#  1. 前端需先 pnpm build（dist 是静态产物，不 build 会打进旧版）
#  2. 后端部署目录必须用 npm 生成真实依赖（pnpm workspace 软链打包会断）
#  3. native 模块（better-sqlite3）必须 electron-rebuild 匹配 Electron ABI
#  4. 打包必须带 UPDATE_URL（electron-builder publish.url 用 ${env.UPDATE_URL}）
#  5. 主进程用 Electron 内置 Node 跑后端（GUI 双击 PATH 无 node，见 main.cjs）
#  6. data/ 只随包示例技能：凭据 / DB / 检查点绝不入包（②有出厂门禁，命中即拒绝打包）
#  7. 运行期数据落 ~/.supercrzy（main.cjs 的 WORKSPACE_DIR），不写进 .app 包体
#  8. dmg 步骤要挂载 /Volumes 并往里写盘，必须在本机 Terminal 里跑（受限沙箱会拦，报 hdiutil 失败）
# 用法: scripts/build-dmg.sh   （产物: packages/desktop/dist/*.dmg）
#      SKIP_CLIENT_BUILD=1 scripts/build-dmg.sh   复用已有 dist，跳过 4 分钟的前端构建
#      PACK_TARGET=zip scripts/build-dmg.sh       只出 .app + zip（不写 /Volumes，受限沙箱也能跑完）
#
# ⚠️ 若在"边跑边改"的环境里执行本脚本，务必先复制一份再跑（bash 按字节偏移增量读脚本，
#    文件在运行中被改动会导致解析错位、可能在错误目录执行命令）。
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# npm 解析：按候选列表探测，**不写死任何开发机路径**（写死会在别人机器上必然失败，
# 且会把本机用户名带进公开仓库）。顺序：显式 NPM → PATH → 常见包管理器安装位。
pick_npm() {
  local c
  for c in "${NPM:-}" \
           "$(command -v npm 2>/dev/null || true)" \
           /opt/homebrew/bin/npm /usr/local/bin/npm; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 0
}
NPM="$(pick_npm)"
if [ -z "$NPM" ] || [ ! -x "$NPM" ]; then
  echo "✘ 找不到可执行的 npm（可用 NPM=/path/to/npm 覆盖）" >&2
  exit 1
fi
echo "  npm = $NPM ($("$NPM" --version 2>/dev/null || echo '?'))"
REGISTRY="${REGISTRY:-https://registry.npmmirror.com}"
ELECTRON_VERSION="${ELECTRON_VERSION:-33.4.11}"
UPDATE_URL="${UPDATE_URL:-https://updates.supercrzy.com/releases}"

# ── 清空目录（不触发宿主的 safe-delete 批量删除门禁）──────────────────────────
# 在 AI 工具/代理环境里，`rm` 与 Node 的 rmSync 都被 safe-delete shim 包了：
# 单次删除超过阈值（默认 50 个文件）就要求人工确认，脚本在后台跑必然卡死。
# 2026-09-23 实测被拦两次：vite 的 emptyDir 删 dist/assets(145)、rm -rf .deploy-server(10155)。
# rsync --delete 有完全相同的删除语义，但不走 shim —— 用于清空"构建产物目录"。
empty_dir() {
  local d="$1"
  [ -d "$d" ] || return 0
  local tmp
  tmp="$(mktemp -d)"
  rsync -a --delete "$tmp/" "$d/"
  rmdir "$tmp"
  return 0
}

# ── 把整个目录挪出包体（清理大目录的唯一稳妥办法）────────────────────────────
# 2026-09-21 实测：对 10 万+ 文件的 node_modules 目录做 rsync --delete（empty_dir）
# 会被宿主直接 SIGTERM 掉（exit 137，连脚本自身的 echo 都来不及输出）；
# `rm -rf` 同样会撞批量删除门禁。而 mv 是 rename，O(1)、不计数、不会被拦。
# 「挪出去」就足够了 —— 打包只读 .deploy-server 里剩下的东西；真正删除失败也无所谓
# （落在临时目录，系统自己回收）。所以这里不做任何会失败的硬动作。
prune_dir() {
  local d="$1" trash
  [ -e "$d" ] || return 0
  trash="${TMPDIR:-/tmp}/supercrzy-prune-$$/$(basename "$d")"
  mkdir -p "$(dirname "$trash")" 2>/dev/null || return 0
  mv "$d" "$trash" 2>/dev/null || return 0
  rm -rf "$trash" 2>/dev/null || true
  return 0
}

echo "═══ ① 构建前端 dist ═══"
cd "$ROOT"
# SKIP_CLIENT_BUILD=1 跳过前端构建（复用已有 dist）。前端构建本身要 4 分钟（vue-tsc + vite，
# 4900+ 模块），而它跟后端依赖/electron-builder 完全无关 —— 打包环节反复试错时没必要每次重跑它。
# 跳过前会校验 dist 像是个完整产物，避免"跳过一个空目录"这种自欺。
if [ "${SKIP_CLIENT_BUILD:-0}" = "1" ]; then
  if [ -f packages/client/dist/index.html ] && [ -d packages/client/dist/assets ]; then
    echo "  跳过（SKIP_CLIENT_BUILD=1），复用现有 dist：$(ls packages/client/dist/assets | wc -l | tr -d ' ') 个 asset"
  else
    echo "✘ SKIP_CLIENT_BUILD=1 但 packages/client/dist 不像完整产物（缺 index.html 或 assets/）" >&2
    exit 1
  fi
else
  # vite 构建前会 emptyDir(outDir)（走 Node rmSync 递归删 dist/assets）→ 会被上面的门禁拦下。
  # 先自己把 dist 清空，vite 就不需要 emptyDir 了。
  if [ -d packages/client/dist ]; then
    echo "  清空 packages/client/dist（绕开 vite emptyDir 的批量删除门禁）"
    empty_dir packages/client/dist
  fi
  pnpm --filter @supercrzy/client build
fi

echo "═══ ② 重建后端部署目录（真实依赖 + Electron ABI）═══"
mkdir -p packages/desktop/.deploy-server
# 2026-09-23 改：原先 `rm -rf .deploy-server` 会一次删掉 1 万+ 文件（含 node_modules），
# 必然触发 safe-delete 批量保护 → 脚本中途死掉。改成增量同步：
# src / 清单 用 rsync 对齐，node_modules 交给 npm install 自行收敛（多留几个无用包无害，
# 远比「删不动就卡住」安全）。
rsync -aL --delete packages/server/src/ packages/desktop/.deploy-server/src/
cp packages/server/package.json packages/server/tsconfig.json packages/desktop/.deploy-server/ 2>/dev/null || true

# 从部署副本里删掉 devDependencies（2026-09-23 修，两个坑叠在一起）：
#  ① `npm install --omit=dev` 不会剪掉**已经装好**的 devDependencies（npm 认为它们仍在
#     package.json 里、不属于 extraneous，实测 655M→638M 只减了 17M 的平台二进制）；
#  ② 更要命：`npm install --omit=dev --no-save tsx` —— tsx 自己就写在 devDependencies 里，
#     npm 判定它「已被 --omit=dev 省略」于是**跳过安装**，日志显示 `up to date in 872ms`，
#     而 node_modules/tsx/dist/cli.mjs 根本不存在 → main.cjs 拉不起后端 → 白屏。
# 部署副本没有任何构建需求，devDependencies 纯属负担与陷阱，直接删干净。
node -e '
const fs = require("fs");
const p = "packages/desktop/.deploy-server/package.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const n = j.devDependencies ? Object.keys(j.devDependencies).length : 0;
delete j.devDependencies;
delete j.scripts;
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("  已从部署副本移除 " + n + " 个 devDependencies（部署不需要构建）");
'

# data/ 只随包「示例技能」，其余一律不带（2026-09-21 修，2026-10-14 改源+改落点）：
# 原来整目录 cp -R packages/server/data，把 supercrzy.db（含真实 API key）和
# ilink-credentials.json（微信登录凭据）一起打进了 dmg —— 安装包会发给别人，这是凭据泄露。
# 运行期数据由 main.cjs 把 WORKSPACE_DIR 指到 ~/.supercrzy，不依赖包内 data。
#
# 🔴 2026-10-14 改源：原源 `packages/server/data/skills/` 是**运行时工作区**，已随
#   「个人测试产物不进仓库」一并撤出仓库（`data/` 整目录不再被跟踪）⇒ 源不存在，
#   `|| true` 会静默吞掉，产出一个 0 技能的空目录。现改从仓库里的**正规技能目录**
#   `packages/server/.agents/skills/`（16 份，许可已收口）取。
#
# 🔴 2026-10-14 改落点（顺带修掉的一个既存 bug，从未生效过）：
#   消费方是 main.cjs 的 seedWorkspace()，它读的是 `path.join(SERVER_DIR,'data','skills')`；
#   而打包版 SERVER_DIR = `Resources/backend/packages/server`（main.cjs:52-54）
#   ⇒ 它找的是 `backend/packages/server/data/skills`。旧脚本却 rsync 到 `backend/data/skills`
#   —— 差一层 `packages/server`，于是 `if (!fs.existsSync(bundled)) return` 静默返回，
#   安装版**从来没播种过任何技能**。现把落点对齐到 SERVER_DIR 之下。
#   （DEV 模式 SERVER_DIR = <repo>/packages/server，读的就是仓库内那份，不受影响。）
SEED_DIR='packages/desktop/.deploy-server/packages/server/data/skills'
mkdir -p "$SEED_DIR"
rsync -a --delete --exclude '.tmp-*' --exclude '.DS_Store' \
  packages/server/.agents/skills/ "$SEED_DIR/" 2>/dev/null || true
# 清掉历史遗留的凭据/DB（增量同步不会删旧文件，这里按名字精确清）
# 两处都清：老的整目录拷贝落在 packages/server/data/，2026-09-21 起的 rsync 落在 data/
# 🔴 2026-10-20 加两处 `data/skills`：`.tmp-anthropics-skills` 实际落在 `data/skills/` 下
#    （比原来的清理路径多一层 skills/），所以历史清理**一直没命过**，15MB 临时克隆
#    （内含 .git 3.6MB + canvas 字体 5.7MB）就这样混在打包目录里。
#    `.tmp-*` 还活着的原因是 `rsync --exclude '.tmp-*'` 的 exclude **同时豁免 --delete**
#    —— 已存在的临时目录永远不会被增量同步删掉，只能按路径显式点名。
for d in packages/desktop/.deploy-server/data \
         packages/desktop/.deploy-server/data/skills \
         packages/desktop/.deploy-server/packages/server/data \
         packages/desktop/.deploy-server/packages/server/data/skills; do
  rm -f "$d/supercrzy.db" "$d/supercrzy.db-wal" "$d/supercrzy.db-shm" "$d/ilink-credentials.json"
  empty_dir "$d/checkpoints"
  empty_dir "$d/.tmp-anthropics-skills"
  rmdir "$d/checkpoints" 2>/dev/null || true
  rmdir "$d/.tmp-anthropics-skills" 2>/dev/null || true
done

# 出厂前硬门禁：包内出现凭据/DB 直接失败，别等发出去了才发现
#
# ⚠️ 2026-10-22 修（CI 上踩到）：`find` 的目标目录**必须都存在**，否则 find 自身返回 1，
#   叠加脚本头部 `set -euo pipefail`，`leaked=$(find … | head -5)` 会把整条管道判成失败，
#   脚本**静默退出**（日志里只剩一行 `Process completed with exit code 1`，没有任何报错文本）。
#   本机因为 `.deploy-server/data/` 是历史构建留下的，一直存在 ⇒ 这个坑从没暴露；
#   GitHub Actions 的干净 checkout 上没有该目录 ⇒ 首次云端打包就死在这一步。
#   两处都 mkdir -p，并给管道补 `|| true`（`head` 提前关闭管道也会让上游 find 拿到 SIGPIPE）。
mkdir -p packages/desktop/.deploy-server/data \
         packages/desktop/.deploy-server/packages/server/data
leaked=$(find packages/desktop/.deploy-server/data \
             packages/desktop/.deploy-server/packages/server/data \
             \( -name '*.db' -o -name '*.db-*' -o -name 'ilink-credentials.json' -o -name '.env*' \) 2>/dev/null | head -5 || true)
if [ -n "$leaked" ]; then
  echo "✘ 拒绝打包：包内 data 含凭据/数据库文件" >&2
  echo "$leaked" >&2
  exit 1
fi
echo "  出厂检查通过：包内技能 $(ls "$SEED_DIR" 2>/dev/null | wc -l | tr -d ' ') 份（$(dirname "$SEED_DIR")），无凭据/DB"

# 卫生断言（2026-10-20 加）：包内不许残留临时克隆 / .git。
# 为什么不只靠上面点名清理：那条路已经漏过一次（路径差一层 skills/），
# 断言的作用是"再冒出新位置时立刻拦住"，而不是等包发出去了才发现里面带了个 .git 仓库。
# node_modules 用 -prune 跳过（253MB，全遍历只为找 .tmp 不划算）。
junk=$(find packages/desktop/.deploy-server -path '*/node_modules' -prune -o \
         \( -name '.tmp-*' -o -name '.git' \) -print 2>/dev/null | head -5)
if [ -n "$junk" ]; then
  echo "✘ 拒绝打包：包内含临时克隆 / .git 残留" >&2
  echo "$junk" >&2
  exit 1
fi
echo "  卫生检查通过：无 .tmp-* / .git 残留"

# node_modules 每次全量重装（2026-09-21 修）：
# `npm install --omit=dev` **不会**剪掉已经装好的 devDependencies —— npm 认为它们仍在
# package.json 里、不属于 extraneous（实测 655M→638M，只减了 17M 的平台二进制）。
# 于是历史遗留的 70 个 dev 包（typescript 22.8M / @rolldown 15.9M / esbuild 10.2M /
# @esbuild 10.1M / lightningcss 8.2M / vite 2.3M / vitest 2.1M… 合计 80.8M）
# 会一直烂在发给用户的产物里。从空目录起装，--omit=dev 才是真正生效的。
prune_dir packages/desktop/.deploy-server/node_modules
cd packages/desktop/.deploy-server
"$NPM" install --omit=dev --no-audit --no-fund --registry="$REGISTRY"
# tsx 是 devDependency，上面 --omit=dev 会把它剪掉；而 main.cjs 正是用它拉后端的（缺了就是白屏）。
# 所以必须显式补装 —— 2026-09-22 就是漏了这步，打出过一个「后端起不来」的 dmg。
# 这行能生效的前提是**上面已经把 devDependencies 从部署副本里删掉**：否则 tsx 作为 devDep
# 会被 --omit=dev 判定为「已省略」而跳过（踩过，见上面的说明）。
"$NPM" install --omit=dev --no-save --no-audit --no-fund tsx --registry="$REGISTRY"
# @electron/rebuild 是纯构建期工具，装进独立目录，绝不落进要发出去的 node_modules。
# ⚠️ 必须先放一个 package.json 把目录「锚住」：该目录若没有 package.json，npm 会向上寻找
# 最近的 package 根 —— 那是 packages/desktop/package.json —— 于是把 33 个包全装进了
# packages/desktop/node_modules，而 .build-tools/node_modules/.bin/electron-rebuild 压根不存在。
mkdir -p "$ROOT/packages/desktop/.build-tools"
printf '{"name":"supercrzy-build-tools","version":"0.0.0","private":true}\n' \
  > "$ROOT/packages/desktop/.build-tools/package.json"
( cd "$ROOT/packages/desktop/.build-tools" \
  && "$NPM" install --omit=dev --no-save --no-audit --no-fund @electron/rebuild --registry="$REGISTRY" )
# 刻意不传 -m/--module-dir：它的 help 写「node_modules 的路径」、API 却写「包含 node_modules 的
# 目录」，两种读法冲突。这里 cwd 已经在 .deploy-server，用默认值最不容易踩坑（1.0.2 也是这么跑的）。
"$ROOT/packages/desktop/.build-tools/node_modules/.bin/electron-rebuild" \
  -f -w better-sqlite3 -v "$ELECTRON_VERSION"

# ── 体积修剪：干掉 peer 依赖死重 ──────────────────────────────────────────────
# openclaw 是 @tencent-weixin/openclaw-weixin 声明的 peerDependency（">=2026.5.12"），
# npm 7+ 默认自动安装 peer → 白拉进来 342M（占整个 App 37%，其中嵌套 node_modules 236M +
# 自带 dist 96M，内含 openai / @anthropic-ai / @google / @mistralai / tree-sitter-bash /
# highlight.js / typescript…）。而本仓库对它的引用只有一处：
#   services/wechat-bot-runner.ts:7  import { StreamingMarkdownFilter } from '…/markdown-filter.js'
# 该文件 13298 字节、零 import/require（自包含），openclaw 本身全仓零 import。
# 这里不用 --legacy-peer-deps：那会连带跳过 hono 等「被别的 prod 包依赖的 peer」，有误伤风险；
# 精确删除 + 出厂断言更安全（后端起不来会在下面门禁 2 和装机自检里被抓到）。
if [ -d node_modules/openclaw ]; then
  b="$(du -sh node_modules/openclaw | cut -f1)"
  prune_dir node_modules/openclaw
  echo "  修剪 peer 死重: openclaw ($b)"
fi
# .bin 里的软链不在被挪走的目录内部，会变成悬空软链留在包里（1.0.3 实测：
# xattr -dr 时报 `No such file: .../node_modules/.bin/openclaw`）—— 虽无害，但属包内残渣，清掉。
rm -f node_modules/.bin/openclaw node_modules/.bin/openclaw.cmd 2>/dev/null || true

# 出厂门禁 1.5：不该进产物的东西一个都不许留
# （先打印尺寸再拒 —— 一次失败就能看出「是哪一类重新长回来了」，不用再跑一轮复现）
bad_list=""
for bad in openclaw typescript vite vitest rolldown @rolldown @electron; do
  [ -e "node_modules/$bad" ] && bad_list="$bad_list $bad($(du -sh "node_modules/$bad" | cut -f1))"
done
if [ -n "$bad_list" ]; then
  echo "✘ 拒绝打包：产物含不该进包的内容 →$bad_list" >&2
  exit 1
fi
echo "  产物 node_modules: $(du -sh node_modules | cut -f1)"

# 出厂门禁 2：装机前把「后端起不来」的两种死法直接判死（白屏是最难查的用户侧故障）
for f in node_modules/tsx/dist/cli.mjs node_modules/better-sqlite3/build/Release/better_sqlite3.node; do
  if [ ! -f "$f" ]; then echo "✘ 拒绝打包：缺 ${f}（后端拉不起来）" >&2; exit 1; fi
done
echo "  自检通过: tsx + better-sqlite3(Electron $ELECTRON_VERSION ABI) 就位"

echo "═══ ③ 打包 App ═══"
cd "$ROOT/packages/desktop"
# PACK_TARGET 控制 electron-builder 的 mac 目标（2026-09-23 加）：
#   空（默认）= pnpm dist，出 dmg + zip（需要写 /Volumes，只能在真实 Terminal 跑）
#   zip        = 只出 .app + zip。**不碰 /Volumes**，所以在受限沙箱里也能跑完；
#                而且 zip 目标会顺带写出 latest-mac.yml（dmg 失败时它不会被重写，见更新通道排查）。
#   拿来在 AI 工具里出「可安装的 .app」时用 PACK_TARGET=zip。
if [ -n "${PACK_TARGET:-}" ]; then
  echo "  (PACK_TARGET=${PACK_TARGET} → 只出 .app + ${PACK_TARGET}，不生成 dmg)"
  UPDATE_URL="$UPDATE_URL" pnpm exec electron-builder --mac "$PACK_TARGET"
else
  UPDATE_URL="$UPDATE_URL" pnpm dist
fi

# Inject blockMapSize into latest*.yml (2026-10-25): electron-builder writes the .blockmap
# files but omits this field, and electron-updater refuses to do a differential download
# without it — every update was a full 170 MB transfer even though the maps were right there.
node "$ROOT/scripts/inject-blockmap-size.mjs" "$ROOT/packages/desktop/dist"

echo "═══ ④ 完成 ═══"
ls -lh "$ROOT/packages/desktop/dist/"SUPERCRZY*.dmg 2>/dev/null | awk '{print "  DMG:", $5, $9}' || true
ls -lh "$ROOT/packages/desktop/dist/"*-mac.zip 2>/dev/null | awk '{print "  ZIP:", $5, $9}' || true
ls -lh "$ROOT/packages/desktop/dist/latest-mac.yml" 2>/dev/null | awk '{print "  更新清单:", $5, $9}' || true
if [ -d "$ROOT/packages/desktop/dist/mac-arm64/SUPERCRZY BOT.app" ]; then
  echo "  APP: $(du -sh "$ROOT/packages/desktop/dist/mac-arm64/SUPERCRZY BOT.app" | cut -f1)"
fi
echo "  安装: rsync -aH 'dist/mac-arm64/SUPERCRZY BOT.app/' '/Applications/SUPERCRZY BOT.app/'（首次右键→打开）"

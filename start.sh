#!/usr/bin/env bash
# ============================================================
# SUPERCRZY BOT — 一键启动（生产模式）
# 自动检查环境 → 安装依赖 → 构建前端 → 启动 Web UI + API
# 单进程：http://localhost:3000 同时服务页面与 API，自动打开浏览器
# 用法: ./start.sh   （或双击 SUPERCRZY BOT.command）
# ============================================================
set -e
cd "$(dirname "$0")"
# 项目根（物理路径，用于判定端口占用者是否属于本仓库；/tmp vs /private/tmp 需 pwd -P 归一）
PROJECT_ROOT="$(pwd -P)"

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
  #    启动端口已固定 3000，但**保留 3001-3010 扫描**：用于清理旧版本遗留的漂移进程
  #    （2026-10-17 之前会自动换端口，可能残留 3001/3002…，它们和 3000 共写同一个 DB）
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

# 3. 安装依赖（首次 / 依赖真的变了 / 上次安装中断）
#
# 为什么不能只看 `[ -d node_modules ]`：安装中断、clone 后残留、手工删过部分包，
# 都会留下一个"存在但不完整"的 node_modules —— 目录在，实际什么都跑不起来。
#
# 为什么不用 `pnpm-lock.yaml -nt .modules.yaml` 判"依赖变没变"（2026-10-17 加固）：
#   时间戳会被 git checkout / 编辑器保存 / 手工 touch 无端刷新，lock 内容一个字没变
#   也会触发 1.6 GB 重装；反过来拷贝仓库时 mtime 被统一改写，真变了也检测不到。
#   改成**内容指纹**：装完把 lock 的 sha256 写进 .sc-install-state，
#   下次只比对指纹，一致就跳过 —— 指纹相同 = 依赖树相同，与时间无关。
#
# 判据（四条，命中任一即重装）：
#   ① node_modules 或 .modules.yaml 不存在（pnpm 写完这个才算装成功）
#   ② 关键包目录缺失（手工删过 / 磁盘写满）
#   ③ 没有指纹记录（老仓库升级上来）→ 补写，不重装
#   ④ lock 指纹与记录不一致（依赖清单内容真的变了）→ 重装
NEED_INSTALL=0
NEED_REASON=""
MODULES_MARK="node_modules/.modules.yaml"
LOCK_FILE="pnpm-lock.yaml"
STATE_FILE="node_modules/.sc-install-state"

# lock 指纹：优先 sha256（Linux sha256sum / mac shasum）；都没有则退回 cksum
lock_fingerprint() {
  if [ ! -f "$LOCK_FILE" ]; then echo "no-lock"; return; fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$LOCK_FILE" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$LOCK_FILE" | cut -d' ' -f1
  else
    cksum "$LOCK_FILE" | tr ' ' '-'
  fi
}

CURRENT_FP="$(lock_fingerprint)"

if [ ! -d node_modules ]; then
  info "首次运行，安装依赖（干净机器约 3-8 分钟）..."
  NEED_INSTALL=1; NEED_REASON="first-run"
elif [ ! -f "$MODULES_MARK" ]; then
  warn "node_modules 存在但没有 .modules.yaml（上次安装可能未完成），重新安装..."
  NEED_INSTALL=1; NEED_REASON="incomplete"
elif [ ! -d "packages/server/node_modules/tsx" ] || [ ! -d "packages/client/node_modules/vue" ]; then
  # 关键包缺失（手工删过 / 磁盘写满）—— 视为不完整
  warn "依赖目录缺少关键包（tsx / vue），重新安装..."
  NEED_INSTALL=1; NEED_REASON="missing-pkg"
elif [ ! -f "$STATE_FILE" ]; then
  # 老仓库升级上来：没有指纹记录，但 .modules.yaml 在 ⇒ 装过一次
  # 按"已装好"处理，直接补写指纹（不触发重装；lock 随仓库带来，与已装的一致）
  info "补写依赖指纹 ${CURRENT_FP:0:12}..."
  echo "$CURRENT_FP" > "$STATE_FILE" 2>/dev/null || true
elif [ "$(cat "$STATE_FILE" 2>/dev/null)" != "$CURRENT_FP" ]; then
  info "pnpm-lock.yaml 内容有变化（依赖清单变了），重新安装依赖..."
  NEED_INSTALL=1; NEED_REASON="lock-changed"
fi

if [ "$NEED_INSTALL" = "1" ]; then
  # 指纹**装成功之后**才落盘（先写 .tmp 再 mv）：中途失败绝不留下"指纹已更新"的假象，
  # 下次重跑仍会命中 ①/②/④ 继续重装，不会误判成"已就绪"。
  pnpm install || {
    rm -f "$STATE_FILE.tmp"
    fail "依赖安装失败（如果是网络问题，设好代理后重跑本脚本）"
  }
  echo "$CURRENT_FP" > "$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE"
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
# 用 nohup 后台起服务 + PID 文件管理：关终端窗不丢、重启不重复起。
#
# 端口固定 3000，**不再自动顺延**（2026-10-17 老板拍板「合并成一份服务」）：
#   旧逻辑 3000 被占就 +1 换到 3001/3002…，后果是三份隐性成本：
#     ① 端口漂移：书签/脚本/`supercrzy status` 对不上，以为"版本不一样"其实只是换了口；
#     ② 双服务并存：两个进程同时写同一个 SQLite（~/.supercrzy/data/supercrzy.db），
#        better-sqlite3 是同步写，多写者会抢锁，最坏情况 SQLITE_BUSY 丢写；
#     ③ 问题被掩盖：本该是"旧进程没停"，却表现成"看起来很正常的 3001"。
#   现在：3000 被占 ⇒ 直接失败退出，并打印占用 PID + 停止命令，逼着先清理再启动。
PID_FILE="${HOME}/.supercrzy/server.pid"
LOG_FILE="${HOME}/.supercrzy/server.log"
mkdir -p "${HOME}/.supercrzy"
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"

# 若已在运行 → 直接打开浏览器（不重复起服务）
#
# 🔴 判活两件事必须同时成立（2026-10-17 两次修正）：
#   ① 看**端口实际监听者**，不能只看 PID 文件：
#      PID 文件记的是 `pnpm --filter ... start` 的父 PID，真正 listen 的是它 fork 的 node 子进程。
#      父进程先死（终端关闭/SIGTERM）时子进程变孤儿仍占着 3000，kill -0 判父 PID 失败
#      → 旧逻辑删 PID 文件 → 撞"端口被占"拒绝启动，用户有服务在跑却被拒。
#   ② 该监听者必须**属于当前仓库**（cwd 在本项目内）：
#      一台机器上可能有多个副本（主目录 + 干净树/测试目录/另一个 clone）。
#      只看"3000 有人听"就复用，会让 B 副本认为"服务已在运行"其实是 A 副本在服务，
#      于是 B 永远起不来自己的服务 —— 用户看到的是别人的界面/别人的数据库。
# 结论：端口有人听 + 属于本仓库 ⇒ 复用；端口有人听但不属于本仓库 ⇒ 报冲突让用户处理。
PID_ALIVE_ELSEWHERE=0
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  LIVE_PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1 | awk '{print $2}')
  if [ -n "$LIVE_PID" ]; then
    # 取该进程的工作目录，判断是否落在本项目根内（macOS: lsof -a -p PID -d cwd）
    LIVE_CWD=$(lsof -a -p "$LIVE_PID" -d cwd -Fn 2>/dev/null | grep '^n' | head -1 | sed 's/^n//')
    case "$LIVE_CWD" in
      "$PROJECT_ROOT"|"$PROJECT_ROOT"/*)
        # 属于本仓库 ⇒ 真·已在运行，复用
        echo "$LIVE_PID" > "$PID_FILE" 2>/dev/null || true
        ok "服务已在运行 (PID ${LIVE_PID})，直接打开界面"
        open "$URL" 2>/dev/null || true
        exit 0
        ;;
      *)
        # 端口被**别的副本/别的程序**占着 ⇒ 不能当成自己的服务
        PID_ALIVE_ELSEWHERE=1
        OTHER_CWD="$LIVE_CWD"
        ;;
    esac
  fi
fi
# 端口无监听：清理陈旧 PID 记录
if [ "$PID_ALIVE_ELSEWHERE" = "0" ]; then rm -f "$PID_FILE"; fi

# 端口占用检查：被占就报错退出（不换端口）
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  OCCUPY_LINE=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1)
  OCCUPY_PID=$(echo "$OCCUPY_LINE" | awk '{print $2}')
  OCCUPY_CMD=$(echo "$OCCUPY_LINE" | awk '{print $1}')
  echo ""
  echo -e "${C_RED}✘${C_NC} 端口 ${PORT} 已被占用，拒绝启动（不再自动换端口，避免两份服务抢同一个数据库）"
  echo -e "${C_YELLOW}  占用进程：PID ${OCCUPY_PID}  (${OCCUPY_CMD})${C_NC}"
  if [ "$PID_ALIVE_ELSEWHERE" = "1" ] && [ -n "$OTHER_CWD" ]; then
    echo -e "${C_YELLOW}  该进程工作目录：${OTHER_CWD}${C_NC}"
    echo -e "${C_YELLOW}  ⇒ 是**另一个副本**在跑（不是当前目录：${PROJECT_ROOT}）${C_NC}"
  fi
  echo -e "${C_YELLOW}  处理方式：${C_NC}"
  echo -e "${C_YELLOW}    1) 若是本项目的旧服务 → bash start.sh stop${C_NC}"
  echo -e "${C_YELLOW}    2) 若不确定是什么 → lsof -nP -iTCP:${PORT} -sTCP:LISTEN${C_NC}"
  echo -e "${C_YELLOW}    3) 确认可杀 → kill ${OCCUPY_PID}${C_NC}"
  echo -e "${C_YELLOW}  换端口启动（不推荐，会与上面的服务共写数据库）：PORT=3001 ./start.sh${C_NC}"
  echo ""
  exit 1
fi

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


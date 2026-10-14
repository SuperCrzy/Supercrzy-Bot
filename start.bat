@echo off
chcp 65001 >nul
REM ============================================================
REM SUPERCRZY BOT - Windows 一键启动
REM 自动检查环境 -> 安装依赖 -> 生成 .env -> 构建前端 -> 启动
REM 双击运行即可, 浏览器会自动打开 http://localhost:3000
REM ============================================================
cd /d "%~dp0"

echo ==============================================
echo        SUPERCRZY BOT - 一键启动
echo ==============================================

REM 1. 检查 Node（engines 要求 >=22.18.0 <23，见 package.json / .nvmrc）
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js, 请先安装 Node 22.x
  echo 下载地址: https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo [错误] Node 版本过低 ^(node -v^), 需要 22.x
  pause
  exit /b 1
)
echo [OK] Node %NODE_MAJOR%

REM 2. 检查 pnpm
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [提示] 未找到 pnpm, 正在安装...
  call npm install -g pnpm
  if errorlevel 1 (
    echo [错误] pnpm 安装失败, 请手动执行: npm install -g pnpm
    pause
    exit /b 1
  )
)
echo [OK] pnpm 已就绪

REM 3. 安装依赖（首次）
if not exist node_modules (
  echo [提示] 首次运行, 安装依赖 ^(约 1-2 分钟^)...
  call pnpm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
) else (
  echo [OK] 依赖已就绪
)

REM 4. 生成 .env（不存在时）
if not exist .env (
  copy .env.example .env >nul
  echo [提示] 已生成 .env ^(默认配置^)
  echo         API Key 两种配置方式任选其一:
  echo         A. 编辑 .env 填入 OPENAI_KEY=sk-...
  echo         B. 启动后在 Web UI - 模型页配置 ^(推荐, 免重启^)
) else (
  echo [OK] .env 已存在
)

REM 5. 构建前端（仅当 dist 缺失）
if not exist packages\client\dist\index.html (
  echo [提示] 首次构建前端 ^(约 30 秒^)...
  call pnpm --filter @supercrzy/client build
  if errorlevel 1 (
    echo [错误] 前端构建失败
    pause
    exit /b 1
  )
) else (
  echo [OK] 前端构建产物已就绪
)

REM 6. 延迟 3 秒自动打开浏览器（等服务就绪）
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'"

echo [启动] 打开 http://localhost:3000 使用 Web UI, 按 Ctrl+C 停止
REM 单进程: 页面 + API 都由 3000 端口提供
call pnpm --filter @supercrzy/server start

pause

# 宣传片渲染（scripts/promo）

SUPERCRZY BOT 宣传视频的生产工具。**产品视频可直接重出，不需要 ffmpeg。**

## 为什么不用 ffmpeg

本机（macOS arm64）实测：
- `packages/server/bin/ffmpeg` 是 x86_64 二进制 → `bad CPU type`（且未装 Rosetta）
- `ffmpeg-static`（npm）给的 arm64 二进制未签名 → macOS `SIGKILL`

改用 **Chrome WebCodecs 硬编码 + mp4-muxer**，零原生二进制，900 帧仅 13 秒。

## 组成

| 文件 | 作用 |
|---|---|
| `stage.html` | 舞台 + 分镜 + 逐帧渲染 + 编码。**改文案/时长只改这里的 `SCENES`** |
| `shoot-ui.mjs` | 用 Playwright 截真机 UI（1920×1080 @2x） |
| `render.mjs` | 驱动：`preview`（抽帧预览）/ `measure`（亮度量化）/ `encode`（出片） |

## 用法

```bash
NODE=node

# 1. 后端需常驻（用 run_in_background，nohup 会被回收）
cd packages/server && node node_modules/tsx/dist/cli.mjs src/app.ts

# 2. 截真机 UI
$NODE scripts/promo/shoot-ui.mjs

# 3. 先预览确认画面，再出片
$NODE scripts/promo/render.mjs preview
$NODE scripts/promo/render.mjs measure     # 网格亮度校验，防止遮罩把产品界面压灰
$NODE scripts/promo/render.mjs encode
```

产物：`SUPERCRZY_BOT_PROMO_30s_1080p.mp4`（30s / 1920×1080 / 30fps / 900 帧）。
`.gitignore` 已忽略 `*.mp4`，仓库只留源码。

## 分镜（当前版本）

开场 4s → 多轮推理·工具执行 5s → 8 个渠道 5s → 长期记忆 4.5s → 技能与自动化 4s → 200+ 模型 3.5s → 收尾 4s = 30s

## 注意

- 换行逻辑按「Latin 词 / 空白 / 单个 CJK 字」切 token，**不会把 Discord 断成 Discor/d**
- 帧驱动用 `window.__drawAt(t)` 传虚拟时间，**不用 requestAnimationFrame** → 可只渲染单帧、可重跑
- 输出走页面内 Blob + `<a download>`，避免几十 MB base64 穿过 CDP
- **无音轨**（配乐/旁白尚未做）
- 详细踩坑记录见技能 `supercrzy-promo-video`

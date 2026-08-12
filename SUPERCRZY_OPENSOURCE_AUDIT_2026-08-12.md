# SUPERCRZY BOT · 开源前安全检查报告

**日期**: 2026-08-12 · **范围**: 全仓库敏感信息 + git 历史 + 泄露面

## 结论

**可以进入开源流程**——敏感凭据已清零,历史已重写,新用户 clone 后是干净产品,零残留。

---

## 一、已清除的问题(本次处理)

| # | 问题 | 处理 |
|---|------|------|
| 1 | **测试文件含真实 DeepSeek API key**(`sk-ee13ba...4c2e`,老板真实 key) | 全部替换为假 key `sk-test-0123...`(当前代码 + 断言格式同步) |
| 2 | **真实 key 已进入 git 历史**(批次 F 起 10+ 个 commit) | `filter-branch` 重写全部历史,三种模式复扫全 0 |
| 3 | **masked 片段泄露**(`sk-ee13b...4c2e` / `sk-e...4c2e`,前后缀组合) | 历史两轮替换清零 |
| 4 | **articles/ 旧业务数据**(5 月文章 + CMS payload,含旧品牌引用) | 停止跟踪 + gitignore(本地保留),clone 后不存在 |
| 5 | **.git-rewrite/ 误提交**(filter 操作残留) | 移除跟踪 + gitignore |
| 6 | .env.example 旧品牌文案 | 更新为 SUPERCRZY BOT |

**验证**: 全历史 3 模式敏感扫描 = 0;`git log` 单链 25 个 commit 无重复;测试 37/37 通过;工作区干净。

## 二、原本已防护(无需处理)

- **.gitignore 完备**: `.env` / `.env.production` / `*.db*` / `data/` / `uploads/` / `参考手册` / 日志 / 编译产物 / `.workbuddy` 全部忽略
- **代码零硬编码凭据**: QQ AppID/AppSecret、DeepSeek key 均从 settings 表/环境变量读取
- **参考手册(含 VPS root 密码/SSH)从未入库**(已在 .gitignore,历史也不存在)
- **最早的 Initial commit 干净**(无 .env 值、无 key、无密码)
- **README / .env.example 只有模板占位,无真实值**

## 三、本地运行数据(不进 git,开源无影响)

`.env`(真实 key)、`data/supercrzy.db`(含 QQ 凭据)、`data/checkpoints/`、`uploads/`、AI 记忆(含旧 QQ AppSecret)—— 均为本地运行产物,gitignore 已挡,clone 后不存在。

## 四、开源前仍需完成的代码层安全项(批次 G 剩余)

| # | 事项 | 风险 |
|---|------|------|
| G-2 | `/api/preview/` 任意文件读取 | 高 — 路径拼接无白名单 |
| G-3 | `shell_exec` 裸执行无白名单 | 高 — 敏感工具"先执行后确认" |
| G-4 | CORS 全开 + API 无鉴权 | 中 — 需白名单/令牌 |
| G-5 | xlsx@0.18.5 已知 CVE | 中 — 换库或移除 |
| G-6 | Socket.IO/WS 死代码清理 | 低 — 维护面 |
| G-7 | 文档过时、0 字节残留 | 低 |

## 五、开源操作指引(待用户执行)

1. 建新仓库(建议 `SuperCrzy/supercrzy-agent`,废弃旧的 `deepseek-agent`)
2. `git push -u origin main --force`(历史已重写,必须 force)
3. 补 LICENSE / 贡献指南 / 示例配置
4. 完成 G-2~G-5 后即可公开

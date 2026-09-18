---
name: code-audit
description: 代码审计固定流程，检索并定位问题清单
---
# code-audit

任务：请完整审计目录 /Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/src/routes 下的代码，找出确定存在的 BUG / 安全问题 /

## 执行步骤
1. 创建审计计划并确定目标目录
2. 使用grep/cat/ls/find检索文件与模式
3. 关键文件逐行分析确认问题
4. 汇总输出带文件:行号的问题清单

## 常见坑
- 本技能由任务自动提炼生成（16 轮 / 4 种工具），首次使用时如发现不足，任务失败会自动修补。

---
name: code-health-check
description: 对项目进行代码健康检查并生成报告
---
# code-health-check

对当前项目做代码体检，扫描硬编码密钥、查找重复代码、列出最大文件，并汇总生成体检报告。

## 步骤

1. 扫描项目中的硬编码密钥
   - 使用 `grep` 或 `ripgrep` 递归搜索常见密钥模式（如 `API_KEY`、`SECRET`、`PASSWORD`、`PRIVATE KEY` 等）。
   - 注意排除 `node_modules`、`.git`、`dist`、`build` 等目录，避免误报和性能问题。
   - 如果使用 `grep`，推荐写法：`grep -rn --exclude-dir={node_modules,.git,dist,build} -E "(API_KEY|SECRET|PASSWORD|PRIVATE KEY)" .`

2. 查找重复代码
   - 使用 `jscpd` 或 `simian` 等工具检测重复代码块。
   - 若未安装工具，可结合 `md5sum` 或 `git log` 辅助定位明显重复片段。
   - 记录重复文件路径、重复行数和相似度。

3. 找出体积最大的文件
   - 使用 `find` 结合 `sort` 列出项目内体积最大的文件：`find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -exec ls -l {} + | sort -k5 -nr | head -20`
   - 记录文件路径、大小和类型。

4. 汇总结果并生成体检报告
   - 将上述扫描结果整理为 Markdown 报告，包含风险等级、问题描述、文件位置、改进建议。
   - 输出报告到 `code-health-report.md`。

## 常见坑

- `grep -r` 在包含大量二进制文件或超大目录时可能报错（如参数过长、二进制文件匹配异常）。建议添加 `-I` 忽略二进制文件，并限制搜索路径。
- 不要直接对根目录执行无排除的 `grep`，极易命中依赖目录或隐藏目录，导致输出混乱甚至命令失败。
- `grep` 遇到权限不足的目录会输出错误并返回非零退出码。使用 `2>/dev/null` 过滤错误信息，或改用 `rg`（ripgrep）自动跳过忽略文件与隐藏目录。
- 若项目文件路径含特殊字符或空格，务必对路径加引号，避免 shell 解析异常。
- 体积排序时注意 `ls -l` 的输出单位可能不同，建议使用 `find -printf '%s %p\n'` 获得字节数，再排序。
- 查找重复代码时，纯文本比较会忽略语义，可能产生大量误报，建议定期用专用工具并设置合理阈值。

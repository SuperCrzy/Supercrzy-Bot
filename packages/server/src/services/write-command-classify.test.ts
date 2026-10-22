/**
 * 「写文件类命令」分类测试（2026-10-22）
 *
 * 起因（老板实测）：`file_write` 改一个文件要弹一次框，而 `echo x > src/a.ts`、
 * `sed -i`、`tee out.log` 这类**同样是改文件**的命令一路静默执行。
 * 根因：`classifyShellCommand` 在 2026-10-18 把"未知命令"一律判 allow，
 * 而写文件命令恰好全是"未知" ⇒ 分类器看不见它们（风险等级也因此算错）。
 *
 * 对标 WorkBuddy 的 `inferStaticFileSafetyOperation`（cli.mjs@4884179 反查原文），它把命令分成
 * delete / **write** / read / access 四类。本测试钉住我们补的 write 类。
 *
 * ⚠️ 分类 ≠ 弹窗（2026-10-22 第二次裁决）。`ask` 现在的含义是"有副作用"，
 *    用于风险等级与审计；是否打断用户由 `decideToolApproval` 决定（阈值 = block）。
 */
import { describe, it, expect } from 'vitest'
import { classifySensitiveTool } from './tools'
import { decideToolApproval } from './permission'

const shell = (cmd: string) => classifySensitiveTool('shell_exec', JSON.stringify({ command: cmd }))

describe('写文件内容的命令 → ask（不再静默放行）', () => {
  const shouldAsk = [
    'echo x > src/a.ts',                    // 重定向到项目文件
    'echo x >> README.md',                  // 追加
    'pnpm test > out.log',                  // 相对路径日志（也是项目里的文件）
    'echo hi > "my file.txt"',              // 引号包裹的目标
    "sed -i '' 's/a/b/' f.ts",              // 原地改（macOS 写法）
    "sed -i.bak 's/a/b/' f.ts",             // 带备份后缀
    'tee out.log',                          // 管道后半段的显式写入
    'cat f.txt | tee -a log.txt',
    'install -m 755 bin/app ./app',         // 头锚定的写命令（目标在项目内）
    'cat > src/gen.ts <<\'EOF\'\ncode\nEOF', // heredoc 落盘
    'cd packages/client && pnpm build > dist/index.html',
  ]
  it.each(shouldAsk)('%s → ask', (cmd) => {
    expect(shell(cmd)).toBe('ask')
  })
})

describe('日志/临时文件重定向 → 仍放行（弹框收敛护栏）', () => {
  const shouldAllow = [
    'pnpm test > /tmp/sc.log 2>&1',
    'npm run build > /dev/null 2>&1',
    'node scripts/x.mjs 2>/dev/null',
    'pnpm build 2>&1 | tail -20',
    'tee /tmp/x.log',
    'pnpm install',                         // `install` 是参数不是命令头
    'npm install --save lodash',
    'mkdir -p build',                       // 结构性操作不纳入（否则构建链路天天弹）
    'cp a.ts b.ts',
    'mv a.ts b.ts',
    'cat a.ts',
    'git status',
  ]
  it.each(shouldAllow)('%s → allow', (cmd) => {
    expect(shell(cmd)).toBe('allow')
  })
})

describe('引号 / heredoc 里的 `>` 不算写文件（误报防护）', () => {
  const shouldAllow = [
    'grep ">" src/a.ts',
    'python3 -c "if a > b: print(1)"',
    "node -e 'x=>y'",
    'python3 - <<\'EOF\'\nx = 1\ny = x > 2\nprint(y)\nEOF',
    'awk \'{ if ($1 > $2) print }\' f.txt',
  ]
  it.each(shouldAllow)('%s → allow', (cmd) => {
    expect(shell(cmd)).toBe('allow')
  })

  it('没被引号包住的 `>` 依然要问（别为了防误报把闸门关掉）', () => {
    expect(shell('echo hi > src/a.ts')).toBe('ask')
    expect(shell('cat > src/a.ts <<\'EOF\'\nbody\nEOF')).toBe('ask')
  })
})

describe('危险写目标仍然优先 block（write 判定不许降级其他规则）', () => {
  it('.env / 凭据 / 磁盘 → block，而不是 ask', () => {
    expect(shell('echo KEY=1 > .env')).toBe('block')
    expect(shell('echo x > ~/.ssh/id_rsa')).toBe('block')
    expect(shell('echo x > /dev/sda')).toBe('block')
  })
  it('删除语义不被写判定覆盖', () => {
    expect(shell('rm -rf dist')).toBe('block')
    expect(shell('rm a.ts')).toBe('allow') // 非递归 + 相对路径 = 既有语义，不能因本次改动变化
  })
  it('提权写系统路径 → block（系统路径写入与 file_write 同级，2026-10-22 补）', () => {
    expect(shell('sudo tee /etc/hosts')).toBe('block')
    expect(shell('install -m 755 bin/app /usr/local/bin/app')).toBe('block')
  })
})

describe('端到端：写文件命令的分类 vs 闸门（2026-10-22 两次裁决叠加后的现状）', () => {
  // 分类器判 ask 的语义是「有副作用」，不是「要弹窗」。弹窗阈值由 decideToolApproval 决定，
  // 老板 2026-10-22 第二次裁决把它抬到了 block（对齐 WorkBuddy：只有删除类才弹）。
  // ⇒ 这里要同时钉住两件事：分类仍是 ask（风险等级=中、可审计），但**不打断**。
  const ctx = {
    mode: 'prompt' as const,
    sessionApproved: false,
    classify: (n: string, a: string) => classifySensitiveTool(n, a),
  }
  it('写文件命令 → 分类 ask，但闸门放行（不再逐个弹）', () => {
    expect(shell('echo x > src/a.ts')).toBe('ask')
    expect(decideToolApproval('shell_exec', JSON.stringify({ command: 'echo x > src/a.ts' }), ctx)).toBe('allow')
    expect(decideToolApproval('shell_exec', JSON.stringify({ command: "sed -i '' s/a/b/ f.ts" }), ctx)).toBe('allow')
  })
  it('不可逆的写目标仍打断（block 才弹）', () => {
    expect(shell('echo KEY=1 > .env')).toBe('block')
    expect(decideToolApproval('shell_exec', JSON.stringify({ command: 'echo KEY=1 > .env' }), ctx)).toBe('confirm')
  })
  it('只读/测试类命令 → allow，不弹', () => {
    expect(decideToolApproval('shell_exec', JSON.stringify({ command: 'pnpm test > /tmp/x.log 2>&1' }), ctx)).toBe('allow')
    expect(decideToolApproval('shell_exec', JSON.stringify({ command: 'ls -la' }), ctx)).toBe('allow')
  })
})

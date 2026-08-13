/**
 * Agent Shell 沙箱 — 三层防御
 *
 * 目标：agent 的 shell_exec 即使被 prompt 注入诱导执行危险命令，也无法越权访问宿主敏感数据。
 *
 * 三层：
 *   L1 命令黑名单（tools.ts 已有）：极端危险命令（删根/sudo/fork 炸弹/下载即执行）
 *   L2 软沙箱 scanDangerousPath（本模块）：命令级危险路径扫描，纯 Node 实现，任何环境可用
 *   L3 硬沙箱 sandbox-exec（本模块）：macOS 原生内核级隔离（等价 Linux Landlock），
 *      仅放行项目仓库 + 运行时只读 + 临时目录；探测不可用（如 CI/嵌套沙箱）时自动降级 L2，不阻塞功能
 *
 * 边界语义：
 *   - 放行：项目仓库根（agent 的"工作区"）+ workspaceDir + ~/.workbuddy/{binaries,skills} 只读 + ~/.local/bin 只读 + /tmp
 *   - 禁止：home 下其余一切（.ssh/.aws/.env/凭据）、系统敏感文件、仓库内凭据文件（.env/.npmrc/id_rsa 等）
 *
 * 参考：deepseek-harness 的 Landlock 沙箱思路（Linux LSM），macOS 对应实现为 sandbox-exec (SBPL)。
 */
import { exec } from 'child_process'
import { writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { config } from '../config'

// 工作区根：与 app.ts / workspace.ts 保持一致
export const WORKSPACE_ROOT = resolve(config.workspaceDir || process.cwd())

/** 项目仓库根：从 workspaceDir 上溯，找到含 pnpm-workspace.yaml 的目录（即 agent 的工作区边界） */
function findProjectRoot(start: string): string {
  let dir = resolve(start)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}
export const PROJECT_ROOT = findProjectRoot(WORKSPACE_ROOT)

const HOME = process.env.HOME || ''

/** 放行的前缀集合（软沙箱用）：项目仓库 + workspaceDir + 运行时只读 + 临时目录 */
function allowedPrefixes(): string[] {
  const list = [PROJECT_ROOT, WORKSPACE_ROOT, '/tmp', '/private/tmp']
  if (HOME) {
    list.push(
      join(HOME, '.workbuddy', 'binaries'),
      join(HOME, '.workbuddy', 'skills'),
      join(HOME, '.local', 'bin'),
    )
  }
  return list.map((p) => resolve(p))
}

// ============================
// L3: sandbox-exec 硬沙箱
// ============================

/** 探测 sandbox-exec 是否真实可用（最小 profile 实测，非仅检查文件存在），结果缓存 */
let sandboxDetected: boolean | null = null
export function detectSandboxExec(): Promise<boolean> {
  if (sandboxDetected !== null) return Promise.resolve(sandboxDetected)
  return new Promise((resolveFn) => {
    try {
      exec(`sandbox-exec -p '(version 1) (allow default)' /bin/echo ok`, { timeout: 3000 }, (err) => {
        sandboxDetected = !err
        resolveFn(!err)
      })
    } catch {
      sandboxDetected = false
      resolveFn(false)
    }
  })
}

/** 仓库内需禁止读取的凭据文件（SBPL literal 兜底；其余 .env 类由软沙箱 + home deny 覆盖） */
function credentialLiterals(): string[] {
  const names = ['.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.netrc']
  const dirs = [PROJECT_ROOT, WORKSPACE_ROOT]
  const list: string[] = []
  for (const dir of dirs) {
    for (const n of names) {
      if (dir !== PROJECT_ROOT && dir !== WORKSPACE_ROOT) continue
      list.push(join(dir, n))
    }
  }
  return [...new Set(list)]
}

/** 生成 SBPL 沙箱 profile：deny home 全部 → allow 项目仓库/运行时/临时目录 子路径（SBPL 中子路径 allow 覆盖父路径 deny） */
export function buildSandboxProfile(): string {
  const esc = (s: string) => s.replace(/"/g, '\\"')
  const lines = [
    '(version 1)',
    '(allow default)',
    // 拒绝 home 下一切读写（敏感：.ssh/.aws/.env/mcp.json 等全被覆盖）
    ...(HOME ? [`(deny file-read* (subpath "${esc(HOME)}"))`, `(deny file-write* (subpath "${esc(HOME)}"))`] : []),
    // 放行：项目仓库（读+写）与 workspaceDir（读+写）
    `(allow file-read* (subpath "${esc(PROJECT_ROOT)}"))`,
    `(allow file-write* (subpath "${esc(PROJECT_ROOT)}"))`,
    `(allow file-read* (subpath "${esc(WORKSPACE_ROOT)}"))`,
    `(allow file-write* (subpath "${esc(WORKSPACE_ROOT)}"))`,
    // 放行：运行时只读（node/python/pnpm 等，位于 home 下，需在 deny 后显式放行）
    ...(HOME ? [
      `(allow file-read* (subpath "${esc(join(HOME, '.workbuddy', 'binaries'))}"))`,
      `(allow file-read* (subpath "${esc(join(HOME, '.workbuddy', 'skills'))}"))`,
      `(allow file-read* (subpath "${esc(join(HOME, '.local', 'bin'))}"))`,
    ] : []),
    // 临时目录读写（/tmp 与 /private/tmp 同源）
    `(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))`,
    `(allow file-read* (subpath "/tmp") (subpath "/private/tmp"))`,
    // 系统目录只读（命令执行必需）
    `(allow file-read* (subpath "/etc") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private"))`,
    // 仓库内凭据文件禁止读取（literal 兜底，deny 优先于 allow）
    ...credentialLiterals().map((p) => `(deny file-read* (literal "${esc(p)}"))`),
    // 进程/系统信息/网络（shell 常规操作；文件系统才是最大风险面）
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow network*)',
  ]
  return lines.join('\n')
}

/** 写 profile 到临时目录（每次执行前重写，避免 stale） */
function writeProfile(): string {
  const profilePath = join(tmpdir(), `supercrzy-sb-${process.pid}.sb`)
  writeFileSync(profilePath, buildSandboxProfile(), 'utf-8')
  return profilePath
}

export interface SandboxifyResult {
  /** sandbox 可用时的可执行文件名（'sandbox-exec'），不可用时为原命令 */
  exec: string
  /** sandbox 可用时的参数数组，不可用为 null */
  args: string[] | null
  sandboxed: boolean
  reason?: string
}

/**
 * 把 shell 命令包装进沙箱。
 * 返回 { exec:'sandbox-exec', args:['-f',profile,'/bin/sh','-c',cmd] } 或降级 { exec:cmd, args:null }
 */
export async function sandboxify(command: string): Promise<SandboxifyResult> {
  const ok = await detectSandboxExec()
  if (!ok) {
    return { exec: command, args: null, sandboxed: false, reason: 'sandbox-exec 不可用，已降级软沙箱' }
  }
  const profilePath = writeProfile()
  return { exec: 'sandbox-exec', args: ['-f', profilePath, '/bin/sh', '-c', command], sandboxed: true }
}

// ============================
// L2: 软沙箱 — 命令级危险路径扫描（纯 Node，任何环境生效）
// ============================

/** ~ 直接引用敏感配置目录 */
const TILDE_SENSITIVE = /~\/(\.ssh|\.aws|\.gnupg|\.netrc|\.kube|\.docker|\.config)(\/|\s|'|"|;|&|\||$)/

/** 系统敏感文件 */
const SYSTEM_SENSITIVE = /\/(?:private\/)?etc\/(?:shadow|sudoers|master\.passwd|security|krb5\.keytab)(\s|'|"|;|&|\||$)/

/** 凭据文件名（任意路径位置出现即拦：.env/.npmrc/id_rsa 等） */
const CREDENTIAL_FILE =
  /(?:^|[\s'";&|(])(?:[^\s'";&|()]*\/)?(\.env(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_rsa|id_ed25519|id_dsa)(?=[\s'";&|)]|$)/

/**
 * 扫描命令中的危险路径引用，返回拦截原因；无风险返回 null。
 * 规则：
 *   1. ~ 直接引用敏感配置目录（.ssh/.aws/.env 等）
 *   2. 引用系统敏感文件（/etc/shadow 等）
 *   3. 引用凭据文件（.env/.npmrc/id_rsa 等，任意位置）
 *   4. 绝对路径指向 home 下非白名单区域（项目仓库/运行时/临时目录之外）
 */
export function scanDangerousPath(command: string): string | null {
  if (!command) return null

  // 1. ~ 敏感目录
  const t = TILDE_SENSITIVE.exec(command)
  if (t) return `引用敏感目录 ~/${t[1]}`

  // 2. 系统敏感文件
  const s = SYSTEM_SENSITIVE.exec(command)
  if (s) return `引用系统敏感文件 /etc/${s[1]}`

  // 3. 凭据文件（覆盖 ~/.env、$HOME/.env、仓库内 .env、任意路径）
  const c = CREDENTIAL_FILE.exec(command)
  if (c) return `引用凭据文件 ${c[1]}`

  // 4. home 下绝对路径越权（含 ~/ 与 $HOME/ 展开形式）
  if (HOME) {
    const homeEsc = HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:${homeEsc}|~|\\$HOME)/[^\\s'"\`;&|<>()]*`, 'g')
    const allowed = allowedPrefixes()
    for (const m of command.matchAll(re)) {
      const raw = m[0]
      // 展开 ~ 与 $HOME
      const p = resolve(raw.startsWith('~/') ? join(HOME, raw.slice(2)) : raw.startsWith('$HOME/') ? join(HOME, raw.slice(6)) : raw)
      if (allowed.some((a) => p === a || p.startsWith(a + '/'))) continue
      return `路径越权: ${raw.slice(0, 80)}`
    }
  }

  return null
}

// ============================
// 文件工具白名单（file_read / file_write / file_exists 共用）
// ============================

/** 路径是否位于白名单内（项目仓库 / workspaceDir / 运行时 / 临时目录） */
export function isPathAllowed(p: string): boolean {
  if (!p) return false
  const resolved = resolve(p)
  return allowedPrefixes().some((a) => resolved === a || resolved.startsWith(a + '/'))
}

/**
 * 文件工具路径校验：返回错误原因，安全返回 null。
 * 规则：①凭据文件名一律禁止 ②必须位于项目仓库/工作区内（防越权读 ~/.ssh、~/Documents 等）
 */
export function assertSafeFilePath(p: string): string | null {
  if (!p) return '路径为空'
  if (CREDENTIAL_FILE.test(p)) return `凭据文件不可访问: ${p.slice(0, 80)}`
  if (!isPathAllowed(p)) return `路径越权（仅允许项目仓库内）: ${p.slice(0, 80)}`
  return null
}

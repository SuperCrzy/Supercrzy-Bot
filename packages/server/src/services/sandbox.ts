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
 *   - 放行：项目仓库根（agent 的"工作区"）+ workspaceDir + ~/.local/bin 只读 + /tmp
 *   - 禁止：home 下其余一切（.ssh/.aws/.env/凭据）、系统敏感文件、仓库内凭据文件（.env/.npmrc/id_rsa 等）
 *
 * 参考：deepseek-harness 的 Landlock 沙箱思路（Linux LSM），macOS 对应实现为 sandbox-exec (SBPL)。
 */
import { exec } from 'child_process'
import { writeFileSync, existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
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

/**
 * 用户主目录。
 *
 * 🔴 2026-10-26：原来只读 `process.env.HOME`，而 **Windows 上通常没有 HOME**
 * （只有 USERPROFILE/USERPROFILE 派生）⇒ HOME 为空 ⇒ `full` 档的额外放行整段跳过，
 * 于是"完全访问"在 Windows 上等于最窄档。`os.homedir()` 在三个平台都正确。
 */
const HOME = (() => {
  try {
    const h = homedir()
    if (h) return h
  } catch { /* 极端环境拿不到 */ }
  return process.env.HOME || process.env.USERPROFILE || ''
})()

/** 放行的前缀集合（软沙箱用）：项目仓库 + workspaceDir + 运行时只读 + 临时目录 */
function allowedPrefixes(level: PermissionLevel = 'sandbox', workspaceDir?: string): string[] {
  const list: string[] = ['/tmp', '/private/tmp']
  // Windows 没有 /tmp：临时目录在 %TEMP%（如 C:\Users\x\AppData\Local\Temp）。
  // 缺这一条时"写临时文件"在 Windows 上必失败，而它在 Unix 上是放行的。
  if (process.env.TEMP) list.push(process.env.TEMP)
  if (process.env.TMPDIR) list.push(process.env.TMPDIR)

  if (level === 'workspace-only') {
    // 最窄档：只放行会话工作目录 + 临时目录；未设工作目录时退化为 sandbox
    const ws = workspaceDir ? resolve(workspaceDir) : ''
    if (ws) {
      list.unshift(ws)
      return list
    }
    list.unshift(PROJECT_ROOT, WORKSPACE_ROOT)
    return list
  }

  // sandbox / full 基础前缀
  list.unshift(PROJECT_ROOT, WORKSPACE_ROOT)
  if (HOME) {
    list.push(
      join(HOME, '.local', 'bin'),
    )
  }
  if (workspaceDir) list.push(resolve(workspaceDir))

  if (level === 'full' && HOME) {
    // 完全访问：用户主目录下的常见内容目录 + 应用自己的运行期数据目录。
    //
    // 🔴 2026-10-26 补 `.supercrzy`：任务日志写在 `~/.supercrzy/logs`（见 memory 约定），
    // 报告/会话数据也在这一层。旧列表只有 Documents/Downloads/... 这类"用户文档"目录，
    // 于是 full 档下 agent **读不回自己刚写的东西** —— Windows 实机报的正是这个现象
    // （`.supercrzy 下自己刚写的报告` 被拒）。
    //
    // 敏感点目录（.ssh/.aws/.config/.git…）不在这里排除，由 SENSITIVE_DIR 单独拦，
    // 顺序是"先拦敏感、再看白名单"（见 assertSafeFilePath）。
    for (const d of [
      'Documents', 'Downloads', 'Desktop', 'Pictures', 'Music', 'Movies',
      'Projects', 'Work', 'dev', 'code',
      'logs', '.supercrzy',
    ]) {
      list.push(join(HOME, d))
    }
  }

  return list.map((p) => resolve(p))
}

// ============================
// L3: sandbox-exec 硬沙箱
// ============================

/**
 * 探测 sandbox-exec 是否**真能应用收紧策略**，结果缓存。
 *
 * ⚠️ 2026-10-22 修：旧探针用 `(version 1) (allow default)` —— 那等于"什么都不收紧"，
 * 在被更外层沙箱包住的进程树里（嵌套沙箱）**照样能跑通**，于是探测通过、真实执行时
 * `sandbox_apply: Operation not permitted` 退出 71 ⇒ 每条 shell 命令直接失败。
 * 实测对照（macOS，宿主沙箱内）：
 *   ① `(allow default)` → exit 0
 *   ② `(allow default) (deny file-read* (subpath "/etc"))` → exit 71
 * 所以探针必须**带一条 deny**：能收紧才算可用，否则降级 L2（软沙箱）。
 */
let sandboxDetected: boolean | null = null
export const SANDBOX_PROBE_PROFILE = '(version 1) (allow default) (deny file-read* (subpath "/etc"))'

export function detectSandboxExec(): Promise<boolean> {
  if (sandboxDetected !== null) return Promise.resolve(sandboxDetected)
  return new Promise((resolveFn) => {
    try {
      exec(`sandbox-exec -p '${SANDBOX_PROBE_PROFILE}' /bin/echo ok`, { timeout: 3000 }, (err) => {
        sandboxDetected = !err
        resolveFn(!err)
      })
    } catch {
      sandboxDetected = false
      resolveFn(false)
    }
  })
}

/**
 * 运行期才发现沙箱不可用（探测通过、实际 `sandbox_apply` 失败）时调用：
 * 把这个进程的探测结果置为不可用，后续命令直接走软沙箱，不再每条都撞一次 71。
 */
export function markSandboxUnavailable(reason?: string): void {
  if (sandboxDetected === false) return
  sandboxDetected = false
  console.warn(`[Sandbox] 运行期发现硬沙箱不可用，已全局降级为软沙箱（L1/L2 仍生效）${reason ? `：${reason.slice(0, 160)}` : ''}`)
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

/**
 * 凭据文件名（任意路径位置出现即拦：.env/.npmrc/id_rsa 等）
 * 2026-10-26：路径前缀认 `\`（Windows 上 `C:\proj\.env` 原本不命中），并加 `i` 标记 ——
 * 与 SENSITIVE_DIR 同理，大小写不敏感的平台不能留 `.ENV` 这种绕过。
 */
const CREDENTIAL_FILE =
  /(?:^|[\s'";&|(])(?:[^\s'";&|()]*[\/\\])?(\.env(?:\.[A-Za-z0-9_-]+)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_rsa|id_ed25519|id_dsa)(?=[\s'";&|)]|$)/i

/**
 * 敏感配置目录（任何权限档位下都不可访问）：
 * .ssh/.aws/.config/.gnupg/.kube/.docker/.npm/.pki/.gradle/.m2/.cache/.git 等
 *
 * 🔴 2026-10-26 两处修正：
 *   ① 分隔符原来只写 `/`。Windows 路径是 `C:\Users\x\.ssh\id_rsa`，这条正则**一个都匹配不到**
 *      —— 也就是说在 Windows 上敏感目录从来没有被拦住过。这是安全缺口，不只是兼容性问题。
 *   ② 补 `i` 标记。Windows 与 macOS(APFS) 文件系统大小写不敏感，`.SSH`/`.Aws` 指向的是
 *      同一个目录；而 pathUnder 在同样的平台上已经按大小写不敏感比较 —— 两边必须一致，
 *      否则比较放宽了、敏感匹配没放宽，`.SSH` 就是一条现成的绕过路径。
 *      代价：Linux 上若真存在 `.SSH` 这种同名目录会被一并拦下（实际不会有人这么建）。
 */
const SENSITIVE_DIR =
  /[\/\\](?:\.ssh|\.aws|\.config|\.gnupg|\.kube|\.docker|\.npm|\.pki|\.gradle|\.m2|\.cache|\.git|\.svn|\.hg)(?:[\/\\]|$)/i

/** 默认权限三档：workspace-only（仅工作文件夹）/ sandbox（项目沙箱，默认）/ full（允许完全访问） */
export type PermissionLevel = 'workspace-only' | 'sandbox' | 'full'

/**
 * 扫描命令中的危险路径引用，返回拦截原因；无风险返回 null。
 * 规则：
 *   1. ~ 直接引用敏感配置目录（.ssh/.aws/.env 等）
 *   2. 引用系统敏感文件（/etc/shadow 等）
 *   3. 引用凭据文件（.env/.npmrc/id_rsa 等，任意位置）
 *   4. 绝对路径指向 home 下非白名单区域（项目仓库/运行时/临时目录之外）
 */
export function scanDangerousPath(command: string, opts: { level?: PermissionLevel; workspaceDir?: string } = {}): string | null {
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

  // 4. home 下绝对路径越权（含 ~/ 与 $HOME/ 展开形式，按权限档位前缀）
  if (HOME) {
    const homeEsc = HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:${homeEsc}|~|\\$HOME)/[^\\s'"\`;&|<>()]*`, 'g')
    const allowed = allowedPrefixes(opts.level || 'sandbox', opts.workspaceDir)
    for (const m of command.matchAll(re)) {
      const raw = m[0]
      // 展开 ~ 与 $HOME
      const p = resolve(raw.startsWith('~/') ? join(HOME, raw.slice(2)) : raw.startsWith('$HOME/') ? join(HOME, raw.slice(6)) : raw)
      if (SENSITIVE_DIR.test(p)) return `引用敏感配置目录: ${raw.slice(0, 80)}`
      if (allowed.some((a) => p === a || p.startsWith(a + '/'))) continue
      return `路径越权: ${raw.slice(0, 80)}`
    }
  }

  return null
}

// ============================
// 文件工具白名单（file_read / file_write / file_exists 共用）
// ============================

/** 路径是否位于白名单内（按权限档位：workspace-only / sandbox / full） */
/**
 * 纯字符串的祖先判断：`child` 是否等于 `parent` 或位于其下。
 *
 * 单独抽出来是为了**可测**：`resolve()` 会把 `C:\Users\x` 在 macOS 上解析成本地路径，
 * 所以真实 Windows 路径没法在这个平台上走完整链路。这里只做分隔符归一化 + 比较，
 * 两个平台的输入都能直接断言。
 *
 * 大小写：Windows 与 macOS（APFS 默认）文件系统都**不敏感**，`~\Documents` 与 `~\documents`
 * 是同一个目录 —— 不做归一化会把合法路径判成越权。Linux 保持敏感。
 * 注意这与 SENSITIVE_DIR 的 `i` 标记必须一致：比较放宽了，敏感目录匹配也得跟着放宽，
 * 否则 `.SSH` 就成了绕过口子。
 */
export function pathUnder(child: string, parent: string): boolean {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const norm = (s: string) => {
    const t = s.replace(/\\/g, '/').replace(/\/+$/, '')
    return caseInsensitive ? t.toLowerCase() : t
  }
  const c = norm(child)
  const p = norm(parent)
  if (!p) return false
  return c === p || c.startsWith(p + '/')
}

/** 统一分隔符（含尾部斜杠清理）；不改变大小写，仅供展示/诊断 */
function toSlashes(p: string): string {
  const s = resolve(p).replace(/\\/g, '/')
  return s.length > 1 ? s.replace(/\/+$/, '') : s
}

export function isPathAllowed(
  p: string,
  opts: { level?: PermissionLevel; workspaceDir?: string; extraAllowed?: string[] } | string[] = {},
): boolean {
  if (!p) return false
  const o = Array.isArray(opts) ? { extraAllowed: opts } : opts
  const level = o.level || 'sandbox'
  const resolved = toSlashes(p)
  return allowedPrefixes(level, o.workspaceDir)
    .concat(o.extraAllowed || [])
    .some((a) => pathUnder(resolved, toSlashes(a)))
}

/**
 * 文件工具路径校验：返回错误原因，安全返回 null。
 * 规则：①凭据文件/敏感目录一律禁止 ②必须位于对应权限档位的白名单内
 */
export function assertSafeFilePath(
  p: string,
  opts: { level?: PermissionLevel; workspaceDir?: string; extraAllowed?: string[] } | string[] = {},
): string | null {
  if (!p) return '路径为空'
  const o = Array.isArray(opts) ? { extraAllowed: opts } : opts
  if (CREDENTIAL_FILE.test(p)) return `凭据文件不可访问: ${p.slice(0, 80)}`
  if (SENSITIVE_DIR.test(p)) return `敏感目录不可访问: ${p.slice(0, 80)}`
  if (!isPathAllowed(p, o)) return `路径越权（当前权限: ${o.level || 'sandbox'}）: ${p.slice(0, 80)}`
  return null
}

/**
 * ESM 产物修扩展名（2026-09-20）
 *
 * 问题：`tsc -p tsconfig.build.json` 用 moduleResolution=bundler，源码里写的是无扩展名的
 * `import { config } from './config'`。tsc 原样输出，于是 dist 里也是 `from './config'`。
 * 这在打包器里没问题，但 Node 原生 ESM 要求完整 specifier —— 而且 './config' 是个目录，
 * 直接报 ERR_UNSUPPORTED_DIR_IMPORT，`node dist/app.js` 起都起不来。
 *
 * 解决：编译后把相对 specifier 补成真实文件路径（./config → ./config/index.js，
 * ./services/database → ./services/database.js）。只改我们自己产出的相对引用，
 * 包名（koa / @koa/cors 等）原样不动。
 *
 * 用法：node scripts/fix-esm-specifiers.mjs <dist 目录>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join, resolve, dirname, relative, sep } from 'path'

const root = resolve(process.argv[2] || 'dist')
if (!existsSync(root)) {
  console.error(`[fix-esm] 目录不存在: ${root}`)
  process.exit(1)
}

/** 收集所有 .js 文件 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full)
  }
  return out
}

/** 把相对 specifier 补成 Node ESM 能解析的真实路径 */
function fixSpecifier(spec, fromFile) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  if (existsSync(base) && statSync(base).isFile()) return null // 已经带扩展名且存在
  if (existsSync(`${base}.js`)) {
    // './a' → './a.js'；注意保留 './' 前缀
    return spec.replace(/\/*$/, '') + '.js'
  }
  if (existsSync(join(base, 'index.js'))) {
    return spec.replace(/\/*$/, '') + '/index.js'
  }
  return null
}

// 覆盖三种形态：import ... from '...' / export ... from '...' / import('...') / import '...'
// 每条正则都只有 3 个捕获组（前缀 / 引号 / specifier），收尾引号用 \2 反向引用避免多出一个组
const PATTERNS = [
  /(\bfrom\s*)(['"])(\.{1,2}\/[^'"\n]*)\2/g,
  /(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]*)\2/g,
  /(\bimport\s+)(['"])(\.{1,2}\/[^'"\n]*)\2/g,
]

let files = 0
let fixed = 0
for (const file of walk(root)) {
  const src = readFileSync(file, 'utf-8')
  let out = src
  for (const re of PATTERNS) {
    out = out.replace(re, (m, pre, q, spec) => {
      const next = fixSpecifier(spec, file)
      if (!next) return m
      fixed++
      return `${pre}${q}${next}${q}`
    })
  }
  if (out !== src) {
    writeFileSync(file, out, 'utf-8')
    files++
  }
}

console.log(`[fix-esm] 修正 ${fixed} 处相对引用，涉及 ${files} 个文件（dist=${relative(process.cwd(), root).split(sep).join('/')}）`)

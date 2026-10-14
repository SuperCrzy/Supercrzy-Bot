#!/usr/bin/env node
/**
 * asar-extract.mjs — 按需读取 Electron asar 包内容（不解包）
 *
 * 为什么需要它：WorkBuddy 的 `app.asar` 有 317MB / 23224 条目，
 * 全量 extractAll 要解出 ~700MB 且污染磁盘。调研只需要其中几十个文件，
 * 所以做成"按需抽取 + 包内 grep"。
 *
 * 用法：
 *   node scripts/tools/asar-extract.mjs list  [--filter <substr>] [--size] [--json]
 *   node scripts/tools/asar-extract.mjs tree  <dir>
 *   node scripts/tools/asar-extract.mjs cat   <path-in-asar>          # 打到 stdout
 *   node scripts/tools/asar-extract.mjs out   <path-in-asar> <dest>   # 落盘
 *   node scripts/tools/asar-extract.mjs grep  <regex> [--filter <substr>] [--ctx N] [--max N]
 *   node scripts/tools/asar-extract.mjs info  <path-in-asar>          # 大小/类型/前 512 字节
 *
 * 环境变量：
 *   ASAR_PATH  覆盖 asar 路径（默认 /Applications/WorkBuddy.app/Contents/Resources/app.asar）
 *
 * 注意：包内路径一律以 `/` 开头（asar.listPackage 的返回格式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ASAR = process.env.ASAR_PATH || '/Applications/WorkBuddy.app/Contents/Resources/app.asar';

// @electron/asar 是 CJS，且装在仓库根 node_modules 里
let asar;
try {
  asar = require('@electron/asar');
} catch {
  console.error('找不到 @electron/asar。请在仓库根安装：pnpm add -D @electron/asar');
  process.exit(2);
}

const argv = process.argv.slice(2);
const cmd = argv[0];

function arg(name, dflt = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

/** 二进制/文本判定：只看是否含 NUL 与可打印比例 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl / n > 0.1;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(2)}M`;
}

/**
 * 坑：asar.listPackage() 返回的路径带前导 `/`，但 asar.extractFile()/statFile()
 * 要的是**不带**前导 `/` 的相对路径——不归一化会得到
 * `"${p}" was not found in this archive`。这是最容易踩的一处不一致。
 */
function rel(p) {
  return String(p).replace(/^\/+/, '');
}

function readEntry(p) {
  return asar.extractFile(ASAR, rel(p));
}

switch (cmd) {
  // ------------------------------------------------------------------ list
  case 'list': {
    const filter = arg('filter', '');
    const wantSize = !!arg('size', false);
    const asJson = !!arg('json', false);
    let list = asar.listPackage(ASAR);
    if (filter) list = list.filter((p) => p.includes(filter));
    // 目录项以 `/` 结尾，单独列出来没有信息量
    list = list.filter((p) => !p.endsWith('/'));
    const rows = [];
    for (const p of list) {
      let size = null;
      if (wantSize) {
        try {
          size = asar.statFile(ASAR, p.replace(/^\//, '')).size;
        } catch {
          size = -1;
        }
      }
      rows.push({ p, size });
    }
    if (wantSize) rows.sort((a, b) => b.size - a.size);
    if (asJson) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const r of rows) {
        console.log(r.size === null ? r.p : `${human(r.size).padStart(9)}  ${r.p}`);
      }
      console.log(`# ${rows.length} entries`);
    }
    break;
  }

  // ------------------------------------------------------------------ tree
  case 'tree': {
    const dir = (argv[1] || '/').replace(/\/$/, '');
    const list = asar.listPackage(ASAR).filter((p) => p.startsWith(dir === '/' ? '/' : dir + '/'));
    const kids = new Map();
    for (const p of list) {
      const rel = p.slice(dir === '/' ? 1 : dir.length + 1);
      const [head, ...rest] = rel.split('/');
      if (!head) continue;
      if (!kids.has(head)) kids.set(head, { files: 0, bytes: 0, isDir: rel.endsWith('/') });
      const k = kids.get(head);
      if (rest.length) {
        k.isDir = true;
        k.files++;
      } else {
        try {
          k.bytes = asar.statFile(ASAR, p.replace(/^\//, '')).size;
        } catch {
          k.bytes = -1;
        }
      }
    }
    for (const [name, k] of [...kids.entries()].sort()) {
      console.log(k.isDir ? `[dir ] ${name.padEnd(46)} ${k.files} files` : `[file] ${name.padEnd(46)} ${human(k.bytes)}`);
    }
    console.log(`# ${kids.size} children of ${dir}`);
    break;
  }

  // ------------------------------------------------------------- cat / out
  case 'cat': {
    const p = argv[1];
    if (!p) throw new Error('用法: cat <path-in-asar>');
    const buf = readEntry(p);
    process.stdout.write(buf);
    break;
  }
  case 'out': {
    const p = argv[1];
    const dest = argv[2];
    if (!p || !dest) throw new Error('用法: out <path-in-asar> <dest>');
    const buf = readEntry(p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    console.log(`${human(buf.length)} -> ${dest}`);
    break;
  }

  // ------------------------------------------------------------------ info
  case 'info': {
    const p = argv[1];
    if (!p) throw new Error('用法: info <path-in-asar>');
    const buf = readEntry(p);
    console.log(`path   : ${p}`);
    console.log(`bytes  : ${buf.length} (${human(buf.length)})`);
    console.log(`binary : ${looksBinary(buf)}`);
    console.log(`head   : ${JSON.stringify(buf.subarray(0, 512).toString('utf8').slice(0, 500))}`);
    break;
  }

  // ------------------------------------------------------------------ grep
  case 'grep': {
    const re = new RegExp(argv[1] ?? '', 'g');
    const filter = arg('filter', '');
    const ctx = Number(arg('ctx', 0));
    const max = Number(arg('max', 200));
    let list = asar.listPackage(ASAR).filter((p) => !p.endsWith('/'));
    if (filter) list = list.filter((p) => p.includes(filter));
    let hits = 0;
    for (const p of list) {
      let buf;
      try {
        buf = readEntry(p);
      } catch {
        continue;
      }
      // 二进制直接跳过（图片/字体/so）
      if (/\.(png|jpg|jpeg|gif|webp|icns|ttf|otf|woff2?|so|dylib|node|wasm|zip|gz|mp4|pdf)$/i.test(p)) continue;
      if (looksBinary(buf)) continue;
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        hits++;
        if (hits > max) break;
        console.log(`\n── ${p}:${i + 1}`);
        for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
          console.log(`   ${j + 1}| ${lines[j].slice(0, 600)}`);
        }
      }
      if (hits > max) break;
    }
    console.log(`\n# ${hits > max ? '>' + max : hits} hits`);
    break;
  }

  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
}

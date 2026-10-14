/**
 * skill 整目录搬运 + 许可识别的不变量测试（2026-10-14）
 *
 * 背景：`installSkillFromGitHub` 旧实现只把 SKILL.md 的**文本**写进 DB，随后 finally
 * 删掉整个 clone，于是 `scripts/`、`references/`、`templates/` 与 `LICENSE.txt` 全部丢失。
 * 后果不是「少了几个文件」，而是两层损坏：
 *   1. 技能功能残废 —— 正文引用 `scripts/office/soffice.py`，但文件根本不存在；
 *   2. 许可归属不明 —— 技能随仓库分发，却没有任何许可声明。
 * 上游 docx/pdf/pptx/xlsx 就是这样变成「既无授权、又跑不起来的空壳」。
 *
 * 这里断言的是**行为后果**，不是实现细节：
 *  - 搬运后许可文件与脚本必须真的落在目标目录里；
 *  - 上游的 `.git` / `node_modules` 不能被带进来（前者形成嵌套仓库，让权属变模糊）；
 *  - 许可识别**不能把「保留所有权利」误判成可自由分发的许可**。
 *    这是最坏方向的错：BSD-2 正文里也有 "All rights reserved"，所以判定顺序必须是
 *    「先具体许可、后 reserved 兜底」，反过来会把专有材料当成 Apache 用。
 *
 * 全程离线：只测纯函数，不 clone 任何仓库，不碰 DB —— 依赖网络的断言会让 CI 随机红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { copySkillDir, detectLicenseKind, isLicenseFile } from './skill-loader'

// ---- 测试夹具：许可文本只还原「形状」，不抄任何上游专有正文 ----

const APACHE_SHAPE = [
  '                                 Apache License',
  '                           Version 2.0, January 2004',
  '                        http://www.apache.org/licenses/',
].join('\n')

const MIT_SHAPE = [
  'MIT License',
  '',
  'Copyright (c) 2024 Example Author',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
].join('\n')

/** BSD-2 的典型形状：注意它**同时**含 "All rights reserved" */
const BSD_SHAPE = [
  'Copyright (c) 2024, Example Author',
  'All rights reserved.',
  '',
  'Redistribution and use in source and binary forms, with or without',
  'modification, are permitted provided that the following conditions are met:',
  '',
  'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
].join('\n')

/** 专有 / source-available 的典型形状（关键标识：版权保留 + LICENSE: 条款说明） */
const PROPRIETARY_SHAPE = [
  '\u00a9 2025 Example Corp. All rights reserved.',
  '',
  'LICENSE: Use of these materials is governed by the terms set out below.',
  '',
  'ADDITIONAL RESTRICTIONS',
  'You may not reproduce, distribute, or create derivative works.',
].join('\n')

const GPL3_SHAPE = [
  '                    GNU GENERAL PUBLIC LICENSE',
  '                       Version 3, 29 June 2007',
].join('\n')

const LGPL21_SHAPE = [
  '                  GNU LESSER GENERAL PUBLIC LICENSE',
  '                       Version 2.1, February 1999',
].join('\n')

let sandbox = ''

function makeSourceTree(): string {
  const src = join(sandbox, 'upstream-skill')
  mkdirSync(join(src, 'scripts', 'office'), { recursive: true })
  mkdirSync(join(src, 'references'), { recursive: true })
  mkdirSync(join(src, '.git', 'objects'), { recursive: true })
  mkdirSync(join(src, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(src, '__pycache__'), { recursive: true })

  writeFileSync(join(src, 'SKILL.md'), '---\nname: demo\ndescription: d\nlicense: MIT\n---\n\n# Demo\n')
  writeFileSync(join(src, 'LICENSE.txt'), MIT_SHAPE)
  writeFileSync(join(src, 'scripts', 'helper.py'), 'print("helper")\n')
  writeFileSync(join(src, 'scripts', 'office', 'soffice.py'), 'print("soffice")\n')
  writeFileSync(join(src, 'references', 'FORM.md'), '# Form reference\n')
  writeFileSync(join(src, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(src, '.git', 'objects', 'deadbeef'), 'blob')
  writeFileSync(join(src, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')
  writeFileSync(join(src, '__pycache__', 'helper.cpython-311.pyc'), 'binary')
  return src
}

beforeEach(() => {
  sandbox = join(tmpdir(), `sc-skill-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(sandbox, { recursive: true })
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('copySkillDir：整目录搬运', () => {
  it('许可文件与脚本必须真的落盘（旧实现正是丢在这里）', () => {
    const src = makeSourceTree()
    const dest = join(sandbox, 'installed')
    copySkillDir(src, dest)

    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, 'LICENSE.txt'))).toBe(true)
    expect(existsSync(join(dest, 'scripts', 'helper.py'))).toBe(true)
    expect(existsSync(join(dest, 'scripts', 'office', 'soffice.py'))).toBe(true)
    expect(existsSync(join(dest, 'references', 'FORM.md'))).toBe(true)
  })

  it('内容逐字节保留（不是「建了同名空文件」）', () => {
    const src = makeSourceTree()
    const dest = join(sandbox, 'installed')
    copySkillDir(src, dest)
    expect(readFileSync(join(dest, 'LICENSE.txt'), 'utf-8')).toBe(readFileSync(join(src, 'LICENSE.txt'), 'utf-8'))
    expect(readFileSync(join(dest, 'scripts', 'office', 'soffice.py'), 'utf-8')).toBe('print("soffice")\n')
  })

  it('不得带进 .git 与 node_modules（前者会形成嵌套仓库，让权属变模糊）', () => {
    const src = makeSourceTree()
    const dest = join(sandbox, 'installed')
    copySkillDir(src, dest)

    expect(existsSync(join(dest, '.git'))).toBe(false)
    expect(existsSync(join(dest, 'node_modules'))).toBe(false)
    expect(existsSync(join(dest, '__pycache__'))).toBe(false)
  })

  it('返回实际复制的文件数（4 个内容文件 + SKILL.md + LICENSE.txt）', () => {
    const src = makeSourceTree()
    const dest = join(sandbox, 'installed')
    // SKILL.md / LICENSE.txt / helper.py / soffice.py / FORM.md = 5
    expect(copySkillDir(src, dest)).toBe(5)
  })

  it('目标目录已存在时不报错（重复安装幂等）', () => {
    const src = makeSourceTree()
    const dest = join(sandbox, 'installed')
    copySkillDir(src, dest)
    expect(() => copySkillDir(src, dest)).not.toThrow()
    expect(existsSync(join(dest, 'LICENSE.txt'))).toBe(true)
  })
})

describe('detectLicenseKind：许可识别', () => {
  const write = (name: string, text: string) => {
    const p = join(sandbox, name)
    writeFileSync(p, text, 'utf-8')
    return p
  }

  it('识别 Apache-2.0 / MIT / GPL-3.0 / LGPL-2.1', () => {
    expect(detectLicenseKind(write('a.txt', APACHE_SHAPE))).toBe('Apache-2.0')
    expect(detectLicenseKind(write('m.txt', MIT_SHAPE))).toBe('MIT')
    expect(detectLicenseKind(write('g.txt', GPL3_SHAPE))).toBe('GPL-3.0')
    expect(detectLicenseKind(write('l.txt', LGPL21_SHAPE))).toBe('LGPL-2.1')
  })

  // 🔴 关键不变量：BSD 正文含 "All rights reserved"，判定顺序错就会把可自由分发的
  //    BSD 判成专有 —— 方向反了更糟的是把专有判成可分发。
  it('BSD（正文含 All rights reserved）必须判为 BSD，不能被 reserved 兜底吃掉', () => {
    expect(detectLicenseKind(write('b.txt', BSD_SHAPE))).toBe('BSD')
  })

  it('专有 / source-available 必须判为保留所有权利，不能误判成任何可自由分发的许可', () => {
    const kind = detectLicenseKind(write('p.txt', PROPRIETARY_SHAPE))
    expect(kind).toContain('保留所有权利')
    for (const free of ['Apache-2.0', 'MIT', 'BSD', 'GPL', 'LGPL']) {
      expect(kind).not.toContain(free)
    }
  })

  it('读不到或识别不出时明确说「未识别」，不猜', () => {
    expect(detectLicenseKind(join(sandbox, 'does-not-exist.txt'))).toBe('无法读取')
    expect(detectLicenseKind(write('x.txt', 'just some text with no license markers'))).toBe('未识别')
  })
})

describe('isLicenseFile：许可文件名识别', () => {
  it('命中常见许可文件名', () => {
    for (const n of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'COPYING', 'NOTICE', 'NOTICE.txt']) {
      expect(isLicenseFile(n)).toBe(true)
    }
  })

  it('不误伤普通文件（避免把 README 或笔记当成许可）', () => {
    for (const n of ['README.md', 'license-notes.md', 'SKILL.md', 'reference.md']) {
      expect(isLicenseFile(n)).toBe(false)
    }
  })
})

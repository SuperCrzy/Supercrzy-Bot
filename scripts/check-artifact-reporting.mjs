#!/usr/bin/env node
/**
 * Gate: a tool that writes a file must report it as an artifact.
 *
 * Why this exists (2026-11-21): the convention "writing a file means calling
 * ctx.onArtifacts" lived only in prose. file_write and multi_edit both write
 * files and neither reported, so the artifacts table stayed empty, and the
 * right panel's "session artifacts" group had nothing to show — a bug that
 * survived for months because nothing checked. android_screen had the same gap.
 *
 * The check is deliberately textual: it answers "does this file write, and does
 * it report?" A tool that writes but never reports is either a bug or needs the
 * exemption comment below.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = path.join(here, '..', 'packages', 'server', 'src', 'tools')

/** Calls that create or modify a file on disk. */
const WRITE_PATTERNS = [
    /\bawait\s+writeFile\s*\(/,
    /\bwriteFileSync\s*\(/,
    /\bawait\s+appendFile\s*\(/,
    /\bappendFileSync\s*\(/,
    /\bcreateWriteStream\s*\(/,
    /\bcopyFileSync?\s*\(/,
]

/** The only sanctioned ways to register a produced file. */
const REPORT_PATTERN = /\b(writeArtifact|registerArtifact)\s*\(/

/** The helper itself writes files; it is the exception, not a caller. */
const HELPER_FILE = 'write-artifact.ts'

/** Escape hatch, must carry a reason on the same line. */
const EXEMPT_PATTERN = /\/\/\s*artifact-reporting-exempt:\s*\S/

function main() {
    if (!fs.existsSync(TOOLS_DIR)) {
        console.error(`[artifact-reporting] tools directory not found: ${TOOLS_DIR}`)
        process.exit(1)
    }

    const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const offenders = []
    let writers = 0
    let exempted = 0

    for (const file of files) {
        if (file === HELPER_FILE) continue
        const src = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8')
        const writes = WRITE_PATTERNS.some(re => re.test(src))
        if (!writes) continue
        writers += 1
        if (REPORT_PATTERN.test(src)) continue
        if (EXEMPT_PATTERN.test(src)) { exempted += 1; continue }
        offenders.push(file)
    }

    if (offenders.length === 0) {
        // Only tools that still touch fs directly are counted: everything else
        // goes through the helper, where the two steps cannot come apart.
        console.log(`[artifact-reporting] OK — ${writers} tool(s) write to fs directly, all via the shared helper` +
            (exempted ? ` (${exempted} exempt with a stated reason)` : ''))
        return
    }

    console.error('[artifact-reporting] FAIL — these tools write files without the shared helper:')
    for (const f of offenders) console.error(`  - src/tools/${f}`)
    console.error('')
    console.error('  写盘和"登记为产物"必须是同一个动作，否则一定会漏（历史：file_write / multi_edit / android_screen 三个都漏过）。')
    console.error('  一次性写：')
    console.error("    await writeArtifact(ctx, path, content, { previous: oldContent })")
    console.error('  分块写 / 外部程序写的（ffmpeg、命令）：')
    console.error("    registerArtifact(ctx, path, { action: 'created', size })")
    console.error('  确实不是用户产物的临时文件，在写的那一行写明：')
    console.error('    // artifact-reporting-exempt: <why this is not a user artifact>')
    process.exit(1)
}

main()

/**
 * Build the OS-native OCR helpers (2026-10-26).
 *
 * macOS: compiles scripts/vision_ocr.swift → scripts/bin/vision_ocr (~68KB).
 * The binary links Vision/AppKit dynamically from the OS, so shipping it costs
 * essentially nothing compared to bundling a Python OCR stack (~250MB).
 *
 * Windows: nothing to compile — scripts/win_ocr.ps1 is interpreted at runtime.
 *
 * Runs as an optional build step: when the Swift toolchain is missing (CI runners
 * without Xcode CLT, Linux, Windows), it exits 0 so `pnpm build` never breaks.
 * At runtime services/ocr-engine.ts falls back to compiling on demand or to RapidOCR.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, 'vision_ocr.swift')
const BIN_DIR = join(__dirname, 'bin')
const OUT = join(BIN_DIR, 'vision_ocr')

if (process.platform !== 'darwin') {
  console.log('[ocr-helpers] skipped: OS-native OCR helper is macOS-only here')
  process.exit(0)
}

if (!existsSync(SRC)) {
  console.log('[ocr-helpers] skipped: vision_ocr.swift not found')
  process.exit(0)
}

try {
  mkdirSync(BIN_DIR, { recursive: true })
  execFileSync('xcrun', ['swiftc', '-O', SRC, '-o', OUT], { stdio: 'inherit' })
  const kb = Math.round(statSync(OUT).size / 1024)
  console.log(`[ocr-helpers] built ${OUT} (${kb} KB)`)
} catch (err) {
  // Missing Xcode CLT is expected on plain CI images — not a build failure.
  console.log(`[ocr-helpers] skipped: ${String(err?.message || err).split('\n')[0]}`)
}

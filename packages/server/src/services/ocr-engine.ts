/**
 * OCR engine chain (2026-10-26).
 *
 * Why this exists: the previous implementation hard-wired `python3 scripts/ocr_service.py`
 * (RapidOCR + onnxruntime, ~250MB of pip dependencies). Users who never installed those
 * modules got a silent "OCR failed" on every screenshot — the feature looked broken even
 * though the app shipped fine. Meanwhile both target platforms already ship a first-class
 * OCR engine that costs nothing:
 *
 *   macOS   → Vision framework (VNRecognizeTextRequest). A 68KB helper binary.
 *   Windows → Windows.Media.Ocr (WinRT), present since Windows 10 1809.
 *
 * So the resolution order is: OS-native first, third-party only as a fallback.
 *   1. `vision`   macOS Vision helper (prebuilt `scripts/bin/vision_ocr`, or compiled
 *                 on demand into `~/.supercrzy/bin` when the Swift toolchain exists)
 *   2. `winrt`    Windows.Media.Ocr via `scripts/win_ocr.ps1`
 *   3. `rapidocr` legacy python path — kept so existing installs keep working
 *   4. `none`     honest failure with a readable reason, never a fake empty result
 *
 * The engine that succeeds is cached for the process lifetime; failures do not poison it.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
/** packages/server/{dist|src}/services → packages/server */
const SERVER_ROOT = join(__dirname, '..', '..')
const SCRIPTS_DIR = join(SERVER_ROOT, 'scripts')

export type OcrEngineName = 'vision' | 'winrt' | 'rapidocr' | 'none'

export interface OcrResult {
  texts: string[]
  engine: OcrEngineName
  elapsed: number
  /** Present when engine === 'none' — human readable, shown to the agent/user */
  error?: string
}

/** Engine that worked last time; `null` = not resolved yet */
let cachedEngine: OcrEngineName | null = null
/** Set after a compile attempt so we do not retry Swift compilation on every screenshot */
let visionCompileTried = false

/** Test/diagnostic hook */
export function resetOcrEngineCache(): void {
  cachedEngine = null
  visionCompileTried = false
}

const VISION_CANDIDATES = () => [
  join(SCRIPTS_DIR, 'bin', 'vision_ocr'),
  join(homedir(), '.supercrzy', 'bin', 'vision_ocr'),
]

/** Locate a runnable Vision helper, compiling the bundled Swift source if needed */
async function resolveVisionHelper(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  for (const p of VISION_CANDIDATES()) if (existsSync(p)) return p
  if (visionCompileTried) return null
  visionCompileTried = true
  const src = join(SCRIPTS_DIR, 'vision_ocr.swift')
  if (!existsSync(src)) return null
  const outDir = join(homedir(), '.supercrzy', 'bin')
  const out = join(outDir, 'vision_ocr')
  try {
    const { mkdirSync } = await import('fs')
    mkdirSync(outDir, { recursive: true })
    // `-O` keeps startup fast; the binary links Vision/AppKit dynamically from the OS,
    // which is why it stays around 68KB instead of pulling in a runtime.
    await execFileP('xcrun', ['swiftc', '-O', src, '-o', out], { timeout: 120000 })
    return existsSync(out) ? out : null
  } catch {
    return null
  }
}

/** Run the macOS Vision helper; returns recognised lines */
async function runVision(imagePath: string): Promise<string[]> {
  const bin = await resolveVisionHelper()
  if (!bin) throw new Error('Vision helper unavailable')
  // 60s: a full-screen retina capture with dense text legitimately takes 5-15s even
  // after downscaling (measured 28.9s at native 2880x1800 before the cap landed).
  const { stdout } = await execFileP(bin, [imagePath], { timeout: 60000 })
  return parseTexts(stdout)
}

/** Run Windows.Media.Ocr through the PowerShell shim */
async function runWinRt(imagePath: string): Promise<string[]> {
  if (process.platform !== 'win32') throw new Error('WinRT OCR is Windows-only')
  const script = join(SCRIPTS_DIR, 'win_ocr.ps1')
  if (!existsSync(script)) throw new Error('win_ocr.ps1 not found')
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, imagePath],
    { timeout: 30000, windowsHide: true },
  )
  return parseTexts(stdout)
}

/** Legacy path: python3 + rapidocr_onnxruntime (user-installed) */
async function runRapidOcr(imagePath: string): Promise<string[]> {
  const script = join(SCRIPTS_DIR, 'ocr_service.py')
  if (!existsSync(script)) throw new Error('ocr_service.py not found')
  const python = process.env.OCR_PYTHON_BIN || 'python3'
  const { stdout } = await execFileP(python, [script, imagePath], { timeout: 30000 })
  const parsed = JSON.parse(stdout) as { texts?: string[]; error?: string }
  if (parsed.error) throw new Error(parsed.error)
  return parsed.texts || []
}

/**
 * Helpers print JSON. Accept either `{texts:[...]}` or a bare `[...]`,
 * plus a plain-text line stream as the last resort (debugging convenience).
 */
function parseTexts(stdout: string): string[] {
  const raw = String(stdout || '').trim()
  if (!raw) return []
  try {
    const j = JSON.parse(raw) as unknown
    if (Array.isArray(j)) return j.map((x) => String(x)).filter(Boolean)
    const texts = (j as { texts?: unknown })?.texts
    if (Array.isArray(texts)) return texts.map((x) => String(x)).filter(Boolean)
    const err = (j as { error?: unknown })?.error
    if (typeof err === 'string' && err) throw new Error(err)
  } catch (err) {
    if (err instanceof Error && err.message && !/JSON/i.test(err.message)) throw err
  }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean)
}

const ORDER: OcrEngineName[] = ['vision', 'winrt', 'rapidocr']

async function runEngine(engine: OcrEngineName, imagePath: string): Promise<string[]> {
  if (engine === 'vision') return runVision(imagePath)
  if (engine === 'winrt') return runWinRt(imagePath)
  return runRapidOcr(imagePath)
}

/**
 * Recognise text in an image using the first engine that works.
 * Never throws: a fully failed chain returns `{ engine: 'none', error }` so the caller
 * can surface *why* instead of pretending there was no text on screen.
 */
export async function runOcr(imagePath: string): Promise<OcrResult> {
  const started = Date.now()
  const candidates = cachedEngine ? [cachedEngine, ...ORDER.filter((e) => e !== cachedEngine)] : ORDER
  const errors: string[] = []

  for (const engine of candidates) {
    try {
      const texts = await runEngine(engine, imagePath)
      cachedEngine = engine
      return { texts, engine, elapsed: Date.now() - started }
    } catch (err: any) {
      errors.push(`${engine}: ${String(err?.message || err).split('\n')[0]}`)
      if (cachedEngine === engine) cachedEngine = null
    }
  }

  return {
    texts: [],
    engine: 'none',
    elapsed: Date.now() - started,
    error: errors.join(' | ') || 'no OCR engine available',
  }
}

/** Which engine would be used right now (diagnostics endpoint / settings page) */
export function ocrEngineStatus(): { platform: string; cached: OcrEngineName | null; available: OcrEngineName[]; pythonBin: string } {
  const available: OcrEngineName[] = []
  if (process.platform === 'darwin' && (existsSync(VISION_CANDIDATES()[0]) || existsSync(VISION_CANDIDATES()[1]) || existsSync(join(SCRIPTS_DIR, 'vision_ocr.swift')))) {
    available.push('vision')
  }
  if (process.platform === 'win32' && existsSync(join(SCRIPTS_DIR, 'win_ocr.ps1'))) available.push('winrt')
  if (existsSync(join(SCRIPTS_DIR, 'ocr_service.py'))) available.push('rapidocr')
  return { platform: process.platform, cached: cachedEngine, available, pythonBin: process.env.OCR_PYTHON_BIN || 'python3' }
}

/**
 * 64x64 blank PNG — enough to make Vision load its models.
 * (1x1 is rejected outright: "each dimension has to be more than 2 pixels".)
 */
const WARMUP_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAXklEQVR4nO3PMQ0AMAzAsPInvYLYYVWKESTzjhsd8KsBrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BbQHKU9LC7/CP1AAAAABJRU5ErkJggg=='

/**
 * Pay the one-time Vision model load before the user asks for a screenshot.
 *
 * Measured 2026-10-26: the first Vision call after boot took **60s**, later calls
 * 0.35–0.65s on the same 2880x1800 image. Left alone, the first `computer_use`
 * screenshot after every restart would hang for a minute. Fire-and-forget from
 * app startup; failures are irrelevant (the real call will retry).
 */
export async function warmupOcr(): Promise<{ engine: OcrEngineName; elapsed: number; ok: boolean }> {
  const { writeFileSync, unlinkSync } = await import('fs')
  const { tmpdir } = await import('os')
  const tmp = join(tmpdir(), `supercrzy-ocr-warmup-${process.pid}.png`)
  try {
    writeFileSync(tmp, Buffer.from(WARMUP_PNG_BASE64, 'base64'))
    const r = await runOcr(tmp)
    return { engine: r.engine, elapsed: r.elapsed, ok: r.engine !== 'none' }
  } catch {
    return { engine: 'none', elapsed: 0, ok: false }
  } finally {
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

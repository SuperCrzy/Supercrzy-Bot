/**
 * Device bridge — the server side of the app↔runtime command channel.
 *
 * The Android app polls `data/device/req/*.json` (inside the mounted user-data
 * directory) and answers in `resp/`. Files instead of sockets: the proot runtime
 * mounts that exact directory, so agent tools reach native capabilities
 * (accessibility, WebView) with no ports and no permissions beyond our own
 * private storage.
 */
import { randomUUID } from 'crypto'
import { mkdir, writeFile, readFile, rm, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { config } from '../config'

const deviceDir = () => join(dirname(config.db.path), 'device')

/**
 * 是否有人在监听这条通道（手机 App 起着）。
 *
 * 判据是 App 侧 `DeviceCommandWorker.start()` 建的目录：worker 一起来就 mkdir
 * req/resp，所以目录存在 ≈ 有人在轮询。桌面端从来不会有这个目录。
 * ⚠️ 它只是「可能有人」—— App 被杀后目录会留着，真正的判据仍是调用超时。
 * 用它只是为了在纯桌面环境下**别去走移动分支**，而不是当健康检查。
 */
export function deviceBridgeReady(): boolean {
  return existsSync(join(deviceDir(), 'resp'))
}

export interface DeviceResponse {
  ok: boolean
  data?: unknown
  error?: string
}

/** Sends a command to the app and waits for the answer. Throws on timeout/failure. */
export async function callDevice(
  kind: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<DeviceResponse> {
  const id = randomUUID()
  const reqDir = join(deviceDir(), 'req')
  const respDir = join(deviceDir(), 'resp')
  await mkdir(reqDir, { recursive: true })
  await mkdir(respDir, { recursive: true })

  // Write-then-rename: the app polls this directory, and a half-written JSON file
  // would make it parse garbage and skip the command. rename(2) is atomic on the same
  // filesystem, so the app only ever sees a complete file.
  const reqFile = join(reqDir, `${id}.json`)
  await writeFile(`${reqFile}.tmp`, JSON.stringify({ id, kind, args }, null, 2))
  await rename(`${reqFile}.tmp`, reqFile)

  const respFile = join(respDir, `${id}.json`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    if (existsSync(respFile)) {
      const body = await readFile(respFile, 'utf8').catch(() => '')
      await rm(respFile, { force: true })
      if (!body) break
      const parsed = JSON.parse(body) as DeviceResponse
      if (!parsed.ok) throw new Error(parsed.error || 'device command failed')
      return parsed
    }
  }
  // Stale request must not pile up: the app may appear later.
  await rm(reqFile, { force: true })
  await rm(`${reqFile}.tmp`, { force: true })
  throw new Error(`device command "${kind}" timed out after ${timeoutMs}ms — is the SUPERCRZY app foregrounded with the accessibility service on?`)
}

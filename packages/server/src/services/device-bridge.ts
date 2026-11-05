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
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { config } from '../config'

const deviceDir = () => join(dirname(config.db.path), 'device')

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

  await writeFile(
    join(reqDir, `${id}.json`),
    JSON.stringify({ id, kind, args }, null, 2),
  )

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
  await rm(join(reqDir, `${id}.json`), { force: true })
  throw new Error(`device command "${kind}" timed out after ${timeoutMs}ms — is the SUPERCRZY app foregrounded with the accessibility service on?`)
}

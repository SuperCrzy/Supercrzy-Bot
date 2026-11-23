/** Opt-in real-network smoke check; not part of deterministic CI. */
import { fetchPublicWeb } from '../../src/services/public-web-fetch'

for (const { url, attempts } of [
  { url: 'https://www.baidu.com/', attempts: 3 },
  { url: 'https://example.com/', attempts: 1 },
]) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchPublicWeb(url, AbortSignal.timeout(15000))
      const ok = response.status >= 200 && response.status < 300 && response.text.trim().length > 0
      console.log(`${url} attempt=${attempt} status=${response.status} bytes=${Buffer.byteLength(response.text)} ${ok ? 'OK' : 'FAIL'}`)
      if (!ok) process.exitCode = 1
    } catch (error) {
      console.error(`${url} attempt=${attempt} FAIL: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
}

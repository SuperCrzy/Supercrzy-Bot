import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { requestChat } from './model-client'
import { delayUntilAbort } from './abortable-delay'

let server: Server | undefined
afterEach(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

async function listen(sendHeaders: boolean): Promise<string> {
  server = createServer((_req, res) => {
    if (sendHeaders) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n') }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

describe('model request timeout and cancellation', () => {
  it('times out while waiting for response headers', async () => {
    const baseUrl = await listen(false)
    await expect(requestChat({ baseUrl, apiKey: 'test', body: '{}', timeoutMs: 100 })).rejects.toThrow()
  })

  it('also times out if an established response stream stalls', async () => {
    const baseUrl = await listen(true)
    const response = await requestChat({ baseUrl, apiKey: 'test', body: '{}', timeoutMs: 150 })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await expect(reader.read()).rejects.toThrow()
  })

  it('wakes a retry delay immediately when cancelled', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const waiting = delayUntilAbort(5000, controller.signal)
    controller.abort()
    await waiting
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

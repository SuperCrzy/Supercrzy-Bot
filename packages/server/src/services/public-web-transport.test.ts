import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { beforeEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: mocked.request }))
import { fetchPublicWeb } from './public-web-fetch'

beforeEach(() => {
  mocked.request.mockReset()
  mocked.request.mockImplementation((_url: URL, _options: unknown, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/plain' } })
      callback(response)
      response.end('result')
    }
    return request
  })
})

it('negotiates HTTP/1.1 while retaining the original hostname and pinned public address', async () => {
  const result = await fetchPublicWeb('https://example.com/path?q=1', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }])
  expect(result.text).toBe('result')
  const [url, options] = mocked.request.mock.calls[0]
  expect(url.hostname).toBe('example.com')
  expect(url.pathname).toBe('/path')
  expect(options.ALPNProtocols).toEqual(['http/1.1'])
  const callback = vi.fn()
  options.lookup('example.com', {}, callback)
  expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4)
})

it.each([
  ['response header', 'text/html; charset=gbk', Buffer.concat([Buffer.from('<p>'), Buffer.from('c4e3bac3', 'hex'), Buffer.from('</p>')])],
  ['HTML meta', 'text/html', Buffer.concat([Buffer.from('<meta charset="gb2312"><p>'), Buffer.from('c4e3bac3', 'hex'), Buffer.from('</p>')])],
])('decodes GBK declared by %s even when bytes arrive in chunks', async (_source, contentType, body) => {
  mocked.request.mockImplementationOnce((_url: URL, _options: unknown, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': contentType } })
      callback(response)
      const split = body.indexOf(0xc4) + 1
      response.write(body.subarray(0, split)); response.end(body.subarray(split))
    }
    return request
  })
  const result = await fetchPublicWeb('https://example.com/', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }])
  expect(result.text).toContain('<p>你好</p>')
})

it('falls back to UTF-8 when a server names an unsupported charset', async () => {
  mocked.request.mockImplementationOnce((_url: URL, _options: unknown, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/plain; charset=unknown-encoding' } })
      callback(response); response.end(Buffer.from('正常文本'))
    }
    return request
  })
  const result = await fetchPublicWeb('https://example.com/', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }])
  expect(result.text).toBe('正常文本')
})

it.each([
  ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
] as const)('decompresses %s before decoding the page', async (encoding, compress) => {
  const body = Buffer.concat([Buffer.from('<p>'), Buffer.from('c4e3bac3', 'hex'), Buffer.from('</p>')])
  mocked.request.mockImplementationOnce((_url: URL, _options: unknown, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/html; charset=gbk', 'content-encoding': encoding } })
      callback(response); response.end(compress(body))
    }
    return request
  })
  const result = await fetchPublicWeb('https://example.com/', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }])
  expect(result.text).toBe('<p>你好</p>')
})

it('recognizes gzip without an encoding header on a textual page', async () => {
  mocked.request.mockImplementationOnce((_url: URL, _options: unknown, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/html' } })
      callback(response); response.end(gzipSync(Buffer.from('<p>网页正文</p>')))
    }
    return request
  })
  const result = await fetchPublicWeb('https://example.com/', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }])
  expect(result.text).toBe('<p>网页正文</p>')
})

it('rejects compressed payloads that expand beyond the response limit', async () => {
  mocked.request.mockImplementationOnce((_url: URL, _options: unknown, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } })
      callback(response); response.end(gzipSync(Buffer.alloc(5 * 1024 * 1024 + 1)))
    }
    return request
  })
  await expect(fetchPublicWeb('https://example.com/', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }])).rejects.toThrow('response_too_large')
})

it.each([
  ['gzip', Buffer.from('not a gzip stream'), 'invalid_compressed_response'],
  ['unsupported', Buffer.from('text'), 'unsupported_content_encoding'],
])('rejects invalid or unsupported content encoding %s', async (encoding, body, error) => {
  mocked.request.mockImplementationOnce((_url: URL, _options: unknown, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void }
    request.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/plain', 'content-encoding': encoding } })
      callback(response); response.end(body)
    }
    return request
  })
  await expect(fetchPublicWeb('https://example.com/', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }])).rejects.toThrow(error)
})

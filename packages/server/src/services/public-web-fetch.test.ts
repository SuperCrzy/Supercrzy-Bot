import { describe, expect, it, vi } from 'vitest'
import { fetchPublicWeb, isPublicAddress, resolvePublicTarget } from './public-web-fetch'

describe('public web target validation', () => {
  it.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1'])(
    'rejects non-public address %s', (address) => { expect(isPublicAddress(address)).toBe(false) },
  )
  it('accepts public IPv4 and IPv6 addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  })
  it('rejects private, mixed and malformed DNS answers', async () => {
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])
    await expect(resolvePublicTarget('https://example.com', resolver)).rejects.toThrow('private_target')
    await expect(resolvePublicTarget('http://127.0.0.1')).rejects.toThrow('private_target')
    await expect(resolvePublicTarget('https://name.local')).rejects.toThrow('private_target')
    await expect(resolvePublicTarget('https://example.com', async () => [{ address: '8.8.8.8', family: 6 }])).rejects.toThrow('private_target')
    expect(await resolvePublicTarget('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }])).toMatchObject({ address: { address: '8.8.8.8' } })
  })
  it('rejects a private redirect before opening its connection', async () => {
    const transport = vi.fn(async (_url: URL, _address: { address: string; family: number }, _signal: AbortSignal) => ({ status: 302, location: 'http://127.0.0.1/admin', contentType: '', text: '' }))
    await expect(fetchPublicWeb('https://example.com', new AbortController().signal, async () => [{ address: '8.8.8.8', family: 4 }], transport)).rejects.toThrow('private_target')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][1]).toEqual({ address: '8.8.8.8', family: 4 })
  })
  it('checks DNS again on redirect and rejects rebinding', async () => {
    const resolver = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    const transport = vi.fn(async () => ({ status: 302, location: '/again', contentType: '', text: '' }))
    await expect(fetchPublicWeb('https://example.com', new AbortController().signal, resolver, transport)).rejects.toThrow('private_target')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('reports the validated final URL after a public redirect', async () => {
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
    const transport = vi.fn()
      .mockResolvedValueOnce({ status: 302, location: '/article?id=1', contentType: '', text: '' })
      .mockResolvedValueOnce({ status: 200, contentType: 'text/plain', text: 'article' })
    const response = await fetchPublicWeb('https://example.com/old', new AbortController().signal, resolver, transport)
    expect(response.finalUrl).toBe('https://example.com/article?id=1')
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('stops waiting for DNS on cancellation without opening a connection', async () => {
    const resolver = vi.fn(() => new Promise<Array<{ address: string; family: number }>>(() => {}))
    const transport = vi.fn()
    const controller = new AbortController()
    const pending = fetchPublicWeb('https://example.com/', controller.signal, resolver, transport)
    controller.abort(new Error('cancelled during DNS'))
    await expect(pending).rejects.toThrow('cancelled during DNS')
    expect(transport).not.toHaveBeenCalled()
  })

  it('uses independently resolved public addresses for a fake-IP domain and pins the connection', async () => {
    const system = vi.fn(async () => [{ address: '198.18.0.5', family: 4 }])
    const independent = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
    const transport = vi.fn(async (_url: URL, _address: { address: string; family: number }, _signal: AbortSignal) => ({ status: 200, contentType: 'text/plain', text: 'public content' }))
    await expect(fetchPublicWeb('https://example.com', new AbortController().signal, system, transport, independent)).resolves.toMatchObject({ text: 'public content' })
    expect(independent).toHaveBeenCalledWith('example.com')
    expect(transport.mock.calls[0][1]).toEqual({ address: '8.8.8.8', family: 4 })
    await expect(resolvePublicTarget('https://example.com', async () => [{ address: '198.18.0.5', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }], independent)).resolves.toMatchObject({ address: { address: '8.8.8.8' } })
  })

  it('never accepts fake-IP literals, mixed private answers, or private independent answers', async () => {
    const fake = async () => [{ address: '198.18.0.1', family: 4 }]
    const independent = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }])
    await expect(resolvePublicTarget('http://198.18.0.1', fake, independent)).rejects.toThrow('private_target')
    expect(independent).not.toHaveBeenCalled()
    await expect(resolvePublicTarget('https://example.com', async () => [...await fake(), { address: '10.0.0.1', family: 4 }], independent)).rejects.toThrow('private_target')
    expect(independent).not.toHaveBeenCalled()
    await expect(resolvePublicTarget('https://example.com', fake, independent)).rejects.toThrow('private_target')
    await expect(resolvePublicTarget('https://example.com', fake, async () => { throw new Error('independent_dns_failed') })).rejects.toThrow('fake_ip_dns_unavailable')
  })

  it('rechecks independent DNS on each fake-IP redirect and rejects a private rebound', async () => {
    const fake = vi.fn(async () => [{ address: '198.19.1.2', family: 4 }])
    const independent = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const transport = vi.fn(async () => ({ status: 302, location: '/again', contentType: '', text: '' }))
    await expect(fetchPublicWeb('https://example.com', new AbortController().signal, fake, transport, independent)).rejects.toThrow('private_target')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(independent).toHaveBeenCalledTimes(2)
  })
})

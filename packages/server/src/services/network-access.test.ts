import { describe, expect, it } from 'vitest'
import { allowsDevNoAuth, allowsNetworkApi } from './network-access'

const local = { ip: '127.0.0.1', origin: '', authorization: '', apiToken: '' }

describe('network API access', () => {
  it('allows loopback and the exact development origin', () => {
    expect(allowsNetworkApi(local)).toBe(true)
    expect(allowsNetworkApi({ ...local, origin: 'http://localhost:5173' })).toBe(true)
    expect(allowsNetworkApi({ ...local, origin: 'http://127.0.0.1:3001', port: '3001' })).toBe(true)
    expect(allowsNetworkApi({ ...local, origin: 'http://127.0.0.1:3001', port: '3002' })).toBe(false)
    expect(allowsNetworkApi({ ...local, origin: 'http://localhost:3000', port: '3001' })).toBe(false)
  })
  it('denies remote and untrusted browser origins when no token is configured', () => {
    expect(allowsNetworkApi({ ...local, ip: '192.168.1.2' })).toBe(false)
    expect(allowsNetworkApi({ ...local, origin: 'https://localhost.evil.com' })).toBe(false)
    expect(allowsNetworkApi({ ...local, origin: 'https://attacker.example' })).toBe(false)
  })
  it('requires the configured token for remote requests', () => {
    const remote = { ...local, ip: '192.168.1.2', apiToken: 'secret' }
    expect(allowsNetworkApi(remote)).toBe(false)
    expect(allowsNetworkApi({ ...remote, authorization: 'Bearer wrong' })).toBe(false)
    expect(allowsNetworkApi({ ...remote, authorization: 'Bearer secret' })).toBe(true)
  })
})

describe('development login bypass', () => {
  const local = { enabled: '1', packaged: '0', remoteAddress: '127.0.0.1', requestIp: '127.0.0.1', hostname: 'localhost' }
  it('only accepts a real loopback connection in an unpackaged, explicitly enabled build', () => {
    expect(allowsDevNoAuth(local)).toBe(true)
    expect(allowsDevNoAuth({ ...local, remoteAddress: '::ffff:127.0.0.1', requestIp: '::ffff:127.0.0.1' })).toBe(true)
    expect(allowsDevNoAuth({ ...local, enabled: '0' })).toBe(false)
    expect(allowsDevNoAuth({ ...local, packaged: '1' })).toBe(false)
    expect(allowsDevNoAuth({ ...local, remoteAddress: '192.168.1.4', requestIp: '192.168.1.4' })).toBe(false)
    expect(allowsDevNoAuth({ ...local, remoteAddress: '192.168.1.4' })).toBe(false)
    expect(allowsDevNoAuth({ ...local, requestIp: '192.168.1.4' })).toBe(false)
    expect(allowsDevNoAuth({ ...local, hostname: 'localhost.attacker.example' })).toBe(false)
  })
})

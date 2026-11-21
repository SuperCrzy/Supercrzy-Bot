/**
 * Guards the two things that can go wrong in the relay spec without anyone
 * noticing: an ssh target that is really an ssh option, and a port that cannot
 * be a port. Both are read straight from a settings row, so a typo — or a
 * malicious value — reaches argv unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const readSpec = vi.fn<() => string>()

vi.mock('./database', () => ({
    getDB: () => ({
        prepare: () => ({ get: () => ({ value: readSpec() }) }),
    }),
}))

const spawnMock = vi.fn((..._args: unknown[]) => ({ on: vi.fn(), kill: vi.fn(), exitCode: null }))
vi.mock('node:child_process', () => ({ spawn: (...a: any[]) => (spawnMock as any)(...a) }))

/**
 * Random high port per call. The first version of this test reused 18080 and
 * passed for the wrong reason: a tunnel left over from a debugging session was
 * already listening there, so tick() returned early at the "port is open"
 * check and spawn was never reached — the validation looked like it worked
 * even with the guard removed. A fresh port keeps the ambient state out.
 */
let nextPort = 39000 + Math.floor(Math.random() * 20000)
function freshSpec(target: string): string {
    nextPort += 1
    return `127.0.0.1:${nextPort}:10.0.0.1:8080|${target}`
}

async function runOneTick(spec: string) {
    readSpec.mockReturnValue(spec)
    const mod = await import('./searxng-tunnel')
    mod.startSearxngTunnel()
    // tick() runs synchronously up to the port probe; give the microtask queue
    // a turn so the awaited probe resolves before we assert.
    await new Promise(r => setTimeout(r, 60))
    mod.stopSearxngTunnel()
}

describe('searxng tunnel spec validation', () => {
    beforeEach(() => { spawnMock.mockClear() })
    afterEach(() => { vi.resetModules() })

    it('rejects an ssh option smuggled in as the target', async () => {
        await runOneTick(freshSpec('-oProxyCommand=touch /tmp/pwned'))
        expect(spawnMock).not.toHaveBeenCalled()
    })

    it('rejects a target with shell metacharacters', async () => {
        await runOneTick(freshSpec('root@host;rm -rf /'))
        expect(spawnMock).not.toHaveBeenCalled()
    })

    it('rejects a port that is not a port', async () => {
        await runOneTick(`127.0.0.1:99999:10.0.0.1:8080|root@relay.example.com`)
        expect(spawnMock).not.toHaveBeenCalled()
    })

    it('accepts a plain user@host target', async () => {
        const spec = freshSpec('root@relay.example.com')
        const localPart = spec.split('|')[0]
        await runOneTick(spec)
        expect(spawnMock).toHaveBeenCalled()
        const args = (spawnMock.mock.calls[0] as any)[1] as string[]
        expect(args).toContain('-L')
        expect(args).toContain(localPart)
        expect(args[args.length - 1]).toBe('root@relay.example.com')
    })

    it('does nothing at all when the setting is empty', async () => {
        await runOneTick('')
        expect(spawnMock).not.toHaveBeenCalled()
    })
})

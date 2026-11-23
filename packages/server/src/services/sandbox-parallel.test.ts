import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { detectSandboxExec, sandboxify } from './sandbox'

describe('parallel sandbox profiles', () => {
  it.skipIf(process.platform !== 'darwin')('runs independent real sandboxed commands without reading a partially written profile', async (context) => {
    if (!await detectSandboxExec()) context.skip()
    const commands = await Promise.all(Array.from({ length: 12 }, () => sandboxify('printf sandbox-ok')))
    expect(commands.every(command => command.sandboxed && command.args?.[0] === '-p')).toBe(true)
    const results = await Promise.all(commands.map(command => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(command.exec, command.args!, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', err = ''
      child.stdout.on('data', chunk => { out += chunk.toString() })
      child.stderr.on('data', chunk => { err += chunk.toString() })
      child.on('error', reject)
      child.on('close', code => resolve({ code, out, err }))
    })))
    expect(results).toEqual(Array.from({ length: 12 }, () => ({ code: 0, out: 'sandbox-ok', err: '' })))
  })
})

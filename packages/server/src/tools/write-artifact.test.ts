import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeArtifact, registerArtifact, artifactName } from './write-artifact'

let dir: string

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'))
})
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
})

function ctxSpy() {
    const rows: any[] = []
    return { rows, ctx: { onArtifacts: (files: any[]) => rows.push(...files) } as any }
}

describe('writeArtifact', () => {
    it('writes the file and reports it as created', async () => {
        const file = path.join(dir, 'a.txt')
        const { rows, ctx } = ctxSpy()
        const r = await writeArtifact(ctx, file, 'hello')
        expect(fs.readFileSync(file, 'utf8')).toBe('hello')
        expect(r).toEqual({ action: 'created', size: 5 })
        expect(rows).toEqual([{ name: 'a.txt', path: file, action: 'created', size: 5 }])
    })

    it('reports updated when previous content is known', async () => {
        const file = path.join(dir, 'b.txt')
        fs.writeFileSync(file, 'old')
        const { rows, ctx } = ctxSpy()
        await writeArtifact(ctx, file, 'new content', { previous: 'old' })
        expect(rows[0].action).toBe('updated')
    })

    it('reports an existing empty file as updated', async () => {
        const file = path.join(dir, 'empty.txt')
        fs.writeFileSync(file, '')
        const { rows, ctx } = ctxSpy()
        await writeArtifact(ctx, file, 'new', { previous: '' })
        expect(rows[0].action).toBe('updated')
    })

    it('reports the on-disk byte size for multi-byte text', async () => {
        const file = path.join(dir, 'cn.txt')
        const { rows, ctx } = ctxSpy()
        await writeArtifact(ctx, file, '中文')
        // 6 bytes, not 2 characters
        expect(rows[0].size).toBe(6)
    })

    it('handles binary payloads with a known size', async () => {
        const file = path.join(dir, 'x.bin')
        const buf = Buffer.from([1, 2, 3, 4, 5])
        const { rows, ctx } = ctxSpy()
        await writeArtifact(ctx, file, buf, { size: buf.length })
        expect(rows[0].size).toBe(5)
        expect(fs.readFileSync(file).length).toBe(5)
    })

    it('reports nothing when the write itself fails', async () => {
        // The artifact row must never exist for a file that was not written.
        const { rows, ctx } = ctxSpy()
        await expect(writeArtifact(ctx, path.join(dir, 'missing-dir', 'nope.txt'), 'x')).rejects.toThrow()
        expect(rows).toHaveLength(0)
    })

    it('still resolves when onArtifacts throws', async () => {
        // Bookkeeping must not break a successful write.
        const ctx = { onArtifacts: () => { throw new Error('boom') } } as any
        const file = path.join(dir, 'c.txt')
        await expect(writeArtifact(ctx, file, 'ok')).resolves.toEqual({ action: 'created', size: 2 })
        expect(fs.existsSync(file)).toBe(true)
    })

    it('works without a context', async () => {
        const file = path.join(dir, 'd.txt')
        await expect(writeArtifact(undefined, file, 'x')).resolves.toEqual({ action: 'created', size: 1 })
    })
})

describe('registerArtifact', () => {
    it('reports without touching the filesystem', () => {
        const { rows, ctx } = ctxSpy()
        registerArtifact(ctx, '/tmp/already-written.mp4', { action: 'created', size: 1234 })
        expect(rows).toEqual([{ name: 'already-written.mp4', path: '/tmp/already-written.mp4', action: 'created', size: 1234 }])
    })

    it('is a no-op without a context', () => {
        expect(() => registerArtifact(undefined, '/tmp/x', { action: 'created', size: 1 })).not.toThrow()
    })
})

describe('artifactName', () => {
    it('handles both separators', () => {
        expect(artifactName('/a/b/c.txt')).toBe('c.txt')
        expect(artifactName('C:\\Users\\x\\d.txt')).toBe('d.txt')
    })
})

/**
 * Windows cmd writes the console code page (GBK on zh-CN), so decoding its
 * output as UTF-8 produced "���Ĳ���" for "中文测试". These tests pin the
 * fallback rule: UTF-8 when the bytes are valid UTF-8, GBK otherwise.
 */
import { describe, it, expect } from 'vitest'
import { decodeConsoleOutput } from './shell-exec'

// "中文测试" encoded as GBK.
const GBK_SAMPLE = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
// The same text encoded as UTF-8.
const UTF8_SAMPLE = Buffer.from('中文测试', 'utf8')

describe('decodeConsoleOutput', () => {
    it('decodes a GBK buffer on Windows', () => {
        expect(decodeConsoleOutput(GBK_SAMPLE, 'win32')).toBe('中文测试')
    })

    it('keeps UTF-8 intact on Windows when the tool emits UTF-8', () => {
        // git and node write UTF-8 even on Windows; the fallback must not touch it.
        expect(decodeConsoleOutput(UTF8_SAMPLE, 'win32')).toBe('中文测试')
    })

    it('leaves ASCII alone on Windows', () => {
        expect(decodeConsoleOutput(Buffer.from('plain ascii', 'utf8'), 'win32')).toBe('plain ascii')
    })

    it('never applies the GBK fallback off Windows', () => {
        // On macOS/Linux a GBK-looking buffer is just invalid UTF-8; silently
        // reinterpreting it would corrupt binary output piped through a shell.
        const out = decodeConsoleOutput(GBK_SAMPLE, 'darwin')
        expect(out).not.toBe('中文测试')
    })
})

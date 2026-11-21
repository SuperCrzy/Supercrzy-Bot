/**
 * The single place where a tool turns bytes into a file.
 *
 * Why this exists (2026-11-21): writing a file and reporting it as an artifact
 * used to be two independent steps, so "did you also call ctx.onArtifacts?" was
 * a thing every tool author had to remember. Three tools forgot
 * (file_write, multi_edit, android_screen), the artifacts table stayed empty,
 * and the right panel's "session artifacts" group had nothing to show for
 * months. WorkBuddy solves the same problem with a unified artifact writer —
 * write and register are one call, so partial omission cannot happen by
 * accident. This is the same idea, local-first: one helper, no cloud.
 *
 * What it does NOT do: diff display (that stays with onFileChange, because the
 * old/new pair is content, not a file) and permission/sandbox checks (the
 * caller has already resolved and validated the path).
 *
 * Usage:
 *   await writeArtifact(ctx, path, content, { previous: oldContent })
 */
import { writeFile, stat } from 'fs/promises'
import type { ToolContext } from './types'

export interface WriteArtifactOptions {
    /**
     * Previous content, when the caller already read it. Used only to tell
     * 'updated' from 'created' without a second filesystem probe.
     */
    previous?: string | null
    /** Byte length, when already known (e.g. a decoded buffer). Skips the stat. */
    size?: number
}

export interface WriteArtifactResult {
    action: 'created' | 'updated'
    size: number
}

/** Path segment as a display name, for both separators. */
export function artifactName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath
}

/**
 * Register a file that has already been written.
 *
 * Split out because file_write streams its content in chunks to animate the code
 * growing in the tool card; it still needs to register, and it already knows the
 * byte length. Prefer writeArtifact unless you genuinely write in pieces.
 */
export function registerArtifact(
    ctx: ToolContext | undefined,
    filePath: string,
    options: { action: 'created' | 'updated'; size: number },
): void {
    if (!ctx?.onArtifacts) return
    try {
        ctx.onArtifacts([{ name: artifactName(filePath), path: filePath, action: options.action, size: options.size }])
    } catch { /* bookkeeping only */ }
}

/**
 * Write the file and register it as a session artifact.
 *
 * The write happens first: if it throws, nothing is reported, so a failed write
 * can never leave a phantom row in the artifacts table.
 */
export async function writeArtifact(
    ctx: ToolContext | undefined,
    filePath: string,
    content: string | Uint8Array,
    options: WriteArtifactOptions = {},
): Promise<WriteArtifactResult> {
    await writeFile(filePath, content)

    const action: 'created' | 'updated' = options.previous ? 'updated' : 'created'

    let size = options.size
    if (size === undefined) {
        size = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength
        // The on-disk size is what the panel shows; stat only when it is cheap
        // to be exact, and fall back to the buffer length if it fails.
        try { size = (await stat(filePath)).size } catch { /* keep the computed size */ }
    }

    registerArtifact(ctx, filePath, { action, size })

    return { action, size }
}

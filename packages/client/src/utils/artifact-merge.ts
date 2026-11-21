import type { ChatMessage } from '@/types'

export interface ArtifactRow {
    id?: string
    name: string
    path: string
    mime?: string
    size?: number
}

/**
 * Merge the two artifact sources the right panel can see.
 *
 * They exist for different reasons and neither is sufficient alone:
 *   - the session list (`GET /api/sessions/:id/artifacts`) is durable, so the
 *     group survives a reload;
 *   - `msg.deliverySummary.artifacts` is available the instant a turn finishes,
 *     before the list refetch lands, so a fresh artifact is not missing for a
 *     second.
 *
 * Deduplicated by path, session list first: it carries the row id that the
 * reveal/preview endpoints need, and deliverySummary entries do not.
 */
export function mergeArtifactRows(
    sessionRows: ReadonlyArray<Partial<ArtifactRow>> | null | undefined,
    messages: ReadonlyArray<Partial<ChatMessage>> | null | undefined,
): ArtifactRow[] {
    const seen = new Set<string>()
    const rows: ArtifactRow[] = []
    const push = (a: Partial<ArtifactRow> | undefined | null) => {
        if (!a?.path || seen.has(a.path)) return
        seen.add(a.path)
        rows.push({
            id: a.id,
            name: a.name || a.path.split(/[\\/]/).pop() || a.path,
            path: a.path,
            mime: a.mime,
            size: a.size,
        })
    }
    for (const a of sessionRows || []) push(a)
    for (const m of messages || []) {
        if (m?.role !== 'assistant') continue
        for (const a of m.deliverySummary?.artifacts || []) push(a)
    }
    return rows
}

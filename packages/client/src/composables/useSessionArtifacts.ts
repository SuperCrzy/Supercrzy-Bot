/**
 * Session artifacts for the right panel: the list, and the context menu that
 * acts on a row.
 *
 * Kept out of DetailPanel.vue because that file has a hard line budget
 * (file-size-guard.test.ts) and the artifact plumbing alone was 150 lines.
 *
 * Two sources are merged, see mergeArtifactRows: the durable session list and
 * the per-turn deliverySummary.
 */
import { ref, computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { mergeArtifactRows, type ArtifactRow } from '@/utils/artifact-merge'

export interface UseSessionArtifactsOptions {
    sessionId: () => string | null | undefined
    visible: () => boolean
    activeTab: () => string
    messages: () => ReadonlyArray<any>
    /** Open a file preview for this path. */
    preview: (path: string) => Promise<void> | void
    /** Fallback when the OS reveal call is unavailable: show the folder in the tree. */
    openDir: (filePath: string) => Promise<void> | void
}

export function useSessionArtifacts(opts: UseSessionArtifactsOptions) {
    const sessionArtifacts = ref<ArtifactRow[]>([])

    async function loadSessionArtifacts() {
        const sid = opts.sessionId()
        if (!sid) { sessionArtifacts.value = []; return }
        try {
            const r = await fetch(`/api/sessions/${sid}/artifacts`)
            if (!r.ok) { sessionArtifacts.value = []; return }
            const rows = await r.json()
            sessionArtifacts.value = Array.isArray(rows) ? rows : []
        } catch {
            sessionArtifacts.value = []
        }
    }

    watch(() => opts.sessionId(), () => { void loadSessionArtifacts() }, { immediate: true })
    watch(() => opts.visible(), (v) => { if (v) void loadSessionArtifacts() })
    watch(() => opts.activeTab(), (tab) => { if (tab === 'files') void loadSessionArtifacts() })
    // A finished turn grows the message list; that is when new artifacts appear.
    watch(() => opts.messages().length, () => {
        if (opts.visible()) void loadSessionArtifacts()
    })

    const artifactFiles = computed<ArtifactRow[]>(() =>
        mergeArtifactRows(sessionArtifacts.value, opts.messages() as any),
    )

    // ----- Context menu -----
    const artifactMenu = reactive<{ open: boolean; x: number; y: number; item: ArtifactRow | null }>({
        open: false, x: 0, y: 0, item: null,
    })

    function openArtifactMenu(e: MouseEvent, item: ArtifactRow) {
        artifactMenu.item = item
        // Anchor at the pointer, then keep the menu inside the viewport.
        artifactMenu.x = Math.min(e.clientX, window.innerWidth - 180)
        artifactMenu.y = Math.min(e.clientY, window.innerHeight - 110)
        artifactMenu.open = true
    }
    function closeArtifactMenu() { artifactMenu.open = false }

    function onDocClick() { if (artifactMenu.open) closeArtifactMenu() }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeArtifactMenu() }

    onMounted(() => {
        document.addEventListener('click', onDocClick)
        document.addEventListener('keydown', onKey)
        window.addEventListener('blur', closeArtifactMenu)
    })
    onBeforeUnmount(() => {
        document.removeEventListener('click', onDocClick)
        document.removeEventListener('keydown', onKey)
        window.removeEventListener('blur', closeArtifactMenu)
    })

    async function menuPreviewArtifact() {
        const a = artifactMenu.item
        closeArtifactMenu()
        if (a) await opts.preview(a.path)
    }

    /**
     * Reveal in Finder/Explorer. The endpoint is keyed by the artifact row id,
     * which only the session list carries; an artifact known from
     * deliverySummary alone has none until the next list fetch. Refresh once,
     * then fall back to showing the folder rather than failing silently.
     */
    async function menuRevealArtifact() {
        const target = artifactMenu.item
        closeArtifactMenu()
        if (!target) return
        const sid = opts.sessionId()
        if (!sid) return
        let row = sessionArtifacts.value.find(x => x.path === target.path && x.id)
        if (!row) {
            await loadSessionArtifacts()
            row = sessionArtifacts.value.find(x => x.path === target.path && x.id)
        }
        if (!row?.id) { await opts.openDir(target.path); return }
        try {
            const r = await fetch(`/api/sessions/${sid}/artifacts/${row.id}/open`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reveal: true }),
            })
            if (!r.ok) {
                const d = await r.json().catch(() => ({}))
                console.warn('[artifact] reveal failed:', (d as any)?.error || r.status)
                await opts.openDir(target.path)
            }
        } catch (err) {
            console.warn('[artifact] reveal failed:', err)
            await opts.openDir(target.path)
        }
    }

    async function menuCopyPath() {
        const a = artifactMenu.item
        closeArtifactMenu()
        if (!a) return
        try { await navigator.clipboard.writeText(a.path) } catch { /* clipboard denied */ }
    }

    return {
        sessionArtifacts,
        artifactFiles,
        loadSessionArtifacts,
        artifactMenu,
        openArtifactMenu,
        closeArtifactMenu,
        menuPreviewArtifact,
        menuRevealArtifact,
        menuCopyPath,
    }
}

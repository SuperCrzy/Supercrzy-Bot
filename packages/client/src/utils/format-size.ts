/** Human-readable byte size for file rows. Shared so the file tree and the
 *  artifact group cannot drift apart. */
export function formatSize(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    const v = bytes / Math.pow(1024, i)
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

import Database from 'better-sqlite3'
import { linkSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/** Copy a consistent SQLite snapshot, including committed WAL transactions.
 * The destination is installed without replacing an existing database.
 */
export function migrateLegacyDatabase(sourcePath: string, destinationPath: string): void {
  const temporaryPath = `${destinationPath}.migration-${randomUUID()}`
  let source: Database.Database | undefined
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true })
    source.prepare('VACUUM INTO ?').run(temporaryPath)
    // Both files are in the same directory. Unlike rename, link cannot replace
    // a destination created by another process while the snapshot was made.
    linkSync(temporaryPath, destinationPath)
  } finally {
    source?.close()
    try { unlinkSync(temporaryPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

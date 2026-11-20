import { initDatabase, getDB } from '../../src/services/database.js'
import { migrateSearchSettings } from '../../src/services/search-settings-migration.js'
initDatabase()
const db = getDB()
const set = (k: string, v: string) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v)
const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) as any)?.value

// Simulate the broken state found on the Windows machine.
set('searxngUrl', 'http://116.181.17.27/searxng')
set('searxngUrlGlobal', 'http://116.181.17.27/searxng')
db.prepare("DELETE FROM settings WHERE key='searchSettingsMigratedV2'").run()
console.log('before:', get('searxngUrl'), '|', JSON.stringify(get('searxngUrlGlobal')))

migrateSearchSettings()
console.log('after :', get('searxngUrl'), '|', JSON.stringify(get('searxngUrlGlobal')))
console.log('marker:', get('searchSettingsMigratedV2'))

// Second run must be a no-op even if someone sets a bad value back.
set('searxngUrl', 'http://116.181.17.27/searxng')
migrateSearchSettings()
console.log('rerun :', get('searxngUrl'), '(marker set -> untouched, expected)')

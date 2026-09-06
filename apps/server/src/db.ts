import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sqliteVec from 'sqlite-vec'

const here = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DATA_DIR ?? join(here, '..', 'data')
export const UPLOADS_DIR = join(DATA_DIR, 'uploads')
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1024)

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })

export const db = new Database(join(DATA_DIR, 'open-sesame.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

sqliteVec.load(db)

export function runMigrations(): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const dir = join(here, 'migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  let version = current
  for (const file of files) {
    const target = Number(file.split('_')[0])
    if (target <= version) continue
    db.transaction(() => {
      db.exec(readFileSync(join(dir, file), 'utf8'))
      db.pragma(`user_version = ${target}`)
    })()
    version = target
  }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrations.js'
import { Repository } from './repository.js'
import { seedIfEmpty } from './seed.js'

/**
 * Default directory for the local brain database. On Linux this matches the
 * Electron app's `userData` (`~/.config/@the-brain/desktop`) so the desktop app,
 * the MCP server, and the HTTP API all share a single brain file.
 */
export function defaultBrainDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, '@the-brain', 'desktop')
}

/** Resolve the brain database file, honoring the BRAIN_DB_PATH override. */
export function defaultBrainFile(): string {
  return process.env.BRAIN_DB_PATH || path.join(defaultBrainDir(), 'brain.db')
}

/**
 * Open (creating, migrating, and first-run seeding) a Repository at the given
 * SQLite file. Uses WAL + busy_timeout so the desktop app and an agent-facing
 * server can safely share the same file concurrently.
 */
export function openRepository(file: string = defaultBrainFile()): Repository {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  const repo = new Repository(db)
  seedIfEmpty(repo)
  return repo
}

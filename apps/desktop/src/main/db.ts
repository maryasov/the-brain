import path from 'node:path'
import { app } from 'electron'
import { openRepository, type Repository } from '@the-brain/db'

let repo: Repository | undefined

/**
 * Lazily open (and migrate + seed) the local-first brain database. The heavy
 * lifting lives in @the-brain/db so the exact same data layer also backs the
 * MCP server and the HTTP API; here we only supply Electron's userData path.
 */
export function getRepository(): Repository {
  if (repo) return repo
  const file = path.join(app.getPath('userData'), 'brain.db')
  repo = openRepository(file)
  return repo
}

export function closeDb(): void {
  repo?.close()
  repo = undefined
}

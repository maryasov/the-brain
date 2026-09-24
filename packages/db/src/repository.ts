import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  rowToAttachment,
  rowToLink,
  rowToSet,
  rowToThought,
  type AddAttachmentInput,
  type Attachment,
  type AttachmentRow,
  type CreateSetInput,
  type CreateThoughtInput,
  type DeleteOptions,
  type Link,
  type LinkInput,
  type LinkRow,
  type LinkType,
  type Neighborhood,
  type SearchHit,
  type SetDef,
  type Tag,
  type Thought,
  type ThoughtRow,
  type ThoughtSet,
  type ThoughtSetRow,
  type UpdateThoughtInput
} from '@the-brain/shared'

const now = () => Date.now()

/**
 * Thin, synchronous repository over better-sqlite3. All logic beyond plain
 * persistence (role classification, layout) lives in @the-brain/core so it can
 * be unit-tested without a database. This package is Electron-free so the same
 * data layer can back the desktop app, the MCP server, and the HTTP API.
 */
export class Repository {
  constructor(private readonly db: Database.Database) {}

  /** Close the underlying database connection. */
  close(): void {
    this.db.close()
  }

  // ---- reads -------------------------------------------------------------

  isEmpty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number }
    return row.n === 0
  }

  getThought(id: string): Thought | null {
    const row = this.db.prepare('SELECT * FROM thoughts WHERE id = ?').get(id) as
      ThoughtRow | undefined
    return row ? rowToThought(row) : null
  }

  getNeighborhood(focusId: string): Neighborhood | null {
    const focus = this.getThought(focusId)
    if (!focus) return null

    const parents = this.ids(
      "SELECT from_id AS id FROM links WHERE type='child' AND to_id = ?",
      focusId
    )
    const children = this.ids(
      "SELECT to_id AS id FROM links WHERE type='child' AND from_id = ?",
      focusId
    )
    const jumps = this.ids(
      "SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS id FROM links WHERE type='jump' AND (from_id = ? OR to_id = ?)",
      focusId,
      focusId,
      focusId
    )
    // Siblings: other children of the focus's parents, excluding focus itself.
    const siblingRows = parents.length
      ? (this.db
          .prepare(
            `SELECT DISTINCT c.to_id AS id
                 FROM links p
                 JOIN links c ON c.from_id = p.from_id AND c.type = 'child'
                WHERE p.type = 'child' AND p.to_id = ? AND c.to_id <> ?`
          )
          .all(focusId, focusId) as Array<{ id: string }>)
      : []
    const siblings = siblingRows.map((r) => r.id)

    const neighborIds = new Set<string>([...parents, ...children, ...jumps, ...siblings])
    const thoughts = [focus, ...this.thoughtsByIds([...neighborIds])]

    // Only return links whose BOTH endpoints are in the neighborhood set.
    const scope = [...new Set([focusId, ...neighborIds])]
    const links = this.linksWithin(scope)

    return { focus, thoughts, links }
  }

  search(query: string): SearchHit[] {
    const match = buildFtsQuery(query)
    if (!match) return []
    const rows = this.db
      .prepare(
        `SELECT thought_id AS id,
                name,
                snippet(thoughts_fts, 2, '[', ']', ' … ', 12) AS snippet
           FROM thoughts_fts
          WHERE thoughts_fts MATCH ?
          LIMIT 50`
      )
      .all(match) as Array<{ id: string; name: string; snippet: string | null }>
    return rows.map((r) => ({ id: r.id, name: r.name, snippet: r.snippet }))
  }

  listPinned(): Thought[] {
    const rows = this.db
      .prepare('SELECT * FROM thoughts WHERE pinned = 1 ORDER BY updated_at DESC')
      .all() as ThoughtRow[]
    return rows.map(rowToThought)
  }

  /** Most recently created/updated thoughts (the timeline / "Quiet Eye"). */
  listRecent(limit = 24): Thought[] {
    const rows = this.db
      .prepare('SELECT * FROM thoughts ORDER BY updated_at DESC, created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as ThoughtRow[]
    return rows.map(rowToThought)
  }

  /**
   * Thoughts reachable within `depth` link-hops of a center (both link
   * directions), plus the links among them — the data behind the minimap.
   */
  getSubgraph(centerId: string, depth = 2): Neighborhood | null {
    const focus = this.getThought(centerId)
    if (!focus) return null
    const rows = this.db
      .prepare(
        `WITH RECURSIVE reach(id, dist) AS (
           SELECT :center, 0
           UNION
           SELECT CASE WHEN l.from_id = reach.id THEN l.to_id ELSE l.from_id END, reach.dist + 1
             FROM reach JOIN links l ON l.from_id = reach.id OR l.to_id = reach.id
            WHERE reach.dist < :depth
         )
         SELECT id, MIN(dist) AS dist FROM reach GROUP BY id`
      )
      .all({ center: centerId, depth: Math.max(1, Math.min(3, depth)) }) as Array<{
      id: string
      dist: number
    }>
    const ids = rows.map((r) => r.id)
    return { focus, thoughts: this.thoughtsByIds(ids), links: this.linksWithin(ids) }
  }

  listTags(thoughtId: string): Tag[] {
    return this.db
      .prepare(
        `SELECT t.id, t.name
           FROM tags t
           JOIN thought_tags tt ON tt.tag_id = t.id
          WHERE tt.thought_id = ?
          ORDER BY t.name`
      )
      .all(thoughtId) as Tag[]
  }

  addTag(thoughtId: string, name: string): Tag[] {
    const clean = name.trim()
    if (!clean) return this.listTags(thoughtId)
    const existing = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(clean) as
      { id: string } | undefined
    const tagId = existing ? existing.id : randomUUID()
    if (!existing) {
      this.db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(tagId, clean)
    }
    this.db
      .prepare('INSERT OR IGNORE INTO thought_tags (thought_id, tag_id) VALUES (?, ?)')
      .run(thoughtId, tagId)
    return this.listTags(thoughtId)
  }

  removeTag(thoughtId: string, tagId: string): Tag[] {
    this.db
      .prepare('DELETE FROM thought_tags WHERE thought_id = ? AND tag_id = ?')
      .run(thoughtId, tagId)
    return this.listTags(thoughtId)
  }

  // ---- filtered sets -------------------------------------------------------

  listSets(): ThoughtSet[] {
    const rows = this.db
      .prepare('SELECT * FROM sets ORDER BY name COLLATE NOCASE')
      .all() as ThoughtSetRow[]
    return rows.map(rowToSet)
  }

  getSet(id: string): ThoughtSet | null {
    const row = this.db.prepare('SELECT * FROM sets WHERE id = ?').get(id) as
      | ThoughtSetRow
      | undefined
    return row ? rowToSet(row) : null
  }

  createSet(input: CreateSetInput): ThoughtSet {
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO sets (id, name, description, def_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.name.trim() || 'Untitled set',
        input.description?.trim() || null,
        JSON.stringify(sanitizeSetDef(input.def)),
        now(),
        now()
      )
    return this.getSet(id)!
  }

  deleteSet(id: string): void {
    this.db.prepare('DELETE FROM sets WHERE id = ?').run(id)
  }

  /**
   * Execute a saved set definition against the whole brain: optional FTS text,
   * exact (case-insensitive) type, and tag name — AND-ed, newest first.
   */
  runSetDef(def: SetDef, limit = 200): Thought[] {
    const where: string[] = []
    const params: Record<string, unknown> = { limit: Math.max(1, Math.min(500, limit)) }
    if (def.text) {
      const match = buildFtsQuery(def.text)
      if (match) {
        where.push('id IN (SELECT thought_id FROM thoughts_fts WHERE thoughts_fts MATCH @match)')
        params.match = match
      }
    }
    if (def.type) {
      where.push('LOWER(type) = LOWER(@type)')
      params.type = def.type
    }
    if (def.tag) {
      where.push(
        `id IN (SELECT tt.thought_id FROM thought_tags tt
                 JOIN tags t ON t.id = tt.tag_id
                WHERE LOWER(t.name) = LOWER(@tag))`
      )
      params.tag = def.tag
    }
    const sql = `SELECT * FROM thoughts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY updated_at DESC LIMIT @limit`
    const rows = this.db.prepare(sql).all(params) as ThoughtRow[]
    return rows.map(rowToThought)
  }

  runSet(id: string): Thought[] {
    const set = this.getSet(id)
    return set ? this.runSetDef(set.def) : []
  }

  // ---- attachments ---------------------------------------------------------

  listAttachments(thoughtId: string): Attachment[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE thought_id = ? ORDER BY created_at')
      .all(thoughtId) as AttachmentRow[]
    return rows.map(rowToAttachment)
  }

  addAttachment(input: AddAttachmentInput): Attachment {
    const uri = input.uri.trim()
    if (!uri) throw new Error('attachment requires a uri')
    if (!this.getThought(input.thoughtId)) {
      throw new Error(`thought ${input.thoughtId} not found`)
    }
    if (input.kind === 'thought' && !this.getThought(uri)) {
      throw new Error(`anchor thought ${uri} not found`)
    }
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO attachments (id, thought_id, kind, uri, label, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.thoughtId, input.kind, uri, input.label?.trim() || null, input.mime ?? null, now())
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow
    return rowToAttachment(row)
  }

  removeAttachment(thoughtId: string, id: string): Attachment[] {
    this.db
      .prepare('DELETE FROM attachments WHERE id = ? AND thought_id = ?')
      .run(id, thoughtId)
    return this.listAttachments(thoughtId)
  }

  /** Shared app-view state (key 'focus' drives the desktop window via API/MCP). */
  setAppState(key: string, value: string | null): void {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now())
  }

  getAppState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined
    return row?.value ?? null
  }

  // ---- writes ------------------------------------------------------------

  createThought(input: CreateThoughtInput): Thought {
    const id = randomUUID()
    const ts = now()
    const insert = this.db.prepare(
      `INSERT INTO thoughts (id, name, description, color, type, pinned, archived, created_at, updated_at)
       VALUES (@id, @name, @description, @color, @type, 0, 0, @created_at, @updated_at)`
    )
    const write = this.db.transaction(() => {
      insert.run({
        id,
        name: input.name.trim() || 'Untitled',
        description: input.description ?? null,
        color: input.color ?? null,
        type: input.type?.trim() || null,
        created_at: ts,
        updated_at: ts
      })
      if (input.parentId) {
        this.insertLink(input.parentId, id, input.linkType ?? 'child')
      }
    })
    write()
    return this.getThought(id)!
  }

  updateThought(input: UpdateThoughtInput): Thought {
    const fields: string[] = []
    const params: Record<string, unknown> = { id: input.id, updated_at: now() }
    for (const key of ['name', 'description', 'color', 'type', 'pinned'] as const) {
      if (input[key] !== undefined) {
        fields.push(`${key} = @${key}`)
        params[key] =
          key === 'pinned'
            ? input.pinned
              ? 1
              : 0
            : key === 'type'
              ? input.type?.trim() || null
              : input[key]
      }
    }
    if (fields.length) {
      this.db
        .prepare(
          `UPDATE thoughts SET ${fields.join(', ')}, updated_at = @updated_at WHERE id = @id`
        )
        .run(params)
    }
    return this.getThought(input.id)!
  }

  setPinned(id: string, pinned: boolean): Thought {
    this.db
      .prepare('UPDATE thoughts SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, now(), id)
    return this.getThought(id)!
  }

  deleteThought(id: string, options: DeleteOptions): void {
    if (options.mode === 'detach') {
      this.db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(id, id)
      return
    }
    // cascade: delete focus plus descendants whose only parents are all doomed.
    const doomed = this.computeCascade(id)
    const del = this.db.transaction(() => {
      const placeholders = doomed.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM thoughts WHERE id IN (${placeholders})`).run(...doomed)
    })
    del()
  }

  link(input: LinkInput): Link {
    const from = input.fromId < input.toId ? input.fromId : input.toId
    const to = input.fromId < input.toId ? input.toId : input.fromId
    // Normalize jump direction so a<->b and b<->a collapse to one row.
    const [a, b] = input.type === 'jump' ? [from, to] : [input.fromId, input.toId]
    return this.insertLink(a, b, input.type) ?? this.findLink(a, b, input.type)!
  }

  unlink(fromId: string, toId: string, type: LinkType): void {
    if (type === 'jump') {
      this.db
        .prepare(
          "DELETE FROM links WHERE type='jump' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))"
        )
        .run(fromId, toId, toId, fromId)
    } else {
      this.db
        .prepare("DELETE FROM links WHERE type='child' AND from_id=? AND to_id=?")
        .run(fromId, toId)
    }
  }

  getOrCreateRoot(): Thought {
    const existing = this.db
      .prepare("SELECT * FROM thoughts WHERE name = 'My Brain' LIMIT 1")
      .get() as ThoughtRow | undefined
    if (existing) return rowToThought(existing)
    return this.createThought({ name: 'My Brain' })
  }

  // ---- helpers -----------------------------------------------------------

  private ids(sql: string, ...params: unknown[]): string[] {
    return (this.db.prepare(sql).all(...params) as Array<{ id: string }>).map((r) => r.id)
  }

  private thoughtsByIds(ids: string[]): Thought[] {
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM thoughts WHERE id IN (${placeholders})`)
      .all(...ids) as ThoughtRow[]
    return rows.map(rowToThought)
  }

  private linksWithin(ids: string[]): Link[] {
    if (!ids.length) return []
    const ph = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM links WHERE from_id IN (${ph}) AND to_id IN (${ph})`)
      .all(...ids, ...ids) as LinkRow[]
    return rows.map(rowToLink)
  }

  private insertLink(fromId: string, toId: string, type: LinkType): Link | null {
    if (fromId === toId) return null
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT OR IGNORE INTO links (id, from_id, to_id, type, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, fromId, toId, type, now())
    return this.findLink(fromId, toId, type)
  }

  private findLink(fromId: string, toId: string, type: LinkType): Link | null {
    const row = this.db
      .prepare('SELECT * FROM links WHERE from_id=? AND to_id=? AND type=?')
      .get(fromId, toId, type) as LinkRow | undefined
    return row ? rowToLink(row) : null
  }

  private computeCascade(startId: string): string[] {
    const childStmt = this.db.prepare(
      "SELECT to_id AS id FROM links WHERE type='child' AND from_id = ?"
    )
    const parentsStmt = this.db.prepare(
      "SELECT from_id AS id FROM links WHERE type='child' AND to_id = ?"
    )
    const doomed = new Set<string>([startId])
    let frontier = [startId]
    while (frontier.length) {
      const next: string[] = []
      for (const id of frontier) {
        for (const { id: child } of childStmt.all(id) as Array<{ id: string }>) {
          if (doomed.has(child)) continue
          const parents = (parentsStmt.all(child) as Array<{ id: string }>).map((p) => p.id)
          if (parents.every((p) => doomed.has(p))) {
            doomed.add(child)
            next.push(child)
          }
        }
      }
      frontier = next
    }
    return [...doomed]
  }
}

/**
 * Normalize a client-supplied set definition: trim strings, drop blanks and
 * unknown keys, so only the three supported filters ever reach the DB.
 */
export function sanitizeSetDef(def: Partial<SetDef>): SetDef {
  const out: SetDef = {}
  for (const key of ['text', 'type', 'tag'] as const) {
    const v = typeof def[key] === 'string' ? def[key]!.trim() : ''
    if (v) out[key] = v
  }
  return out
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: each whitespace
 * token becomes a quoted prefix term. Prevents MATCH syntax errors from stray
 * operators and gives "starts-with" behavior.
 */
export function buildFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' ')
}

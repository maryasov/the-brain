import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { buildOpml, parseOpml, type OpmlNode } from '@the-brain/core'
import { extractText, fileSource } from './extract.js'
import {
  rowToAttachment,
  rowToEvent,
  rowToLink,
  rowToSet,
  rowToThought,
  type AddAttachmentInput,
  type Attachment,
  type AttachmentRow,
  type BrainEvent,
  type BrainExport,
  type CreateSetInput,
  type CreateThoughtInput,
  type DeleteOptions,
  type EventKind,
  type EventRow,
  type AttachCounts,
  type HiddenCounts,
  type ImportResult,
  type Link,
  type LinkInfoInput,
  type LinkInput,
  type LinkRow,
  type LinkType,
  type Neighborhood,
  type SearchHit,
  type SetDef,
  type Tag,
  type Thought,
  type ThoughtCard,
  type ThoughtRow,
  type ThoughtSet,
  type ThoughtSetRow,
  type UpdateThoughtInput
} from '@the-brain/shared'

/**
 * Monotonic clock: Date.now() has 1ms resolution, so several writes in one
 * millisecond would tie `updated_at DESC` orderings (recent list, default set
 * results). Handing out strictly increasing values keeps those stable.
 */
let lastTs = 0
const now = () => {
  const t = Date.now()
  lastTs = t > lastTs ? t : lastTs + 1
  return lastTs
}

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

    // Only return links whose BOTH endpoints are in the neighborhood set;
    // the ones with a single endpoint inside become the "hidden" (More-gate)
    // counts so the UI can show relations that exist off-screen.
    const scope = [...new Set([focusId, ...neighborIds])]
    const touching = this.linksTouching(scope)
    const scopeSet = new Set(scope)
    return {
      focus,
      thoughts,
      links: touching.filter((l) => scopeSet.has(l.fromId) && scopeSet.has(l.toId)),
      hidden: this.hiddenFrom(scopeSet, touching),
      attachCounts: this.attachCountsFor(scope)
    }
  }

  /**
   * Hover-card view of one thought: text + tag names + counts of everything
   * around it (parents, children, jumps, siblings, attachments). Siblings are
   * counted like getNeighborhood derives them: other children of my parents.
   */
  getThoughtCard(id: string): ThoughtCard | null {
    const row = this.db.prepare('SELECT * FROM thoughts WHERE id = ?').get(id) as
      | ThoughtRow
      | undefined
    if (!row) return null
    const thought = rowToThought(row)
    const count = (sql: string, ...params: Array<string | number>): number =>
      (this.db.prepare(sql).get(...params) as { n: number }).n
    const tags = this.db
      .prepare(
        `SELECT t.name FROM tags t
           JOIN thought_tags tt ON tt.tag_id = t.id
          WHERE tt.thought_id = ?
          ORDER BY t.name`
      )
      .all(id) as Array<{ name: string }>
    return {
      id: thought.id,
      name: thought.name,
      type: thought.type,
      color: thought.color,
      description: thought.description,
      pinned: thought.pinned,
      updatedAt: thought.updatedAt,
      tags: tags.map((t) => t.name),
      attachments: count('SELECT COUNT(*) AS n FROM attachments WHERE thought_id = ?', id),
      counts: {
        parents: count("SELECT COUNT(*) AS n FROM links WHERE type='child' AND to_id = ?", id),
        children: count("SELECT COUNT(*) AS n FROM links WHERE type='child' AND from_id = ?", id),
        jumps: count(
          "SELECT COUNT(*) AS n FROM links WHERE type='jump' AND (from_id = ? OR to_id = ?)",
          id,
          id
        ),
        siblings: count(
          `SELECT COUNT(DISTINCT c.to_id) AS n
             FROM links p
             JOIN links c ON c.from_id = p.from_id AND c.type = 'child'
            WHERE p.type = 'child' AND p.to_id = ? AND c.to_id <> ?`,
          id,
          id
        )
      }
    }
  }

  /**
   * The neighborhood as it stood at a past timestamp (Back in Time). Deletions
   * remove rows physically, so the journal doubles as the restore source:
   * anything deleted after `at` comes back as a ghost rebuilt from its payload.
   * Personal-brain scale, so the replay runs as plain set logic in JS.
   */
  getNeighborhoodAsOf(focusId: string, at: number): Neighborhood | null {
    const byId = new Map<string, Thought>()
    for (const r of this.db
      .prepare('SELECT * FROM thoughts WHERE created_at <= ?')
      .all(at) as ThoughtRow[]) {
      byId.set(r.id, rowToThought(r))
    }
    // Ghosts: rows deleted from the table after `at` still existed back then.
    for (const e of this.db
      .prepare("SELECT subject_id, payload FROM events WHERE kind = 'thought_deleted' AND at > ?")
      .all(at) as Array<{ subject_id: string; payload: string | null }>) {
      if (!e.payload || byId.has(e.subject_id)) continue
      const p = JSON.parse(e.payload) as {
        name?: string
        description?: string | null
        color?: string | null
        type?: string | null
        pinned?: number
        archived?: number
        createdAt?: number
        updatedAt?: number
      }
      if (typeof p.createdAt !== 'number' || p.createdAt > at) continue
      byId.set(e.subject_id, {
        id: e.subject_id,
        name: p.name ?? '(deleted)',
        description: p.description ?? null,
        color: p.color ?? null,
        type: p.type ?? null,
        pinned: p.pinned === 1,
        archived: p.archived === 1,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt ?? p.createdAt
      })
    }
    const focus = byId.get(focusId)
    if (!focus) return null

    const links = (this.db
      .prepare('SELECT * FROM links WHERE created_at <= ?')
      .all(at) as LinkRow[]).map(rowToLink)
    for (const e of this.db
      .prepare("SELECT subject_id, payload FROM events WHERE kind = 'link_deleted' AND at > ?")
      .all(at) as Array<{ subject_id: string; payload: string | null }>) {
      if (!e.payload) continue
      const p = JSON.parse(e.payload) as {
        fromId?: string
        toId?: string
        type?: LinkType
        createdAt?: number
      }
      if (
        typeof p.createdAt !== 'number' ||
        p.createdAt > at ||
        !p.fromId ||
        !p.toId ||
        !p.type ||
        links.some((l) => l.id === e.subject_id)
      )
        continue
      // The journal doesn't track label/notes edits, so a replayed link
      // comes back without them (the present-day row may still have some).
      links.push({
        id: e.subject_id,
        fromId: p.fromId,
        toId: p.toId,
        type: p.type,
        createdAt: p.createdAt,
        label: null,
        notes: null
      })
    }
    const alive = links.filter((l) => byId.has(l.fromId) && byId.has(l.toId))

    // 1-hop roles, derived from the as-of links exactly like the live view.
    const parents = alive.filter((l) => l.type === 'child' && l.toId === focusId).map((l) => l.fromId)
    const children = alive
      .filter((l) => l.type === 'child' && l.fromId === focusId)
      .map((l) => l.toId)
    const jumps = alive
      .filter((l) => l.type === 'jump' && (l.fromId === focusId || l.toId === focusId))
      .map((l) => (l.fromId === focusId ? l.toId : l.fromId))
    const parentSet = new Set(parents)
    const siblings = new Set(
      alive
        .filter((l) => l.type === 'child' && parentSet.has(l.fromId) && l.toId !== focusId)
        .map((l) => l.toId)
    )

    const scope = new Set([focusId, ...parents, ...children, ...jumps, ...siblings])
    // Names as they were: the newest rename at or before `at` wins.
    for (const row of this.db
      .prepare(
        `SELECT subject_id, payload, at FROM events
          WHERE kind = 'thought_renamed' AND at <= ? ORDER BY at ASC`
      )
      .all(at) as EventRow[]) {
      const thought = byId.get(row.subject_id)
      const name =
        thought && row.payload ? (JSON.parse(row.payload) as { name?: string }).name : null
      if (thought && name) thought.name = name
    }
    return {
      focus,
      thoughts: [...scope].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      links: alive.filter((l) => scope.has(l.fromId) && scope.has(l.toId)),
      hidden: this.hiddenFrom(scope, alive)
    }
  }

  /** Journal entries touching one thought (its own events + its link events). */
  listHistory(thoughtId: string, limit = 30): BrainEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
          WHERE subject_id = ?
             OR json_extract(payload, '$.fromId') = ?
             OR json_extract(payload, '$.toId') = ?
          ORDER BY at DESC, id DESC LIMIT ?`
      )
      .all(thoughtId, thoughtId, thoughtId, Math.max(1, Math.min(200, limit))) as EventRow[]
    return rows.map(rowToEvent)
  }

  /** Oldest timestamp anywhere in the brain (thoughts + journal), for sliders. */
  earliestActivity(): number | null {
    const a = (this.db.prepare('SELECT MIN(created_at) AS t FROM thoughts').get() as {
      t: number | null
    }).t
    const b = (this.db.prepare('SELECT MIN(at) AS t FROM events').get() as { t: number | null }).t
    return a === null ? b : b === null ? a : Math.min(a, b)
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
    const hits: SearchHit[] = rows.map((r) => ({ id: r.id, name: r.name, snippet: r.snippet }))

    // Attachment content hits: same query against extracted file bodies,
    // merged after the direct hits (deduped per thought). The JOIN on
    // attachments also drops rows orphaned by FK-cascaded deletes.
    const seen = new Set(hits.map((h) => h.id))
    const att = this.db
      .prepare(
        `SELECT f.thought_id AS id,
                t.name AS name,
                f.source AS source,
                snippet(attach_fts, 3, '[', ']', ' … ', 12) AS snippet
           FROM attach_fts f
           JOIN thoughts t ON t.id = f.thought_id
           JOIN attachments a ON a.id = f.attachment_id
          WHERE attach_fts MATCH ?
          ORDER BY rank
          LIMIT 25`
      )
      .all(match) as Array<{ id: string; name: string; source: string; snippet: string | null }>
    for (const r of att) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      hits.push({ id: r.id, name: r.name, snippet: r.snippet, via: 'attachment', source: r.source })
    }
    return hits
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
    // Full-text index for local text files (best-effort; see extract.ts).
    const body = extractText(input.kind, uri)
    if (body) {
      this.db
        .prepare('INSERT INTO attach_fts (attachment_id, thought_id, source, body) VALUES (?, ?, ?, ?)')
        .run(id, input.thoughtId, input.label?.trim() || fileSource(uri), body)
    }
    return rowToAttachment(row)
  }

  removeAttachment(thoughtId: string, id: string): Attachment[] {
    this.db.prepare('DELETE FROM attach_fts WHERE attachment_id = ?').run(id)
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
      this.logEvent('thought_created', id, { name: input.name.trim() || 'Untitled' })
      if (input.parentId) {
        this.insertLink(input.parentId, id, input.linkType ?? 'child')
      }
    })
    write()
    return this.getThought(id)!
  }

  updateThought(input: UpdateThoughtInput): Thought {
    const before = this.getThought(input.id)
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
    const after = this.getThought(input.id)
    // Renames are the one edit time-travel must remember (the old name is gone).
    if (before && after && after.name !== before.name) {
      this.logEvent('thought_renamed', after.id, { name: after.name })
    }
    return after!
  }

  setPinned(id: string, pinned: boolean): Thought {
    this.db
      .prepare('UPDATE thoughts SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, now(), id)
    return this.getThought(id)!
  }

  deleteThought(id: string, options: DeleteOptions): void {
    if (options.mode === 'detach') {
      const doomedLinks = this.db
        .prepare('SELECT * FROM links WHERE from_id = ? OR to_id = ?')
        .all(id, id) as LinkRow[]
      this.db.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(id, id)
      for (const l of doomedLinks) this.logLinkDeleted(l)
      return
    }
    // cascade: delete focus plus descendants whose only parents are all doomed.
    const doomed = this.computeCascade(id)
    const del = this.db.transaction(() => {
      const placeholders = doomed.map(() => '?').join(',')
      const doomedLinks = this.db
        .prepare(
          `SELECT * FROM links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
        )
        .all(...doomed, ...doomed) as LinkRow[]
      const names = this.db
        .prepare(`SELECT * FROM thoughts WHERE id IN (${placeholders})`)
        .all(...doomed) as ThoughtRow[]
      // Log while the rows still exist, so payloads keep display names — and
      // enough of the row to resurrect it during an as-of replay later.
      for (const l of doomedLinks) this.logLinkDeleted(l)
      for (const r of names)
        this.logEvent('thought_deleted', r.id, {
          name: r.name,
          description: r.description,
          color: r.color,
          type: r.type,
          pinned: r.pinned,
          archived: r.archived,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        })
      this.db.prepare(`DELETE FROM attach_fts WHERE thought_id IN (${placeholders})`).run(...doomed)
      this.db.prepare(`DELETE FROM thoughts WHERE id IN (${placeholders})`).run(...doomed)
    })
    del()
  }

  link(input: LinkInput): Link {
    const from = input.fromId < input.toId ? input.fromId : input.toId
    const to = input.fromId < input.toId ? input.toId : input.fromId
    // Normalize jump direction so a<->b and b<->a collapse to one row.
    const [a, b] = input.type === 'jump' ? [from, to] : [input.fromId, input.toId]
    const label = input.label?.trim() || null
    const notes = input.notes?.trim() || null
    if (this.findLink(a, b, input.type)) {
      // Relinking an existing pair refreshes the info when it was provided.
      if (label || notes)
        return this.setLinkInfo({ fromId: a, toId: b, type: input.type, label, notes })!
      return this.findLink(a, b, input.type)!
    }
    return this.insertLink(a, b, input.type, label, notes) ?? this.findLink(a, b, input.type)!
  }

  /** Set/clear a link's label/notes by its (from,to,type) triple. */
  setLinkInfo(input: LinkInfoInput): Link | null {
    const from = input.fromId < input.toId ? input.fromId : input.toId
    const to = input.fromId < input.toId ? input.toId : input.fromId
    const [a, b] = input.type === 'jump' ? [from, to] : [input.fromId, input.toId]
    const current = this.findLink(a, b, input.type)
    if (!current) return null
    // Omitted field = leave unchanged; null or blank string = clear.
    const label = input.label === undefined ? current.label : input.label?.trim() || null
    const notes = input.notes === undefined ? current.notes : input.notes?.trim() || null
    if (label !== current.label || notes !== current.notes)
      this.db.prepare('UPDATE links SET label = ?, notes = ? WHERE id = ?').run(label, notes, current.id)
    return { ...current, label, notes }
  }

  unlink(fromId: string, toId: string, type: LinkType): void {
    const doomed =
      type === 'jump'
        ? (this.db
            .prepare(
              "SELECT * FROM links WHERE type='jump' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))"
            )
            .all(fromId, toId, toId, fromId) as LinkRow[])
        : (this.db
            .prepare("SELECT * FROM links WHERE type='child' AND from_id=? AND to_id=?")
            .all(fromId, toId) as LinkRow[])
    this.db
      .prepare(
        type === 'jump'
          ? "DELETE FROM links WHERE type='jump' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))"
          : "DELETE FROM links WHERE type='child' AND from_id=? AND to_id=?"
      )
      .run(...(type === 'jump' ? [fromId, toId, toId, fromId] : [fromId, toId]))
    for (const l of doomed) this.logLinkDeleted(l)
  }

  getOrCreateRoot(): Thought {
    const existing = this.db
      .prepare("SELECT * FROM thoughts WHERE name = 'My Brain' LIMIT 1")
      .get() as ThoughtRow | undefined
    if (existing) return rowToThought(existing)
    return this.createThought({ name: 'My Brain' })
  }

  // ---- export / import ---------------------------------------------------

  /** A full, portable JSON snapshot of every persisted record. */
  exportJson(): BrainExport {
    const thoughts = (this.db.prepare('SELECT * FROM thoughts ORDER BY created_at, id').all() as ThoughtRow[]).map(rowToThought)
    const links = (this.db.prepare('SELECT * FROM links ORDER BY created_at, id').all() as LinkRow[]).map(rowToLink)
    const tags = this.db.prepare('SELECT id, name FROM tags ORDER BY name').all() as Tag[]
    const thoughtTags = this.db
      .prepare('SELECT thought_id AS thoughtId, tag_id AS tagId FROM thought_tags ORDER BY thought_id, tag_id')
      .all() as Array<{ thoughtId: string; tagId: string }>
    const attachments = (this.db.prepare('SELECT * FROM attachments ORDER BY created_at, id').all() as AttachmentRow[]).map(rowToAttachment)
    const sets = (this.db.prepare('SELECT * FROM sets ORDER BY created_at, id').all() as ThoughtSetRow[]).map(rowToSet)
    return {
      version: 1,
      exportedAt: now(),
      generator: 'the-brain-open',
      thoughts,
      links,
      tags,
      thoughtTags,
      attachments,
      sets
    }
  }

  /** Merge a JSON snapshot back in (idempotent: rows with known ids are kept). */
  importJson(data: BrainExport): ImportResult {
    const res: ImportResult = { format: 'json', thoughts: 0, links: 0, tags: 0, attachments: 0, sets: 0 }
    const tx = this.db.transaction(() => {
      const insThought = this.db.prepare(
        `INSERT OR IGNORE INTO thoughts (id, name, description, color, type, pinned, archived, created_at, updated_at)
         VALUES (@id, @name, @description, @color, @type, @pinned, @archived, @created_at, @updated_at)`
      )
      for (const t of data.thoughts ?? []) {
        res.thoughts += insThought.run({
          id: t.id,
          name: t.name,
          description: t.description ?? null,
          color: t.color ?? null,
          type: t.type ?? null,
          pinned: t.pinned ? 1 : 0,
          archived: t.archived ? 1 : 0,
          created_at: t.createdAt,
          updated_at: t.updatedAt
        }).changes
      }
      const insLink = this.db.prepare(
        'INSERT OR IGNORE INTO links (id, from_id, to_id, type, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const l of data.links ?? []) {
        res.links += insLink.run(l.id, l.fromId, l.toId, l.type, l.createdAt).changes
      }
      const insTag = this.db.prepare('INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)')
      for (const tag of data.tags ?? []) res.tags += insTag.run(tag.id, tag.name).changes
      const insMap = this.db.prepare('INSERT OR IGNORE INTO thought_tags (thought_id, tag_id) VALUES (?, ?)')
      for (const m of data.thoughtTags ?? []) insMap.run(m.thoughtId, m.tagId)
      const insAtt = this.db.prepare(
        'INSERT OR IGNORE INTO attachments (id, thought_id, kind, uri, label, mime, created_at) VALUES (@id, @thought_id, @kind, @uri, @label, @mime, @created_at)'
      )
      for (const a of data.attachments ?? []) {
        res.attachments += insAtt.run({
          id: a.id,
          thought_id: a.thoughtId,
          kind: a.kind,
          uri: a.uri,
          label: a.label ?? null,
          mime: a.mime ?? null,
          created_at: a.createdAt
        }).changes
      }
      const insSet = this.db.prepare(
        'INSERT OR IGNORE INTO sets (id, name, description, def_json, created_at, updated_at) VALUES (@id, @name, @description, @def_json, @created_at, @updated_at)'
      )
      for (const s of data.sets ?? []) {
        res.sets += insSet.run({
          id: s.id,
          name: s.name,
          description: s.description ?? null,
          def_json: JSON.stringify(s.def ?? {}),
          created_at: s.createdAt,
          updated_at: s.updatedAt
        }).changes
      }
    })
    tx()
    return res
  }

  /** The parent→child hierarchy as an OPML outline (tree; cycle-safe). */
  exportOpml(): string {
    const thoughts = this.db.prepare('SELECT id, name FROM thoughts ORDER BY name').all() as Array<{
      id: string
      name: string
    }>
    const nameById = new Map(thoughts.map((t) => [t.id, t.name]))
    const childLinks = this.db
      .prepare("SELECT from_id AS parentId, to_id AS childId FROM links WHERE type = 'child'")
      .all() as Array<{ parentId: string; childId: string }>
    const kids = new Map<string, string[]>()
    const hasParent = new Set<string>()
    for (const { parentId, childId } of childLinks) {
      let list = kids.get(parentId)
      if (!list) {
        list = []
        kids.set(parentId, list)
      }
      list.push(childId)
      hasParent.add(childId)
    }
    const visited = new Set<string>()
    const build = (id: string): OpmlNode => {
      visited.add(id)
      const children = (kids.get(id) ?? []).filter((c) => !visited.has(c)).map(build)
      return { name: nameById.get(id) ?? 'Untitled', children }
    }
    const roots = thoughts.filter((t) => !hasParent.has(t.id)).map((t) => build(t.id))
    for (const t of thoughts) if (!visited.has(t.id)) roots.push(build(t.id))
    return buildOpml(roots, 'TheBrain export')
  }

  /**
   * Import an OPML outline as a thought hierarchy. Names are matched
   * case-insensitively against existing thoughts (reuse, never duplicate);
   * when parentId is given, top-level entries hang beneath it.
   */
  importOpml(xml: string, parentId?: string): ImportResult {
    const entries = parseOpml(xml)
    const res: ImportResult = { format: 'opml', thoughts: 0, links: 0, tags: 0, attachments: 0, sets: 0 }
    const findByName = this.db.prepare('SELECT id FROM thoughts WHERE name = ? COLLATE NOCASE LIMIT 1')
    const insThought = this.db.prepare(
      `INSERT INTO thoughts (id, name, description, color, type, pinned, archived, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, 0, 0, ?, ?)`
    )
    const insLink = this.db.prepare(
      "INSERT OR IGNORE INTO links (id, from_id, to_id, type, created_at) VALUES (?, ?, ?, 'child', ?)"
    )
    const ts = now()
    const tx = this.db.transaction(() => {
      const stack: Array<{ id: string; depth: number }> = []
      for (const e of entries) {
        while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop()
        let id = (findByName.get(e.name) as { id: string } | undefined)?.id
        if (!id) {
          id = randomUUID()
          insThought.run(id, e.name, ts, ts)
          res.thoughts += 1
        }
        const parent = stack.length ? stack[stack.length - 1].id : parentId
        if (parent && parent !== id) res.links += insLink.run(randomUUID(), parent, id, ts).changes
        stack.push({ id, depth: e.depth })
      }
    })
    tx()
    return res
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

  /** Every link with at least ONE endpoint inside `ids`. */
  private linksTouching(ids: string[]): Link[] {
    if (!ids.length) return []
    const ph = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM links WHERE from_id IN (${ph}) OR to_id IN (${ph})`)
      .all(...ids, ...ids) as LinkRow[]
    return rows.map(rowToLink)
  }

  /** Per-thought attachment totals for the canvas badge (live views only). */
  private attachCountsFor(ids: string[]): Record<string, AttachCounts> {
    const out: Record<string, AttachCounts> = {}
    if (!ids.length) return out
    const ph = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT thought_id, kind, COUNT(*) AS n FROM attachments WHERE thought_id IN (${ph}) GROUP BY thought_id, kind`
      )
      .all(...ids) as { thought_id: string; kind: string; n: number }[]
    for (const r of rows) {
      const c = (out[r.thought_id] ??= { total: 0, urls: 0 })
      c.total += r.n
      if (r.kind === 'url') c.urls += r.n
    }
    return out
  }

  /**
   * TheBrain "More" gates: for each scoped thought, the link neighbors that
   * are themselves NOT in scope (parents above / children below / jumps).
   */
  private hiddenFrom(scope: Set<string>, links: Link[]): Record<string, HiddenCounts> {
    const out: Record<string, HiddenCounts> = {}
    const add = (id: string, dir: keyof HiddenCounts, other: string) => {
      const h = (out[id] ??= { parents: [], children: [], jumps: [] })
      if (!h[dir].includes(other)) h[dir].push(other)
    }
    for (const l of links) {
      const inA = scope.has(l.fromId)
      const inB = scope.has(l.toId)
      if (l.type === 'child') {
        if (inA && !inB) add(l.fromId, 'children', l.toId)
        else if (inB && !inA) add(l.toId, 'parents', l.fromId)
      } else if (inA !== inB) {
        if (inA) add(l.fromId, 'jumps', l.toId)
        else add(l.toId, 'jumps', l.fromId)
      }
    }
    return out
  }

  private insertLink(
    fromId: string,
    toId: string,
    type: LinkType,
    label: string | null = null,
    notes: string | null = null
  ): Link | null {
    if (fromId === toId) return null
    const id = randomUUID()
    const changes = this.db
      .prepare(
        'INSERT OR IGNORE INTO links (id, from_id, to_id, type, created_at, label, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, fromId, toId, type, now(), label, notes).changes
    if (changes) {
      this.logEvent('link_created', id, {
        fromId,
        toId,
        type,
        fromName: this.nameOf(fromId),
        toName: this.nameOf(toId)
      })
    }
    return this.findLink(fromId, toId, type)
  }

  /** Append one journal entry (the Back in Time replay source). */
  private logEvent(kind: EventKind, subjectId: string, payload?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO events (at, kind, subject_id, payload) VALUES (?, ?, ?, ?)')
      .run(now(), kind, subjectId, payload ? JSON.stringify(payload) : null)
  }

  private logLinkDeleted(row: LinkRow): void {
    this.logEvent('link_deleted', row.id, {
      fromId: row.from_id,
      toId: row.to_id,
      type: row.type,
      createdAt: row.created_at,
      fromName: this.nameOf(row.from_id),
      toName: this.nameOf(row.to_id)
    })
  }

  private nameOf(id: string): string | undefined {
    return (this.db.prepare('SELECT name FROM thoughts WHERE id = ?').get(id) as
      | { name: string }
      | undefined)?.name
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

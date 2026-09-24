import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './migrations.js'
import { Repository, buildFtsQuery } from './repository.js'
import { computeViewport } from '@the-brain/core'

function freshRepo(): Repository {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return new Repository(db)
}

describe('buildFtsQuery', () => {
  it('turns tokens into quoted prefix terms and strips operators', () => {
    expect(buildFtsQuery('quantum botany')).toBe('"quantum"* "botany"*')
    expect(buildFtsQuery('foo:bar AND (x OR y)')).toBe('"foobar"* "AND"* "x"* "OR"* "y"*')
    expect(buildFtsQuery('   ')).toBe('')
  })
})

describe('Repository', () => {
  let repo: Repository
  beforeEach(() => {
    repo = freshRepo()
  })

  it('starts empty and creates the root once', () => {
    expect(repo.isEmpty()).toBe(true)
    const a = repo.getOrCreateRoot()
    const b = repo.getOrCreateRoot()
    expect(a.id).toBe(b.id)
    expect(a.name).toBe('My Brain')
    expect(repo.isEmpty()).toBe(false)
  })

  it('creates a child link from parentId', () => {
    const root = repo.getOrCreateRoot()
    const child = repo.createThought({ name: 'Alpha', parentId: root.id })
    const nb = repo.getNeighborhood(root.id)!
    const vp = computeViewport(nb)
    expect(vp.children.map((t) => t.id)).toContain(child.id)
  })

  it('classifies parents / jumps / siblings from the DB', () => {
    const root = repo.getOrCreateRoot()
    const a = repo.createThought({ name: 'A', parentId: root.id })
    const b = repo.createThought({ name: 'B', parentId: root.id })
    repo.link({ fromId: a.id, toId: b.id, type: 'jump' })

    const vp = computeViewport(repo.getNeighborhood(a.id)!)
    expect(vp.parents.map((t) => t.id)).toEqual([root.id])
    // b is both a sibling (shares root) and a jump -> jump wins, not a sibling
    expect(vp.jumps.map((t) => t.id)).toEqual([b.id])
    expect(vp.siblings).toHaveLength(0)
  })

  it('builds a hover card with tags and link/attachment counts', () => {
    const root = repo.getOrCreateRoot()
    const a = repo.createThought({ name: 'A', parentId: root.id, description: 'first note' })
    repo.createThought({ name: 'B', parentId: root.id }) // sibling of A
    repo.createThought({ name: 'A1', parentId: a.id }) // child of A
    repo.link({ fromId: a.id, toId: root.id, type: 'jump' }) // a jump to its own parent still counts
    repo.addTag(a.id, 'alpha')
    repo.addTag(a.id, 'notes')
    repo.addAttachment({ thoughtId: a.id, kind: 'url', uri: 'https://example.com' })

    const card = repo.getThoughtCard(a.id)!
    expect(card.name).toBe('A')
    expect(card.description).toBe('first note')
    expect(card.tags).toEqual(['alpha', 'notes'])
    expect(card.attachments).toBe(1)
    expect(card.counts).toEqual({ parents: 1, children: 1, jumps: 1, siblings: 1 })
    expect(repo.getThoughtCard('missing')).toBeNull()
  })

  it('indexes search and keeps it in sync on rename', () => {
    const root = repo.getOrCreateRoot()
    const t = repo.createThought({ name: 'Photosynthesis', parentId: root.id })
    expect(repo.search('photo').map((h) => h.id)).toContain(t.id)
    repo.updateThought({ id: t.id, name: 'Cellular Respiration' })
    expect(repo.search('photosynthesis')).toHaveLength(0)
    expect(repo.search('respiration').map((h) => h.id)).toContain(t.id)
  })

  it('supports multiple parents', () => {
    const root = repo.getOrCreateRoot()
    const p1 = repo.createThought({ name: 'P1', parentId: root.id })
    const p2 = repo.createThought({ name: 'P2', parentId: root.id })
    const shared = repo.createThought({ name: 'Shared', parentId: p1.id })
    repo.link({ fromId: p2.id, toId: shared.id, type: 'child' })

    const vp = computeViewport(repo.getNeighborhood(shared.id)!)
    expect(vp.parents.map((t) => t.id).sort()).toEqual([p1.id, p2.id].sort())
  })

  it('detach removes links but keeps descendants alive', () => {
    const root = repo.getOrCreateRoot()
    const p = repo.createThought({ name: 'P', parentId: root.id })
    const c = repo.createThought({ name: 'C', parentId: p.id })

    repo.deleteThought(p.id, { mode: 'detach' })
    expect(repo.getThought(p.id)).not.toBeNull()
    expect(repo.getThought(c.id)).not.toBeNull()
    // p no longer has c as a child
    const vp = computeViewport(repo.getNeighborhood(p.id)!)
    expect(vp.children).toHaveLength(0)
  })

  it('cascade removes exclusively-owned descendants', () => {
    const root = repo.getOrCreateRoot()
    const p = repo.createThought({ name: 'P', parentId: root.id })
    const onlyChild = repo.createThought({ name: 'Only', parentId: p.id })
    const sharedChild = repo.createThought({ name: 'Shared', parentId: p.id })
    const otherParent = repo.createThought({ name: 'Other', parentId: root.id })
    repo.link({ fromId: otherParent.id, toId: sharedChild.id, type: 'child' })

    repo.deleteThought(p.id, { mode: 'cascade' })
    expect(repo.getThought(p.id)).toBeNull()
    expect(repo.getThought(onlyChild.id)).toBeNull()
    // sharedChild survives because otherParent still owns it
    expect(repo.getThought(sharedChild.id)).not.toBeNull()
  })

  it('tracks pinned thoughts', () => {
    const root = repo.getOrCreateRoot()
    repo.setPinned(root.id, true)
    expect(repo.listPinned().map((t) => t.id)).toContain(root.id)
    repo.setPinned(root.id, false)
    expect(repo.listPinned()).toHaveLength(0)
  })

  it('manages tags (create, reuse, remove)', () => {
    const root = repo.getOrCreateRoot()
    let tags = repo.addTag(root.id, 'ideas')
    expect(tags.map((t) => t.name)).toEqual(['ideas'])
    // reuse the same tag across thoughts without duplicating
    const a = repo.createThought({ name: 'A', parentId: root.id })
    tags = repo.addTag(a.id, 'ideas')
    expect(tags).toHaveLength(1)
    expect(repo.listTags(root.id)[0].id).toBe(tags[0].id)
    tags = repo.removeTag(root.id, tags[0].id)
    expect(tags).toHaveLength(0)
    expect(repo.listTags(a.id)).toHaveLength(1)
  })

  it('unlink removes a jump in either direction', () => {
    const root = repo.getOrCreateRoot()
    const a = repo.createThought({ name: 'A', parentId: root.id })
    const b = repo.createThought({ name: 'B', parentId: root.id })
    repo.link({ fromId: a.id, toId: b.id, type: 'jump' })
    repo.unlink(b.id, a.id, 'jump') // reversed order
    const vp = computeViewport(repo.getNeighborhood(a.id)!)
    expect(vp.jumps).toHaveLength(0)
  })

  it('app_state round-trips and upserts (drives the desktop window)', () => {
    const root = repo.getOrCreateRoot()
    expect(repo.getAppState('focus')).toBeNull()
    repo.setAppState('focus', root.id)
    expect(repo.getAppState('focus')).toBe(root.id)
    repo.setAppState('focus', 'other-id') // upsert, not duplicate
    expect(repo.getAppState('focus')).toBe('other-id')
    repo.setAppState('focus', null)
    expect(repo.getAppState('focus')).toBeNull()
  })

  it('attachments: add, list, and remove across every kind', () => {
    const root = repo.getOrCreateRoot()
    const target = repo.createThought({ name: 'Anchor target', parentId: root.id })
    const file = repo.addAttachment({ thoughtId: root.id, kind: 'file', uri: '/tmp/a.pdf' })
    const url = repo.addAttachment({
      thoughtId: root.id,
      kind: 'url',
      uri: 'https://example.com/x',
      label: 'Example'
    })
    const anchor = repo.addAttachment({ thoughtId: root.id, kind: 'thought', uri: target.id })
    expect(repo.listAttachments(root.id).map((a) => a.id)).toEqual([file.id, url.id, anchor.id])
    expect(url.label).toBe('Example')
    expect(file.label).toBeNull()

    const remaining = repo.removeAttachment(root.id, file.id)
    expect(remaining.map((a) => a.id)).toEqual([url.id, anchor.id])
  })

  it('attachments: reject empty uri, missing host, and dangling anchor thoughts', () => {
    const root = repo.getOrCreateRoot()
    expect(() => repo.addAttachment({ thoughtId: root.id, kind: 'url', uri: '  ' })).toThrow()
    expect(() =>
      repo.addAttachment({ thoughtId: 'nope', kind: 'url', uri: 'https://x.example' })
    ).toThrow()
    expect(() =>
      repo.addAttachment({ thoughtId: root.id, kind: 'thought', uri: 'no-such-thought' })
    ).toThrow(/anchor thought/)
  })

  it('attachments: cascade-deleted with their thought', () => {
    const root = repo.getOrCreateRoot()
    const child = repo.createThought({ name: 'Tmp', parentId: root.id })
    repo.addAttachment({ thoughtId: child.id, kind: 'url', uri: 'https://gone.example' })
    repo.deleteThought(child.id, { mode: 'cascade' })
    expect(repo.getThought(child.id)).toBeNull() // FK cascade took the attachment too
    expect(repo.listAttachments(child.id)).toHaveLength(0)
  })

  it('thought types: create, update (trimmed), and clear', () => {
    const root = repo.getOrCreateRoot()
    const p = repo.createThought({ name: 'Ada', parentId: root.id, type: 'person' })
    expect(p.type).toBe('person')
    expect(repo.updateThought({ id: p.id, type: '  Engineer ' }).type).toBe('Engineer')
    expect(repo.updateThought({ id: p.id, type: null }).type).toBeNull()
    expect(repo.updateThought({ id: p.id, type: '   ' }).type).toBeNull() // blank clears
    // Absent key leaves the type untouched.
    repo.updateThought({ id: p.id, type: 'person' })
    expect(repo.updateThought({ id: p.id, name: 'Ada Lovelace' }).type).toBe('person')
  })

  it('filtered sets: create, list, run (text/type/tag AND-ed), delete', () => {
    const root = repo.getOrCreateRoot()
    const ada = repo.createThought({ name: 'Ada', parentId: root.id, type: 'person' })
    repo.createThought({ name: 'Graph Theory', parentId: root.id, type: 'book' })
    repo.addTag(ada.id, 'people')

    const set = repo.createSet({ name: 'People', def: { type: 'PERSON', text: '  ', tag: '' } })
    expect(set.def).toEqual({ type: 'PERSON' }) // blanks dropped, case kept as given
    expect(repo.listSets().map((s) => s.id)).toEqual([set.id])

    // Type filter is case-insensitive; only Ada matches.
    expect(repo.runSet(set.id).map((t) => t.id)).toEqual([ada.id])

    // Text + type AND-ed: matching text but wrong type yields nothing.
    expect(repo.runSetDef({ text: 'graph', type: 'person' })).toHaveLength(0)
    expect(repo.runSetDef({ text: 'graph', type: 'book' }).map((t) => t.name)).toEqual([
      'Graph Theory'
    ])

    // Tag filter matches by name, case-insensitively.
    expect(repo.runSetDef({ tag: 'PeOpLe' }).map((t) => t.id)).toEqual([ada.id])

    // Empty definition = everything, newest first.
    expect(repo.runSetDef({})).toHaveLength(3)

    repo.deleteSet(set.id)
    expect(repo.listSets()).toHaveLength(0)
    expect(repo.runSet(set.id)).toHaveLength(0)
  })

  it('listRecent: most recently touched thought comes first', () => {
    const root = repo.getOrCreateRoot()
    const a = repo.createThought({ name: 'A', parentId: root.id })
    const b = repo.createThought({ name: 'B', parentId: root.id })
    expect(repo.listRecent(10).map((t) => t.id).sort()).toEqual([root.id, a.id, b.id].sort())
    // Touch root and assert it jumps to the front deterministically.
    const before = repo.listRecent(10).map((t) => t.id)
    repo.updateThought({ id: root.id, description: 'fresh' })
    const after = repo.listRecent(10).map((t) => t.id)
    expect(after[0]).toBe(root.id)
    expect(after.filter((id) => id !== root.id)).toEqual(before.filter((id) => id !== root.id))
    expect(repo.listRecent(2)).toHaveLength(2)
  })

  it('getSubgraph: reaches depth hops in both link directions, bounded', () => {
    const root = repo.getOrCreateRoot()
    const a = repo.createThought({ name: 'A', parentId: root.id })
    const b = repo.createThought({ name: 'B', parentId: a.id }) // depth 2 from root
    const c = repo.createThought({ name: 'C', parentId: b.id }) // depth 3: outside
    repo.link({ fromId: root.id, toId: c.id, type: 'jump' }) // but c is 1 jump away

    const sub = repo.getSubgraph(root.id, 2)!
    const ids = sub.thoughts.map((t) => t.id).sort()
    expect(ids).toEqual([a.id, b.id, c.id, root.id].sort())
    expect(sub.focus.id).toBe(root.id)
    // links within the subgraph only
    expect(sub.links.every((l) => ids.includes(l.fromId) && ids.includes(l.toId))).toBe(true)

    // Narrower depth excludes pure-grandchildren reachable only via them.
    const shallow = repo.getSubgraph(b.id, 1)!
    expect(shallow.thoughts.map((t) => t.id).sort()).toEqual([a.id, b.id, c.id].sort())
    expect(repo.getSubgraph('nope', 2)).toBeNull()
  })

  it('export/import JSON: full snapshot restores a fresh DB and is idempotent', () => {
    const root = repo.getOrCreateRoot()
    const ada = repo.createThought({ name: 'Ada', parentId: root.id, type: 'person' })
    repo.createThought({ name: 'Graph Theory', parentId: root.id, type: 'book' })
    repo.link({ fromId: ada.id, toId: root.id, type: 'jump' })
    repo.addTag(ada.id, 'people')
    repo.addAttachment({ thoughtId: ada.id, kind: 'url', uri: 'https://example.com' })
    repo.createSet({ name: 'People', def: { type: 'person' } })

    const snapshot = repo.exportJson()
    expect(snapshot.version).toBe(1)
    expect(snapshot.thoughts).toHaveLength(3)
    expect(snapshot.links.length).toBeGreaterThanOrEqual(3) // 2 child + 1 jump
    expect(snapshot.tags).toHaveLength(1)
    expect(snapshot.attachments).toHaveLength(1)
    expect(snapshot.sets).toHaveLength(1)

    const target = freshRepo()
    const res = target.importJson(snapshot)
    expect(res.format).toBe('json')
    expect(res.thoughts).toBe(3)
    expect(res.links).toBeGreaterThanOrEqual(3)
    expect(res.tags).toBe(1)
    expect(res.attachments).toBe(1)
    expect(res.sets).toBe(1)
    // Round-trips: exporting the target yields the same record set.
    const again = target.exportJson()
    expect(again.thoughts.map((t) => t.id).sort()).toEqual(
      snapshot.thoughts.map((t) => t.id).sort()
    )
    // Idempotent: re-importing changes nothing.
    const dupe = target.importJson(snapshot)
    expect(dupe.thoughts).toBe(0)
    expect(dupe.links).toBe(0)
    expect(dupe.sets).toBe(0)
    // Imported set definition survived and still runs.
    const importedSet = target.listSets()[0]
    expect(target.runSet(importedSet.id).map((t) => t.name)).toEqual(['Ada'])
  })

  it('export/import OPML: hierarchy survives a round-trip with name reuse', () => {
    const root = repo.getOrCreateRoot()
    const sci = repo.createThought({ name: 'Science', parentId: root.id })
    const math = repo.createThought({ name: 'Math', parentId: sci.id })
    repo.createThought({ name: 'Physics', parentId: sci.id })
    repo.createThought({ name: 'Calculus', parentId: math.id })

    const xml = repo.exportOpml()
    expect(xml).toContain('<opml version="2.0">')
    expect(xml).toContain('text="Physics"')
    expect(xml).toContain('text="Calculus"')

    // Import into the same DB: every name already exists, so only links may be
    // added and thoughts must not be recreated.
    const res = repo.importOpml(xml)
    expect(res.format).toBe('opml')
    expect(res.thoughts).toBe(0) // all reused by name

    // Import into a fresh DB under a chosen parent builds the whole tree.
    const target = freshRepo()
    const targetRoot = target.getOrCreateRoot()
    const built = target.importOpml(xml, targetRoot.id)
    expect(built.thoughts).toBe(4) // Science/Math/Calculus/Physics (My Brain reused)
    const vp = computeViewport(target.getNeighborhood(targetRoot.id)!)
    expect(vp.children.map((t) => t.name)).toEqual(['Science'])
    // Science is the hub: Math + Physics hang off it; Calculus off Math.
    const science = target.search('Science')[0]
    const svp = computeViewport(target.getNeighborhood(science.id)!)
    expect(svp.children.map((t) => t.name).sort()).toEqual(['Math', 'Physics'])
  })
})

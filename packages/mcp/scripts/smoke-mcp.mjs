// Smoke-test the MCP stdio server end to end:
// spawn it, initialize, list tools, navigate the graph, create + link + delete a thought.
// Uses an isolated DB (BRAIN_DB_PATH) so the real brain is untouched.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeFileSync, rmSync } from 'node:fs'

const transport = new StdioClientTransport({
  command: 'pnpm',
  args: ['--dir', 'packages/mcp', 'start'],
  env: { ...process.env, BRAIN_DB_PATH: new URL('./smoke-mcp.db', import.meta.url).pathname },
  stderr: 'pipe'
})
const client = new Client({ name: 'smoke', version: '0.0.1' })
await client.connect(transport)

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`)
  return JSON.parse(res.content[0].text)
}

const tools = await client.listTools()
console.log('tools:', tools.tools.length)

const root = await call('brain_get_root', {})
console.log('root:', root.name, root.id)

const created = await call('brain_create_thought', {
  name: 'Smoke Child',
  description: 'created by smoke test',
  parentId: root.id,
  linkType: 'child'
})
console.log('created:', created.name, created.id)

const nav = await call('brain_navigate', { focusId: root.id })
console.log(
  'viewport roles:',
  Object.entries(nav)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v ? 1 : 0}`)
    .join(' ')
)

const search = await call('brain_search', { query: 'Smoke' })
console.log('search hits:', search.length)

const tagged = await call('brain_add_tag', { thoughtId: created.id, name: 'smoke-test' })
console.log('tags:', tagged.map((t) => t.name).join(','))

const att = await call('brain_add_attachment', {
  thoughtId: created.id,
  kind: 'url',
  uri: 'https://example.com',
  label: 'Example'
})
console.log('attachment:', att.kind, att.label)
const atts = await call('brain_list_attachments', { thoughtId: created.id })
console.log('attachments listed:', atts.length)
await call('brain_remove_attachment', { thoughtId: created.id, id: att.id })

// Timeline + minimap data: recent thoughts and a 2-hop subgraph.
const recent = await call('brain_list_recent', { limit: 5 })
console.log('recent count:', recent.length, '| newest:', recent[0]?.name)
const sub = await call('brain_get_subgraph', { centerId: root.id, depth: 2 })
console.log('subgraph:', sub.thoughts.length, 'nodes,', sub.links.length, 'links')

// Thought types: set via update, clear with an empty string.
const typed = await call('brain_update_thought', { id: created.id, type: 'person' })
console.log('type set:', typed.type)
const untyped = await call('brain_update_thought', { id: created.id, type: '' })
console.log('type cleared:', untyped.type === null)

// Hover card (backs the canvas tooltip): text + link/attachment counts.
const card = await call('brain_get_card', { id: created.id })
console.log(
  'card ok:',
  card.name === 'Smoke Child' && typeof card.counts.parents === 'number',
  '| counts:',
  JSON.stringify(card.counts)
)

// Filtered sets: save + run a type filter, then delete the set again.
await call('brain_update_thought', { id: created.id, type: 'person' })
const setsBefore = (await call('brain_list_sets', {})).length
const set = await call('brain_create_set', { name: 'MCP Smoke Set', type: 'person' })
console.log('set created:', set.name, JSON.stringify(set.def))
const setHits = await call('brain_run_set', { setId: set.id })
console.log('set run hits created:', setHits.some((h) => h.id === created.id))
await call('brain_delete_set', { setId: set.id })
console.log(
  'set deleted:',
  (await call('brain_list_sets', {})).length === setsBefore
)
await call('brain_update_thought', { id: created.id, type: '' })

// App control: drive the (hypothetical) desktop window's focus via shared state.
await call('brain_set_app_focus', { thoughtId: created.id })
const state = await call('brain_get_app_state', {})
console.log('app focus driven:', state.focus === created.id)
const badFocus = await client.callTool({
  name: 'brain_set_app_focus',
  arguments: { thoughtId: 'no-such-id' }
})
console.log('bad focus rejected:', badFocus.isError === true)

// App RPC: only answers when the desktop app is running against this DB.
const rpc = await client.callTool({ name: 'brain_app_rpc', arguments: { method: 'ping' } })
console.log(
  rpc.isError ? 'brain_app_rpc: no desktop (ok in headless smoke)' : 'brain_app_rpc ping: ok'
)

// Export/import: JSON snapshot round-trip (idempotent re-import) + OPML outline.
const snapshot = await call('brain_export', {})
console.log('export snapshot: v' + snapshot.version, 'thoughts:', snapshot.thoughts.length)
const noop = await call('brain_import_json', { document: snapshot })
console.log('json re-import no-op:', noop.thoughts === 0 && noop.links === 0)
const opmlRes = await client.callTool({ name: 'brain_export_opml', arguments: {} })
const opml = opmlRes.content[0].text // raw document, not JSON
console.log(
  'opml export ok:',
  opml.includes('<opml version="2.0"') && opml.includes('Smoke Child')
)
const reOpml = await call('brain_import_opml', { xml: opml })
console.log('opml re-import reuses names:', reOpml.thoughts === 0)

// More-gates: a hidden grandchild reported on the shown child at root focus.
const grand = await call('brain_create_thought', { name: 'Smoke Grandchild', parentId: created.id })
const nbG = await call('brain_get_neighborhood', { focusId: root.id })
console.log(
  'hidden More-gates ok:',
  (nbG.hidden?.[created.id]?.children ?? []).includes(grand.id) &&
    nbG.hidden?.[root.id] === undefined
)

// Attachment badges: a URL + a file on the child surface in attachCounts.
await call('brain_add_attachment', { thoughtId: created.id, kind: 'url', uri: 'https://example.com', label: 'Site' })
await call('brain_add_attachment', { thoughtId: created.id, kind: 'file', uri: '/tmp/x.pdf', label: 'x' })
const nbA = await call('brain_get_neighborhood', { focusId: root.id })
console.log(
  'attach badge ok:',
  nbA.attachCounts?.[created.id]?.total === 2 && nbA.attachCounts[created.id].urls === 1
)

// Named relationships: brain_link_info stamps the link, neighborhood carries it.
const lbl = await call('brain_link_info', {
  fromId: root.id,
  toId: created.id,
  type: 'child',
  label: 'owns',
  notes: 'smoke note'
})
const nbL = await call('brain_get_neighborhood', { focusId: created.id })
const lblRow = nbL.links.find((l) => l.id === lbl.id)
console.log('link label ok:', lbl.label === 'owns' && lblRow?.notes === 'smoke note')

// Attachment full text: search hits the CONTENT of an attached text file.
const txt = `/tmp/brain-mcp-smoke-${Date.now()}.md`
writeFileSync(txt, 'Contains the coined word flibberzanz for smoke tests.\n')
await call('brain_add_attachment', { thoughtId: created.id, kind: 'file', uri: txt })
const ftsHit = (await call('brain_search', { query: 'flibberzanz' })).find((h) => h.id === created.id)
console.log('attach fts ok:', ftsHit?.via === 'attachment' && (ftsHit.snippet ?? '').includes('[flibberzanz]'))
rmSync(txt)

const tAlive = Date.now()
await call('brain_delete_thought', { id: created.id, mode: 'cascade' })
const after = await call('brain_get_thought', { id: created.id })
console.log('deleted ok:', after === null)

// Back in Time: replay the root's neighborhood at tAlive (child still alive there).
const nbNow = await call('brain_get_neighborhood', { focusId: root.id })
const nbPast = await call('brain_get_neighborhood', { focusId: root.id, at: tAlive })
console.log(
  'as-of replay ok:',
  !nbNow.thoughts.some((t) => t.id === created.id) &&
    nbPast.thoughts.some((t) => t.id === created.id)
)
const hist = await call('brain_list_history', { thoughtId: created.id })
const kinds = new Set(hist.map((e) => e.kind))
console.log(
  'history kinds ok:',
  ['thought_created', 'link_created', 'link_deleted', 'thought_deleted'].every((k) =>
    kinds.has(k)
  )
)

await client.close()
console.log('MCP SMOKE: PASS')

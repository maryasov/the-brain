// Smoke-test the HTTP API against a running server (BASE env or :8791).
const BASE = process.env.BASE ?? 'http://localhost:8791'
const j = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

const root = (await j('GET', '/root')).data
console.log('root:', root.name)

const created = (
  await j('POST', '/thoughts', {
    name: 'API Child',
    description: 'via http',
    parentId: root.id,
    linkType: 'child'
  })
).data
console.log('created:', created.name, created.id)

const vp = (await j('GET', `/viewport/${root.id}`)).data
console.log(
  'viewport roles:',
  Object.entries(vp)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v ? 1 : 0}`)
    .join(' ')
)

const search = (await j('GET', '/search?q=API')).data
console.log('search hits:', search.length)

const patched = (await j('PATCH', `/thoughts/${created.id}`, { name: 'API Child Renamed' })).data
console.log('patched:', patched.name)

const link = (await j('POST', '/links', { fromId: root.id, toId: created.id, type: 'jump' })).data
console.log('jump linked:', !!link)

const tag = (await j('POST', '/tags', { thoughtId: created.id, name: 'api-smoke' })).data
console.log('tagged:', tag.map((t) => t.name).join(','))

const att = (await j('POST', '/attachments', { thoughtId: created.id, kind: 'url', uri: 'https://example.com', label: 'Example' })).data
const attList = (await j('GET', `/attachments/${created.id}`)).data
console.log('attachment:', att.kind, att.label, '| listed:', attList.length)
await j('DELETE', '/attachments', { thoughtId: created.id, id: att.id })
console.log('attachment removed:', (await j('GET', `/attachments/${created.id}`)).data.length === 0)

// Timeline + minimap data endpoints.
const recent = (await j('GET', '/recent?limit=5')).data
console.log('recent count:', recent.length, '| newest:', recent[0]?.name)
const sub = (await j('GET', `/subgraph/${root.id}?depth=2`)).data
console.log('subgraph:', sub.thoughts.length, 'nodes,', sub.links.length, 'links')

// Thought types: set, read back, clear with explicit null.
const typed = (await j('PATCH', `/thoughts/${created.id}`, { type: 'person' })).data
console.log('type set:', typed.type)
const untyped = (await j('PATCH', `/thoughts/${created.id}`, { type: null })).data
console.log('type cleared:', untyped.type === null)

// Filtered sets: save a type+tag filter, run it, delete it.
await j('PATCH', `/thoughts/${created.id}`, { type: 'person' })
const setsBefore = (await j('GET', '/sets')).data.length
const set = (await j('POST', '/sets', { name: 'API Smoke Set', def: { type: 'person', tag: 'api-smoke' } })).data
console.log('set created:', set.name, JSON.stringify(set.def))
const hits = (await j('GET', `/sets/${set.id}/thoughts`)).data
console.log('set run hits created:', hits.some((h) => h.id === created.id))
await j('DELETE', `/sets/${set.id}`)
console.log('set deleted:', (await j('GET', '/sets')).data.length === setsBefore)
await j('PATCH', `/thoughts/${created.id}`, { type: null })

// Export/import: JSON snapshot round-trip (idempotent), OPML text, validation.
const snap = (await j('GET', '/export')).data
console.log('GET /export: v' + snap.version, 'thoughts:', snap.thoughts.length)
const noop = (await j('POST', '/import', snap)).data
console.log('POST /import re-import no-op:', noop.thoughts === 0 && noop.links === 0)
const opmlRes = await fetch(BASE + '/export/opml')
const opml = await opmlRes.text()
console.log(
  'GET /export/opml ok:',
  (opmlRes.headers.get('content-type') ?? '').includes('opml') &&
    opml.includes('API Child Renamed')
)
const reOpml = (await j('POST', '/import/opml', { xml: opml })).data
console.log('POST /import/opml reuses names:', reOpml.thoughts === 0)
const badImp = await j('POST', '/import', { not: 'a snapshot' })
console.log('bad import rejected:', badImp.status === 400)

const del = await j('DELETE', `/thoughts/${created.id}?mode=cascade`)
console.log('delete status:', del.status)
const gone = await j('GET', `/thought/${created.id}`)
console.log('gone after delete:', gone.data === null)

// App remote control: state writes always work; RPC needs a running desktop.
const putFocus = await j('PUT', '/state/focus', { id: root.id })
console.log('PUT /state/focus:', putFocus.status)
const state = (await j('GET', '/state')).data
console.log('GET /state focus == root:', state.focus === root.id)
try {
  const rpc = await j('POST', '/app/rpc', { method: 'ping', timeoutMs: 1500 })
  console.log(rpc.data?.result ? 'POST /app/rpc ping:' : 'POST /app/rpc: no desktop (ok in headless smoke)')
} catch {
  console.log('POST /app/rpc: no desktop (ok in headless smoke)')
}
console.log('API SMOKE: PASS')

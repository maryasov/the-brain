#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { openRepository, callAppRpc } from '@the-brain/db'
import { computeViewport } from '@the-brain/core'
import type {
  AttachmentKind,
  BrainExport,
  CreateSetInput,
  CreateThoughtInput,
  LinkType,
  SetDef,
  UpdateThoughtInput
} from '@the-brain/shared'

/**
 * TheBrain HTTP API. A tiny, dependency-free JSON server over the same data
 * layer as the desktop app and MCP server — handy for scripts, curl, and
 * agents that speak HTTP instead of MCP.
 *
 * Local-first: binds to 127.0.0.1 by default. Configure with PORT / HOST.
 * DB location: BRAIN_DB_PATH env var, else ~/.config/@the-brain/desktop/brain.db
 */

const repo = openRepository()
const PORT = Number(process.env.PORT ?? 8788)
const HOST = process.env.HOST ?? '127.0.0.1'

type Json = Record<string, unknown>

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS'
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 5_000_000) req.destroy()
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data) as Json)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

async function route(
  method: string,
  segments: string[],
  url: URL,
  body: Json
): Promise<{ status: number; data: unknown } | null> {
  const [head, second, third] = segments

  // ---- reads ----
  if (method === 'GET') {
    if (!head) {
      return {
        status: 200,
        data: {
          name: 'the-brain api',
          endpoints: [
            'GET /root',
            'GET /thought/:id',
            'GET /card/:id',
            'GET /neighborhood/:id',
            'GET /neighborhood/:id?t=<ms> (back in time)',
            'GET /history/:thoughtId?limit=',
            'GET /earliest',
            'GET /viewport/:id',
            'GET /search?q=',
            'GET /pinned',
            'GET /recent?limit=',
            'GET /subgraph/:id?depth=',
            'GET /sets',
            'GET /sets/:id/thoughts',
            'POST /sets',
            'DELETE /sets/:id',
            'GET /export',
            'GET /export/opml',
            'POST /import',
            'POST /import/opml',
            'GET /tags/:thoughtId',
            'GET /attachments/:thoughtId',
            'POST /thoughts',
            'PATCH /thoughts/:id',
            'POST /thoughts/:id/pin',
            'DELETE /thoughts/:id?mode=detach|cascade',
            'POST /links',
            'PUT /links',
            'DELETE /links',
            'POST /tags',
            'DELETE /tags',
            'POST /attachments',
            'DELETE /attachments',
            'GET /state',
            'PUT /state/focus',
            'POST /app/rpc',
            'GET /app/screenshot'
          ]
        }
      }
    }
    if (head === 'health') return { status: 200, data: { ok: true } }
    if (head === 'root') return { status: 200, data: repo.getOrCreateRoot() }
    if (head === 'thought' && second) return { status: 200, data: repo.getThought(second) }
    if (head === 'card' && second) return { status: 200, data: repo.getThoughtCard(second) }
    if (head === 'neighborhood' && second) {
      const t = Number(url.searchParams.get('t'))
      return {
        status: 200,
        data:
          Number.isFinite(t) && t > 0
            ? repo.getNeighborhoodAsOf(second, t)
            : repo.getNeighborhood(second)
      }
    }
    if (head === 'history' && second) {
      const limit = Number(url.searchParams.get('limit') ?? 30)
      return { status: 200, data: repo.listHistory(second, Number.isFinite(limit) ? limit : 30) }
    }
    if (head === 'earliest') return { status: 200, data: { earliest: repo.earliestActivity() } }
    if (head === 'viewport' && second) {
      const nb = repo.getNeighborhood(second)
      return { status: 200, data: nb ? computeViewport(nb) : null }
    }
    if (head === 'search')
      return { status: 200, data: repo.search(url.searchParams.get('q') ?? '') }
    if (head === 'pinned') return { status: 200, data: repo.listPinned() }
    if (head === 'recent') {
      const limit = Number(url.searchParams.get('limit') ?? 24)
      return { status: 200, data: repo.listRecent(Number.isFinite(limit) ? limit : 24) }
    }
    if (head === 'subgraph' && second) {
      const depth = Number(url.searchParams.get('depth') ?? 2)
      return { status: 200, data: repo.getSubgraph(second, Number.isFinite(depth) ? depth : 2) }
    }
    if (head === 'tags' && second) return { status: 200, data: repo.listTags(second) }
    if (head === 'sets' && second && third === 'thoughts')
      return { status: 200, data: repo.runSet(second) }
    if (head === 'sets' && !second) return { status: 200, data: repo.listSets() }
    if (head === 'attachments' && second)
      return { status: 200, data: repo.listAttachments(second) }
    if (head === 'state' && !second)
      return { status: 200, data: { focus: repo.getAppState('focus') } }
    if (head === 'export' && !second) return { status: 200, data: repo.exportJson() }
  }

  // ---- writes ----
  if (method === 'POST' && head === 'thoughts' && !second) {
    const input: CreateThoughtInput = {
      name: asStr(body.name) ?? 'Untitled',
      description: asStr(body.description) ?? null,
      color: asStr(body.color) ?? null,
      type: asStr(body.type) ?? null,
      parentId: asStr(body.parentId) ?? null,
      linkType: (asStr(body.linkType) as LinkType | undefined) ?? 'child'
    }
    return { status: 201, data: repo.createThought(input) }
  }
  if (method === 'POST' && head === 'thoughts' && second && third === 'pin') {
    return { status: 200, data: repo.setPinned(second, body.pinned === true) }
  }
  if (method === 'PATCH' && head === 'thoughts' && second) {
    const input: UpdateThoughtInput = { id: second }
    const name = asStr(body.name)
    if (name !== undefined) input.name = name
    // An explicit null clears description/color/type (absent key = leave unchanged).
    if ('description' in body) input.description = asStr(body.description) ?? null
    if ('color' in body) input.color = asStr(body.color) ?? null
    if ('type' in body) input.type = asStr(body.type) ?? null
    if (typeof body.pinned === 'boolean') input.pinned = body.pinned
    return { status: 200, data: repo.updateThought(input) }
  }
  if (method === 'DELETE' && head === 'thoughts' && second) {
    const mode = url.searchParams.get('mode') === 'cascade' ? 'cascade' : 'detach'
    repo.deleteThought(second, { mode })
    return { status: 200, data: { ok: true } }
  }
  if (method === 'POST' && head === 'sets' && !second) {
    const d = (body.def ?? {}) as Record<string, unknown>
    const input: CreateSetInput = {
      name: asStr(body.name) ?? 'Untitled set',
      description: asStr(body.description) ?? null,
      def: {
        text: asStr(d.text) ?? undefined,
        type: asStr(d.type) ?? undefined,
        tag: asStr(d.tag) ?? undefined
      } satisfies SetDef
    }
    return { status: 201, data: repo.createSet(input) }
  }
  if (method === 'DELETE' && head === 'sets' && second) {
    repo.deleteSet(second)
    return { status: 200, data: { ok: true } }
  }
  // Import a full JSON snapshot (merged by id; nothing is deleted). The body is
  // exactly what GET /export returns.
  if (method === 'POST' && head === 'import' && !second) {
    const doc = body as unknown as BrainExport
    if (!Array.isArray(doc.thoughts))
      return { status: 400, data: { error: 'import body must be a BrainExport JSON (missing thoughts[])' } }
    return { status: 200, data: repo.importJson(doc) }
  }
  // Import an OPML outline as a thought hierarchy under parentId (default:
  // root). Existing thought names are reused, never duplicated.
  if (method === 'POST' && head === 'import' && second === 'opml') {
    const xml = asStr(body.xml)
    if (!xml) return { status: 400, data: { error: 'body.xml required' } }
    const parentId = asStr(body.parentId) ?? repo.getOrCreateRoot().id
    return { status: 200, data: repo.importOpml(xml, parentId) }
  }
  if (method === 'POST' && head === 'links') {
    return {
      status: 201,
      data: repo.link({
        fromId: asStr(body.fromId) ?? '',
        toId: asStr(body.toId) ?? '',
        type: (asStr(body.type) as LinkType) ?? 'child',
        label: asStr(body.label),
        notes: asStr(body.notes)
      })
    }
  }
  // Update a link's label/notes. Omitted fields stay unchanged; empty
  // strings clear them. Jumps resolve in either direction, like DELETE.
  if (method === 'PUT' && head === 'links') {
    const link = repo.setLinkInfo({
      fromId: asStr(body.fromId) ?? '',
      toId: asStr(body.toId) ?? '',
      type: (asStr(body.type) as LinkType) ?? 'child',
      ...(body.label !== undefined ? { label: asStr(body.label) } : {}),
      ...(body.notes !== undefined ? { notes: asStr(body.notes) } : {})
    })
    if (!link) return { status: 404, data: { error: 'no such link' } }
    return { status: 200, data: link }
  }
  if (method === 'DELETE' && head === 'links') {
    repo.unlink(
      asStr(body.fromId) ?? '',
      asStr(body.toId) ?? '',
      (asStr(body.type) as LinkType) ?? 'child'
    )
    return { status: 200, data: { ok: true } }
  }
  if (method === 'POST' && head === 'tags') {
    return { status: 200, data: repo.addTag(asStr(body.thoughtId) ?? '', asStr(body.name) ?? '') }
  }
  if (method === 'DELETE' && head === 'tags') {
    return {
      status: 200,
      data: repo.removeTag(asStr(body.thoughtId) ?? '', asStr(body.tagId) ?? '')
    }
  }
  if (method === 'POST' && head === 'attachments') {
    return {
      status: 201,
      data: repo.addAttachment({
        thoughtId: asStr(body.thoughtId) ?? '',
        kind: (asStr(body.kind) as AttachmentKind) ?? 'url',
        uri: asStr(body.uri) ?? '',
        label: asStr(body.label) ?? null,
        mime: asStr(body.mime) ?? null
      })
    }
  }
  if (method === 'DELETE' && head === 'attachments') {
    return {
      status: 200,
      data: repo.removeAttachment(asStr(body.thoughtId) ?? '', asStr(body.id) ?? '')
    }
  }
  // Drive the running desktop window: publish a new focus for it to pick up.
  if (method === 'PUT' && head === 'state' && second === 'focus') {
    const id = asStr(body.id) ?? ''
    const thought = repo.getThought(id)
    if (!thought) return { status: 404, data: { error: `Thought ${id} not found` } }
    repo.setAppState('focus', id)
    return { status: 200, data: thought }
  }
  // Generic remote control of the desktop process (ping / screenshot / get_view…).
  if (method === 'POST' && head === 'app' && second === 'rpc') {
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined
    const result = await callAppRpc(repo, asStr(body.method) ?? '', body.params, timeoutMs)
    return { status: 200, data: { result } }
  }

  return null
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const method = req.method ?? 'GET'
  if (method === 'OPTIONS') return send(res, 204, {})
  try {
    // PUT routes (/state/focus) carry JSON bodies too.
    const body =
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? await readBody(req)
        : {}
    const segments = url.pathname.split('/').filter(Boolean)
    // Text routes that must not be JSON-wrapped: the OPML export.
    if (method === 'GET' && segments[0] === 'export' && segments[1] === 'opml') {
      const xml = repo.exportOpml()
      res.writeHead(200, {
        'Content-Type': 'text/x-opml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="the-brain.opml"',
        'Access-Control-Allow-Origin': '*'
      })
      return res.end(xml)
    }
    // Binary convenience route: raw PNG straight from the desktop window.
    if (method === 'GET' && segments[0] === 'app' && segments[1] === 'screenshot') {
      const shot = (await callAppRpc(repo, 'screenshot')) as { pngBase64: string }
      const png = Buffer.from(shot.pngBase64, 'base64')
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Access-Control-Allow-Origin': '*'
      })
      return res.end(png)
    }
    const result = await route(method, segments, url, body)
    if (!result) return send(res, 404, { error: `no route: ${method} ${url.pathname}` })
    return send(res, result.status, result.data)
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`the-brain API listening on http://${HOST}:${PORT}`)
  console.log(`db: ${process.env.BRAIN_DB_PATH ?? '~/.config/@the-brain/desktop/brain.db'}`)
})

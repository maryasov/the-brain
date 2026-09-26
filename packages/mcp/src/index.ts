#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { openRepository, callAppRpc } from '@the-brain/db'
import { computeViewport } from '@the-brain/core'
import type {
  AttachmentKind,
  BrainExport,
  CreateThoughtInput,
  DeleteOptions,
  LinkType,
  UpdateThoughtInput
} from '@the-brain/shared'

/**
 * TheBrain MCP server. Exposes the local brain graph to AI agents over the
 * Model Context Protocol (stdio transport). Backed by the exact same data
 * layer as the desktop app, so agents and humans operate on one shared brain.
 *
 * DB location: BRAIN_DB_PATH env var, else ~/.config/@the-brain/desktop/brain.db
 */

const repo = openRepository()

type Args = Record<string, unknown>
const str = (a: Args, k: string): string => {
  const v = a[k]
  if (typeof v !== 'string') throw new Error(`missing string argument: ${k}`)
  return v
}
const optStr = (a: Args, k: string): string | undefined =>
  typeof a[k] === 'string' ? (a[k] as string) : undefined
const bool = (a: Args, k: string): boolean => a[k] === true

// ---- tool definitions (JSON Schema; no runtime validation dependency) -----

const TOOLS = [
  {
    name: 'brain_get_root',
    description: 'Get the root thought ("My Brain"). Create it if absent.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_get_thought',
    description: 'Fetch a single thought by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'brain_get_card',
    description:
      'Hover card for a thought: description, tags, and parent/child/jump/sibling/attachment counts.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'brain_get_neighborhood',
    description:
      'Raw 1-hop neighborhood of a focus thought: the focus, all neighbor thoughts, and the links between them. Pass at=<ms> to see it as it stood at a past timestamp (Back in Time).',
    inputSchema: {
      type: 'object',
      properties: {
        focusId: { type: 'string' },
        at: {
          type: 'number',
          description: 'Optional Unix timestamp (ms) to replay the graph as of that moment'
        }
      },
      required: ['focusId']
    }
  },
  {
    name: 'brain_list_history',
    description:
      'Journal of events touching a thought: created, renamed, deleted, links/jumps added or removed.',
    inputSchema: {
      type: 'object',
      properties: {
        thoughtId: { type: 'string' },
        limit: { type: 'number', description: 'Max events to return (default 30, cap 200)' }
      },
      required: ['thoughtId']
    }
  },
  {
    name: 'brain_list_recent',
    description:
      'The timeline ("Quiet Eye"): the most recently created or updated thoughts, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max thoughts to return (default 24, cap 200)' } }
    }
  },
  {
    name: 'brain_get_subgraph',
    description:
      'Depth-hop subgraph around a center thought (both link directions), for minimap-style overviews: returns { focus, thoughts, links }.',
    inputSchema: {
      type: 'object',
      properties: {
        centerId: { type: 'string' },
        depth: { type: 'number', description: 'Link hops to expand (1-3, default 2)' }
      },
      required: ['centerId']
    }
  },
  {
    name: 'brain_list_sets',
    description:
      'List saved filtered sets (TheBrain "filtered sets"): named searches with a {text?, type?, tag?} definition.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_create_set',
    description:
      'Save a filtered set — a named search over the whole brain. At least one of text (FTS prefix match), type (exact, case-insensitive), tag (exact name) must be non-empty; present filters are AND-ed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        text: { type: 'string', description: 'Free-text filter (searches names + descriptions)' },
        type: { type: 'string', description: 'Thought type filter, e.g. person' },
        tag: { type: 'string', description: 'Tag name filter' }
      },
      required: ['name']
    }
  },
  {
    name: 'brain_run_set',
    description: 'Execute a saved filtered set by id; returns the matching thoughts, newest first.',
    inputSchema: {
      type: 'object',
      properties: { setId: { type: 'string' } },
      required: ['setId']
    }
  },
  {
    name: 'brain_delete_set',
    description: 'Delete a saved filtered set by id.',
    inputSchema: {
      type: 'object',
      properties: { setId: { type: 'string' } },
      required: ['setId']
    }
  },
  {
    name: 'brain_export',
    description:
      'Export a full portable JSON snapshot of the brain (thoughts, links, tags, attachments, filtered sets). Feed it to brain_import_json elsewhere; nothing is modified.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_export_opml',
    description:
      'Export the parent→child hierarchy as OPML 2.0 outline text (TheBrain-compatible exchange format). Returns the raw document.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_import_json',
    description:
      'Merge a brain_export JSON snapshot into this brain. Ids are preserved, known records are skipped, nothing is deleted. Returns counts of newly imported records.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'object', description: 'A BrainExport snapshot (from brain_export)' }
      },
      required: ['document']
    }
  },
  {
    name: 'brain_import_opml',
    description:
      'Import an OPML outline as a thought hierarchy. Existing thought names are reused (case-insensitive), never duplicated; top-level entries hang under parentId (default: the root thought). Returns counts of what was created.',
    inputSchema: {
      type: 'object',
      properties: {
        xml: { type: 'string', description: 'The OPML document text' },
        parentId: { type: 'string', description: 'Thought to nest top-level entries under (optional)' }
      },
      required: ['xml']
    }
  },
  {
    name: 'brain_navigate',
    description:
      'TheBrain view: a focus thought grouped into parents, children, jumps and (derived) siblings. This is how you "see" a node\'s relationships.',
    inputSchema: {
      type: 'object',
      properties: { focusId: { type: 'string' } },
      required: ['focusId']
    }
  },
  {
    name: 'brain_get_app_state',
    description:
      'Read the running desktop app\'s view state: which thought id it currently focuses (null if none).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_set_app_focus',
    description:
      'Drive the running desktop app: move its visible window to focus the given thought. Does nothing if the desktop app is not running.',
    inputSchema: {
      type: 'object',
      properties: { thoughtId: { type: 'string' } },
      required: ['thoughtId']
    }
  },
  {
    name: 'brain_app_rpc',
    description:
      'Call the running desktop app directly (full remote control for debugging). Methods: "ping" (alive + current focus), "screenshot" (PNG base64 of the window, no focus stealing), "get_view" (live renderer state: focus, selection, role counts, layout node coordinates), "ui" (run a renderer action; params: {action, args}) with actions: reload, navigate {id}, back, forward, select {dir:up|down|left|right}, commit, toggle_inspector, toggle_timeline, toggle_sets, set_type {type} (on the focused thought; empty string clears), create_set {name,def:{text?,type?,tag?}}, run_set {setId} (opens the Sets panel and shows its hits; setId "" clears the run), delete_set {setId}, set_dialog {kind} (open/close the create/rename/delete modal; kind one of addChild|addParent|addJump|addSibling|rename|delete, omit to close), link {from,to,type:jump|child}, sim_drag {from,to,type} (replays a real drag gesture via DOM events), sim_click {id?,dx?,dy?} (replays a click offset from a node in layout units — tests gate/zone creation routing; returns the dialog it opened), add_attachment {kind,uri,label?} / remove_attachment {attachmentId} (on the focused thought), add_child {name}, add_parent {name}, add_jump {name}, add_sibling {name}, rename {id,name}, delete {id,mode}, toggle_pin {id,pinned}, add_tag {name}, remove_tag {tagId}. Any other method name is rejected by the app.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        params: { description: 'Method-specific params (JSON value).', type: 'object' }
      },
      required: ['method']
    }
  },
  {
    name: 'brain_app_screenshot',
    description:
      'Capture the running desktop app window as a PNG image (rendered offscreen; does NOT steal focus). Use to visually verify graph layout / navigation without touching the mouse.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_search',
    description: 'Full-text (prefix) search over thought names and descriptions.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'brain_list_pinned',
    description: 'List pinned (pinboard) thoughts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'brain_list_tags',
    description: 'List tags attached to a thought.',
    inputSchema: {
      type: 'object',
      properties: { thoughtId: { type: 'string' } },
      required: ['thoughtId']
    }
  },
  {
    name: 'brain_list_attachments',
    description: 'List a thought\'s attachments: files, URLs, images, and anchor thoughts.',
    inputSchema: {
      type: 'object',
      properties: { thoughtId: { type: 'string' } },
      required: ['thoughtId']
    }
  },
  {
    name: 'brain_add_attachment',
    description:
      'Attach content to a thought. kind="url"/"image": uri is a link; kind="file": uri is an absolute path; kind="thought": uri is another thought\'s id (an anchor reference, not a graph link).',
    inputSchema: {
      type: 'object',
      properties: {
        thoughtId: { type: 'string' },
        kind: { type: 'string', enum: ['file', 'url', 'image', 'thought'] },
        uri: { type: 'string' },
        label: { type: 'string' }
      },
      required: ['thoughtId', 'kind', 'uri']
    }
  },
  {
    name: 'brain_remove_attachment',
    description: 'Remove an attachment by id.',
    inputSchema: {
      type: 'object',
      properties: { thoughtId: { type: 'string' }, id: { type: 'string' } },
      required: ['thoughtId', 'id']
    }
  },
  {
    name: 'brain_create_thought',
    description:
      'Create a thought. Optionally attach it under parentId (linkType "child" by default, or "jump").',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        color: { type: 'string', description: 'Hex color, e.g. #ff8800' },
        type: {
          type: 'string',
          description: 'Thought type, e.g. person | project | book (free-form)'
        },
        parentId: { type: 'string' },
        linkType: { type: 'string', enum: ['child', 'jump'] }
      },
      required: ['name']
    }
  },
  {
    name: 'brain_update_thought',
    description: "Update a thought's name, description, color, type, or pinned flag.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        color: { type: 'string' },
        type: {
          type: 'string',
          description: 'Thought type; pass empty string to clear the type'
        },
        pinned: { type: 'boolean' }
      },
      required: ['id']
    }
  },
  {
    name: 'brain_delete_thought',
    description:
      'Delete a thought. mode="detach" only unlinks it; mode="cascade" deletes it and its exclusively-owned descendants.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['detach', 'cascade'] } },
      required: ['id', 'mode']
    }
  },
  {
    name: 'brain_link',
    description:
      'Create a link. type="child" is directed (fromId=parent -> toId=child); type="jump" is an undirected association.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string' },
        toId: { type: 'string' },
        type: { type: 'string', enum: ['child', 'jump'] }
      },
      required: ['fromId', 'toId', 'type']
    }
  },
  {
    name: 'brain_unlink',
    description: 'Remove a link (jumps match in either direction).',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string' },
        toId: { type: 'string' },
        type: { type: 'string', enum: ['child', 'jump'] }
      },
      required: ['fromId', 'toId', 'type']
    }
  },
  {
    name: 'brain_set_pinned',
    description: 'Pin or unpin a thought to the pinboard.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, pinned: { type: 'boolean' } },
      required: ['id', 'pinned']
    }
  },
  {
    name: 'brain_add_tag',
    description: 'Add (or reuse) a tag on a thought.',
    inputSchema: {
      type: 'object',
      properties: { thoughtId: { type: 'string' }, name: { type: 'string' } },
      required: ['thoughtId', 'name']
    }
  },
  {
    name: 'brain_remove_tag',
    description: 'Remove a tag from a thought by tag id.',
    inputSchema: {
      type: 'object',
      properties: { thoughtId: { type: 'string' }, tagId: { type: 'string' } },
      required: ['thoughtId', 'tagId']
    }
  }
]

// ---- dispatch --------------------------------------------------------------

async function handle(name: string, a: Args): Promise<unknown> {
  switch (name) {
    case 'brain_get_root':
      return repo.getOrCreateRoot()
    case 'brain_get_thought':
      return repo.getThought(str(a, 'id'))
    case 'brain_get_card':
      return repo.getThoughtCard(str(a, 'id'))
    case 'brain_get_neighborhood': {
      const at = typeof a.at === 'number' && Number.isFinite(a.at) && a.at > 0 ? a.at : null
      return at !== null
        ? repo.getNeighborhoodAsOf(str(a, 'focusId'), at)
        : repo.getNeighborhood(str(a, 'focusId'))
    }
    case 'brain_list_history':
      return repo.listHistory(str(a, 'thoughtId'), typeof a.limit === 'number' ? a.limit : 30)
    case 'brain_list_recent':
      return repo.listRecent(typeof a.limit === 'number' ? a.limit : 24)
    case 'brain_get_subgraph':
      return repo.getSubgraph(str(a, 'centerId'), typeof a.depth === 'number' ? a.depth : 2)
    case 'brain_list_sets':
      return repo.listSets()
    case 'brain_create_set':
      return repo.createSet({
        name: str(a, 'name'),
        description: optStr(a, 'description') ?? null,
        def: {
          text: optStr(a, 'text') ?? undefined,
          type: optStr(a, 'type') ?? undefined,
          tag: optStr(a, 'tag') ?? undefined
        }
      })
    case 'brain_run_set':
      return repo.runSet(str(a, 'setId'))
    case 'brain_delete_set':
      return repo.deleteSet(str(a, 'setId')), { ok: true }
    case 'brain_export':
      return repo.exportJson()
    case 'brain_export_opml':
      return { __text: repo.exportOpml() }
    case 'brain_import_json': {
      const doc = a.document as BrainExport
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.thoughts))
        throw new Error('document must be a BrainExport snapshot (missing thoughts[])')
      return repo.importJson(doc)
    }
    case 'brain_import_opml':
      return repo.importOpml(
        str(a, 'xml'),
        optStr(a, 'parentId') ?? repo.getOrCreateRoot().id
      )
    case 'brain_navigate': {
      const nb = repo.getNeighborhood(str(a, 'focusId'))
      return nb ? computeViewport(nb) : null
    }
    case 'brain_get_app_state':
      return { focus: repo.getAppState('focus') }
    case 'brain_set_app_focus': {
      const id = str(a, 'thoughtId')
      const thought = repo.getThought(id)
      if (!thought) throw new Error(`thought ${id} not found`)
      repo.setAppState('focus', id)
      return thought
    }
    case 'brain_app_rpc':
      return { result: await callAppRpc(repo, str(a, 'method'), a.params) }
    case 'brain_app_screenshot':
      return { screenshot: await callAppRpc(repo, 'screenshot') }
    case 'brain_search':
      return repo.search(str(a, 'query'))
    case 'brain_list_pinned':
      return repo.listPinned()
    case 'brain_list_tags':
      return repo.listTags(str(a, 'thoughtId'))
    case 'brain_list_attachments':
      return repo.listAttachments(str(a, 'thoughtId'))
    case 'brain_add_attachment':
      return repo.addAttachment({
        thoughtId: str(a, 'thoughtId'),
        kind: str(a, 'kind') as AttachmentKind,
        uri: str(a, 'uri'),
        label: optStr(a, 'label') ?? null
      })
    case 'brain_remove_attachment':
      return repo.removeAttachment(str(a, 'thoughtId'), str(a, 'id'))
    case 'brain_create_thought': {
      const input: CreateThoughtInput = {
        name: str(a, 'name'),
        description: optStr(a, 'description') ?? null,
        color: optStr(a, 'color') ?? null,
        type: optStr(a, 'type') ?? null,
        parentId: optStr(a, 'parentId') ?? null,
        linkType: (optStr(a, 'linkType') as LinkType | undefined) ?? 'child'
      }
      return repo.createThought(input)
    }
    case 'brain_update_thought': {
      const input: UpdateThoughtInput = { id: str(a, 'id') }
      const name = optStr(a, 'name')
      const description = optStr(a, 'description')
      const color = optStr(a, 'color')
      const type = optStr(a, 'type')
      if (name !== undefined) input.name = name
      if (description !== undefined) input.description = description
      if (color !== undefined) input.color = color
      if (type !== undefined) input.type = type || null
      if (typeof a.pinned === 'boolean') input.pinned = a.pinned
      return repo.updateThought(input)
    }
    case 'brain_delete_thought': {
      const options: DeleteOptions = { mode: str(a, 'mode') === 'cascade' ? 'cascade' : 'detach' }
      repo.deleteThought(str(a, 'id'), options)
      return { ok: true }
    }
    case 'brain_link':
      return repo.link({
        fromId: str(a, 'fromId'),
        toId: str(a, 'toId'),
        type: str(a, 'type') as LinkType
      })
    case 'brain_unlink':
      repo.unlink(str(a, 'fromId'), str(a, 'toId'), str(a, 'type') as LinkType)
      return { ok: true }
    case 'brain_set_pinned':
      return repo.setPinned(str(a, 'id'), bool(a, 'pinned'))
    case 'brain_add_tag':
      return repo.addTag(str(a, 'thoughtId'), str(a, 'name'))
    case 'brain_remove_tag':
      return repo.removeTag(str(a, 'thoughtId'), str(a, 'tagId'))
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

// ---- server wiring ---------------------------------------------------------

const server = new Server({ name: 'the-brain', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Args
  try {
    const result = await handle(name, args)
    // Tools that must return a raw document (e.g. brain_export_opml) wrap it
    // in { __text } so agents get the file content, not a JSON-escaped string.
    const raw = (result as { __text?: string })?.__text
    if (typeof raw === 'string') {
      return { content: [{ type: 'text', text: raw }] }
    }
    // brain_app_screenshot returns { screenshot: {pngBase64,…} }: hand the
    // agent a real MCP image content block instead of a wall of base64.
    const shot = (result as { screenshot?: { pngBase64: string; width: number; height: number } })
      ?.screenshot
    if (shot?.pngBase64) {
      return {
        content: [
          { type: 'image', data: shot.pngBase64, mimeType: 'image/png' },
          {
            type: 'text',
            text: JSON.stringify({ width: shot.width, height: shot.height }, null, 2)
          }
        ]
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr never touches the JSON-RPC channel — safe for logs.
  console.error(`the-brain MCP server ready (db: ${process.env.BRAIN_DB_PATH ?? 'default'})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

import { create } from 'zustand'
import type {
  Attachment,
  AttachmentKind,
  BrainEvent,
  ImportResult,
  LinkType,
  Neighborhood,
  SetDef,
  Thought,
  ThoughtSet,
  Tag,
  ThoughtCard
} from '@the-brain/shared'
import { computeViewport, layoutViewport, ringLayout, type Viewport, type Layout, type RingLayout } from '@the-brain/core'

type Direction = 'up' | 'down' | 'left' | 'right'

/** Which modal the toolbar / gate clicks / zone clicks open. */
export type DialogKind =
  | 'addChild'
  | 'addParent'
  | 'addJump'
  | 'addSibling'
  | 'rename'
  | 'delete'

/** Guard so the remote-focus subscription is installed once. */
let remoteFocusSubscribed = false

/**
 * Hover-card state: a tooltip anchored to the cursor (window coordinates),
 * plus a small cache so re-hovering the same thought is instant. Cleared on
 * every reload — edits elsewhere must not show up stale.
 */
export interface HoverTip {
  card: ThoughtCard
  x: number
  y: number
}
const cardCache = new Map<string, ThoughtCard>()
let hoverToken = 0

interface BrainState {
  focusId: string | null
  neighborhood: Neighborhood | null
  viewport: Viewport | null
  layout: Layout | null
  selectedId: string | null
  past: string[]
  future: string[]
  pinned: Thought[]
  tags: Tag[]
  attachments: Attachment[]
  recent: Thought[]
  minimap: RingLayout | null
  history: BrainEvent[]
  asOf: number | null
  earliest: number | null
  sets: ThoughtSet[]
  setsOpen: boolean
  activeSetId: string | null
  setResults: Thought[]
  loading: boolean
  error: string | null
  inspectorOpen: boolean
  timelineOpen: boolean
  dialog: DialogKind | null
  hoverTip: HoverTip | null

  init(): Promise<void>
  focus(id: string, opts?: { record?: boolean }): Promise<void>
  reload(): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>

  toggleInspector(): void
  toggleTimeline(): void
  toggleSets(): void
  refreshSets(): Promise<void>
  createSet(name: string, def: SetDef): Promise<void>
  deleteSet(id: string): Promise<void>
  runSet(id: string | null): Promise<void>
  exportBrain(): Promise<string | null>
  importBrain(): Promise<ImportResult | null>
  openDialog(kind: DialogKind | null): void
  saveThought(patch: {
    name?: string
    description?: string | null
    color?: string | null
    type?: string | null
  }): Promise<void>

  moveSelection(dir: Direction): void
  commitSelection(): Promise<void>

  addChild(name: string): Promise<void>
  addParent(name: string): Promise<void>
  addJump(name: string): Promise<void>
  addSibling(name: string): Promise<void>
  linkThoughts(fromId: string, toId: string, type: LinkType): Promise<void>
  rename(id: string, name: string): Promise<void>
  remove(id: string, mode: 'detach' | 'cascade'): Promise<void>
  togglePin(id: string, pinned: boolean): Promise<void>
  refreshPinned(): Promise<void>
  addTag(name: string): Promise<void>
  removeTag(tagId: string): Promise<void>
  addAttachment(kind: AttachmentKind, uri: string, label?: string): Promise<void>
  removeAttachment(id: string): Promise<void>
  openAttachment(att: Attachment): Promise<void>
  resolveThought(name: string): Promise<string | null>
  loadAux(id: string): Promise<void>
  showHover(id: string, x: number, y: number): Promise<void>
  hideHover(): void
  setAsOf(t: number | null): Promise<void>
}

export const useBrain = create<BrainState>((set, get) => ({
  focusId: null,
  neighborhood: null,
  viewport: null,
  layout: null,
  selectedId: null,
  past: [],
  future: [],
  pinned: [],
  tags: [],
  attachments: [],
  recent: [],
  minimap: null,
  history: [],
  asOf: null,
  earliest: null,
  sets: [],
  setsOpen: false,
  activeSetId: null,
  setResults: [],
  loading: true,
  error: null,
  inspectorOpen: false,
  timelineOpen: false,
  dialog: null,
  hoverTip: null,

  async init() {
    try {
      const root = await window.brain.getOrCreateRoot()
      set({ earliest: await window.brain.getEarliestActivity() })
      await get().focus(root.id, { record: false })
      await get().refreshPinned()
      await get().refreshSets()
      // Let external agents (HTTP API / MCP) drive the window: when the shared
      // app_state 'focus' changes outside this renderer, navigate to it.
      if (!remoteFocusSubscribed) {
        remoteFocusSubscribed = true
        window.brain.onAppFocus((id) => {
          if (id && id !== get().focusId) void get().focus(id, { record: false })
        })
      }
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ loading: false })
    }
  },

  async focus(id, opts = {}) {
    const { record = true } = opts
    const state = get()
    if (record && state.focusId && state.focusId !== id) {
      set((s) => ({ past: [...s.past, s.focusId as string], future: [] }))
    }
    try {
      const nb = get().asOf
        ? await window.brain.getNeighborhoodAsOf(id, get().asOf as number)
        : await window.brain.getNeighborhood(id)
      if (!nb) {
        set({ error: `Thought ${id} not found` })
        return
      }
      const viewport = computeViewport(nb)
      const layout = layoutViewport(viewport)
      const tags = await window.brain.listTags(id)
      const attachments = await window.brain.listAttachments(id)
      set({
        focusId: id,
        neighborhood: nb,
        viewport,
        layout,
        selectedId: id,
        tags,
        attachments,
        error: null
      })
      void get().loadAux(id)
      // Publish our position so agents can see / take over the current focus.
      void window.brain.setAppState('focus', id)
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async reload() {
    cardCache.clear()
    const id = get().focusId
    if (!id) return
    const nb = get().asOf
      ? await window.brain.getNeighborhoodAsOf(id, get().asOf as number)
      : await window.brain.getNeighborhood(id)
    if (!nb) return
    const viewport = computeViewport(nb)
    const layout = layoutViewport(viewport)
    const tags = await window.brain.listTags(id)
    const attachments = await window.brain.listAttachments(id)
    set({ neighborhood: nb, viewport, layout, tags, attachments })
    void get().loadAux(id)
  },

  // Secondary views (timeline + minimap): refresh after every focus/reload,
  // but never block or fail the main navigation on their account.
  async loadAux(id) {
    try {
      const [recent, sub, history] = await Promise.all([
        window.brain.listRecent(20),
        window.brain.getSubgraph(id, 2),
        window.brain.listHistory(id, 12)
      ])
      set({ recent, minimap: sub ? ringLayout(sub) : null, history })
    } catch {
      /* auxiliary data is best-effort */
    }
  },

  async back() {
    const { past, focusId } = get()
    if (!past.length || !focusId) return
    const prev = past[past.length - 1]
    set((s) => ({ past: s.past.slice(0, -1), future: [focusId, ...s.future] }))
    await get().focus(prev, { record: false })
  },

  async forward() {
    const { future, focusId } = get()
    if (!future.length || !focusId) return
    const next = future[0]
    set((s) => ({ future: s.future.slice(1), past: [...s.past, focusId] }))
    await get().focus(next, { record: false })
  },

  moveSelection(dir) {
    const { layout, selectedId } = get()
    if (!layout) return
    const current = selectedId ? layout.byId[selectedId] : null

    // Moving onto a band from the focus (or a different band) enters it.
    // Zones per TheBrain 13: parents up, children down, jumps left, siblings right.
    const bandFor = (d: Direction) =>
      d === 'up' ? 'parent' : d === 'down' ? 'child' : d === 'left' ? 'jump' : 'sibling'
    const targetRole = bandFor(dir)
    const band = layout.nodes
      .filter((n) => n.role === targetRole)
      .sort((a, b) =>
        targetRole === 'parent' || targetRole === 'child' ? a.x - b.x : a.y - b.y
      )
    if (band.length === 0) return

    if (current && current.role === targetRole) {
      const idx = band.findIndex((n) => n.id === current.id)
      const next = band[(idx + 1) % band.length]
      set({ selectedId: next.id })
    } else {
      set({ selectedId: band[0].id })
    }
  },

  async commitSelection() {
    const { selectedId, focusId } = get()
    if (selectedId && selectedId !== focusId) await get().focus(selectedId)
  },

  toggleInspector() {
    set((s) => ({ inspectorOpen: !s.inspectorOpen }))
  },

  toggleTimeline() {
    set((s) => ({ timelineOpen: !s.timelineOpen }))
  },

  toggleSets() {
    set((s) => ({ setsOpen: !s.setsOpen }))
  },

  // ---- filtered sets -------------------------------------------------------

  async refreshSets() {
    try {
      set({ sets: await window.brain.listSets() })
    } catch {
      /* sets are auxiliary; never break navigation on their account */
    }
  },

  async createSet(name, def) {
    if (!name.trim()) return
    await window.brain.createSet({ name, def })
    await get().refreshSets()
  },

  async deleteSet(id) {
    await window.brain.deleteSet(id)
    set((s) =>
      s.activeSetId === id ? { activeSetId: null, setResults: [] } : {}
    )
    await get().refreshSets()
  },

  async runSet(id) {
    if (!id) return set({ activeSetId: null, setResults: [] })
    set({ activeSetId: id, setResults: await window.brain.runSet(id) })
  },

  // ---- export / import -----------------------------------------------------

  // Native save-dialog export of the whole brain; returns the written path or
  // null when cancelled. Pure human path (the API/MCP export the same data).
  async exportBrain() {
    return window.brain.exportBrainFile()
  },

  // Native open-dialog import; on success refresh every view so the newly
  // merged thoughts/sets/tags show up without a manual reload.
  async importBrain() {
    const res = await window.brain.importBrainFile()
    if (res) {
      await get().refreshPinned()
      await get().refreshSets()
      await get().reload()
    }
    return res
  },

  openDialog(kind) {
    set({ dialog: kind })
  },

  async saveThought(patch) {
    const id = get().focusId
    if (!id) return
    await window.brain.updateThought({ id, ...patch })
    await get().reload()
    await get().refreshPinned()
  },

  async addChild(name) {
    const { focusId } = get()
    if (!focusId || !name.trim()) return
    await window.brain.createThought({ name, parentId: focusId, linkType: 'child' })
    await get().reload()
  },

  async addParent(name) {
    const { focusId } = get()
    if (!focusId || !name.trim()) return
    const created = await window.brain.createThought({ name })
    await window.brain.link({ fromId: created.id, toId: focusId, type: 'child' })
    await get().reload()
  },

  async addJump(name) {
    const { focusId } = get()
    if (!focusId || !name.trim()) return
    const created = await window.brain.createThought({ name })
    await window.brain.link({ fromId: focusId, toId: created.id, type: 'jump' })
    await get().reload()
  },

  // Sibling zone: a new child of the focus's first parent. Without a parent
  // there is nothing to be a sibling of, so it degrades to a child.
  async addSibling(name) {
    const { focusId, viewport } = get()
    if (!focusId || !name.trim()) return
    const parent = viewport?.parents[0]
    if (!parent) return get().addChild(name)
    await window.brain.createThought({ name, parentId: parent.id, linkType: 'child' })
    await get().reload()
  },

  // Drag-to-link: associate two existing thoughts (plain drag = jump,
  // shift-drag = parent→child). The repository dedupes identical links.
  async linkThoughts(fromId, toId, type) {
    if (!fromId || !toId || fromId === toId) return
    await window.brain.link({ fromId, toId, type })
    await get().reload()
  },

  async rename(id, name) {
    if (!name.trim()) return
    await window.brain.updateThought({ id, name })
    await get().reload()
  },

  async remove(id, mode) {
    const { focusId, past } = get()
    await window.brain.deleteThought(id, { mode })
    if (id === focusId) {
      const target = past[past.length - 1]
      const root = target ? target : (await window.brain.getOrCreateRoot()).id
      if (target) set((s) => ({ past: s.past.slice(0, -1) }))
      await get().focus(root, { record: false })
    } else {
      await get().reload()
    }
    await get().refreshPinned()
  },

  async togglePin(id, pinned) {
    await window.brain.setPinned(id, pinned)
    await get().refreshPinned()
    await get().reload()
  },

  async refreshPinned() {
    set({ pinned: await window.brain.listPinned() })
  },

  async addTag(name) {
    const id = get().focusId
    if (!id) return
    set({ tags: await window.brain.addTag(id, name) })
  },

  async removeTag(tagId) {
    const id = get().focusId
    if (!id) return
    set({ tags: await window.brain.removeTag(id, tagId) })
  },

  // Attachments. For anchor thoughts, `uri` may be a thought id or a name:
  // exact name match wins, then a unique search hit, else a new thought is
  // created and anchored (TheBrain's "attach by name" behavior).
  async addAttachment(kind, uri, label) {
    const id = get().focusId
    if (!id || !uri.trim()) return
    let target = uri.trim()
    let targetLabel = label ?? null
    if (kind === 'thought') {
      const existing = await get().resolveThought(target)
      if (existing) {
        target = existing
      } else {
        const created = await window.brain.createThought({ name: target })
        target = created.id
      }
      // Show the thought's name, not its uuid, in the attachment row.
      if (!targetLabel) targetLabel = (await window.brain.getThought(target))?.name ?? null
    }
    await window.brain.addAttachment({ thoughtId: id, kind, uri: target, label: targetLabel })
    set({ attachments: await window.brain.listAttachments(id) })
  },

  async removeAttachment(attId) {
    const id = get().focusId
    if (!id) return
    set({ attachments: await window.brain.removeAttachment(id, attId) })
  },

  async openAttachment(att) {
    if (att.kind === 'thought') await get().focus(att.uri)
    else await window.brain.openAttachment(att)
  },

  /** Best-effort name → thought id: exact name, then unique search hit. */
  async resolveThought(name) {
    const clean = name.trim().toLowerCase()
    const hits = await window.brain.search(name)
    const exact = hits.find((h) => h.name.trim().toLowerCase() === clean)
    if (exact) return exact.id
    return hits.length === 1 ? hits[0].id : null
  },

  // Hover tooltip. The token makes late arrivals harmless: if the pointer
  // moved (hideHover / a newer showHover) before the fetch resolved, the
  // stale card is dropped instead of flashing.
  async showHover(id, x, y) {
    const token = ++hoverToken
    try {
      let card = cardCache.get(id)
      if (!card) {
        const fetched = await window.brain.getThoughtCard(id)
        if (fetched) cardCache.set(id, fetched)
        card = fetched ?? undefined
      }
      if (!card || token !== hoverToken) return
      set({ hoverTip: { card, x, y } })
    } catch {
      /* tooltip data is best-effort */
    }
  },

  hideHover() {
    hoverToken++
    if (get().hoverTip) set({ hoverTip: null })
  },

  // Back in Time: null means "now". Writes always hit the present; this only
  // changes how the canvas reads the graph.
  async setAsOf(t) {
    set({ asOf: t })
    await get().reload()
  }
}))

// Live introspection endpoint for app-RPC (`get_view`): external agents can
// see exactly what the renderer holds — focus, selection, layout coordinates —
// without touching the mouse. Read-only; never mutates state.
const debugView = () => {
  const s = useBrain.getState()
  return {
    focusId: s.focusId,
    selectedId: s.selectedId,
    loading: s.loading,
    error: s.error,
    roles: s.viewport
      ? {
          parents: s.viewport.parents.length,
          children: s.viewport.children.length,
          siblings: s.viewport.siblings.length,
          jumps: s.viewport.jumps.length
        }
      : null,
    intimacy: s.viewport?.intimacy ?? null,
    inspectorOpen: s.inspectorOpen,
    timelineOpen: s.timelineOpen,
    setsOpen: s.setsOpen,
    sets: s.sets.map((st) => ({ id: st.id, name: st.name, def: st.def })),
    activeSetId: s.activeSetId,
    setResults: s.setResults.map((t) => ({ id: t.id, name: t.name, type: t.type })),
    dialog: s.dialog,
    hoverTip: s.hoverTip ? { id: s.hoverTip.card.id, name: s.hoverTip.card.name } : null,
    asOf: s.asOf,
    earliest: s.earliest,
    history: s.history.map((e) => ({ kind: e.kind, at: e.at })),
    focusType: s.viewport?.focus.type,
    recent: s.recent.map((t) => ({ id: t.id, name: t.name, updatedAt: t.updatedAt })),
    minimapNodes: s.minimap?.nodes.length ?? 0,
    attachments: s.attachments.map((a) => ({ id: a.id, kind: a.kind, uri: a.uri, label: a.label })),
    nodes:
      s.layout?.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        role: n.role,
        type: n.type,
        x: Math.round(n.x),
        y: Math.round(n.y),
        w: n.w,
        h: n.h
      })) ?? null
  }
}
window.__brainDebug = debugView

// UI action endpoint for app-RPC (`ui`): runs the same store actions the
// keyboard/mouse drive, so agents can navigate and refresh the live window
// programmatically. Returns a small result payload (usually the new view).
type RpcArgs = {
  id?: string
  name?: string
  dir?: string
  mode?: string
  pinned?: boolean
  tagId?: string
  from?: string
  to?: string
  type?: string
  kind?: string
  uri?: string
  label?: string
  attachmentId?: string
  setId?: string
  def?: { text?: string; type?: string; tag?: string }
  t?: number
  dx?: number
  dy?: number
}
window.__brainRpc = async (method: string, args: RpcArgs = {}) => {
  const s = () => useBrain.getState()
  switch (method) {
    case 'get_view':
      return debugView()
    case 'reload': // re-read the neighborhood (e.g. after external API writes)
      await s().reload()
      return debugView()
    case 'navigate':
      if (args.id) await s().focus(args.id)
      return debugView()
    case 'back':
      await s().back()
      return debugView()
    case 'forward':
      await s().forward()
      return debugView()
    case 'select': // move selection with a direction, like the arrow keys
      if (args.dir === 'up' || args.dir === 'down' || args.dir === 'left' || args.dir === 'right')
        s().moveSelection(args.dir)
      return { selectedId: s().selectedId }
    case 'commit': // focus the currently selected node, like Enter
      await s().commitSelection()
      return debugView()
    case 'toggle_inspector':
      s().toggleInspector()
      return { inspectorOpen: s().inspectorOpen }
    case 'toggle_timeline':
      s().toggleTimeline()
      return { timelineOpen: s().timelineOpen }
    case 'toggle_sets':
      s().toggleSets()
      return { setsOpen: s().setsOpen }
    case 'create_set': {
      // Save a filtered set: { name, def: { text?, type?, tag? } } (blanks dropped)
      await s().createSet(String(args.name ?? ''), args.def ?? {})
      return { sets: s().sets.map((st) => ({ id: st.id, name: st.name, def: st.def })) }
    }
    case 'run_set': // open the Sets panel and run a saved set ('' clears the run)
      await s().runSet(args.setId ?? null)
      if (!s().setsOpen) s().toggleSets()
      return {
        activeSetId: s().activeSetId,
        setResults: debugView().setResults
      }
    case 'delete_set':
      if (args.setId) await s().deleteSet(args.setId)
      return { sets: s().sets.map((st) => ({ id: st.id, name: st.name, def: st.def })) }
    case 'set_dialog': // open ('addChild'…'delete') or close (null) the modal
      s().openDialog((args.kind ?? null) as DialogKind | null)
      return { dialog: s().dialog }
    case 'set_type': // assign a thought type to the focus ('' clears it)
      await s().saveThought({ type: args.type?.trim() ? String(args.type).trim() : null })
      return debugView()
    case 'add_child':
      await s().addChild(String(args.name ?? ''))
      return debugView()
    case 'add_parent':
      await s().addParent(String(args.name ?? ''))
      return debugView()
    case 'add_jump':
      await s().addJump(String(args.name ?? ''))
      return debugView()
    case 'add_sibling':
      await s().addSibling(String(args.name ?? ''))
      return debugView()
    case 'sim_click': {
      // Debug-only: dispatch a real click at (dx,dy) layout-offset from a
      // node's center (default: focus), exercising gate/zone hit routing.
      const canvas = document.querySelector('canvas.brain-canvas')
      const layout = s().layout
      if (!canvas || !layout) throw new Error('sim_click: canvas/layout not ready')
      const anchor = layout.byId[args.id ?? s().focusId ?? '']
      if (!anchor) throw new Error('sim_click: anchor node not in current view')
      const rect = canvas.getBoundingClientRect()
      const pad = 120
      const scale = Math.min(
        1,
        (rect.width - pad) / Math.max(1, layout.bounds.width),
        (rect.height - pad) / Math.max(1, layout.bounds.height)
      )
      canvas.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: rect.left + rect.width / 2 + (anchor.x + (args.dx ?? 0)) * scale,
          clientY: rect.top + rect.height / 2 + (anchor.y + (args.dy ?? 0)) * scale
        })
      )
      await new Promise((r) => setTimeout(r, 100))
      return { dialog: s().dialog }
    }
    case 'set_asof': {
      // Back in Time: {t: epoch-ms} views the graph as of that moment;
      // omitting t (or 0) returns to the present.
      await s().setAsOf(typeof args.t === 'number' && args.t > 0 ? args.t : null)
      return debugView()
    }
    case 'hover': {
      // Debug-only: run a real mousemove over a node's center through the
      // canvas handlers (and wait past the tooltip delay), so agents can
      // verify hover cards end to end without any OS mouse input.
      if (!args.id) {
        s().hideHover()
        return { hoverTip: null }
      }
      const canvas = document.querySelector('canvas.brain-canvas')
      const layout = s().layout
      if (!canvas || !layout) throw new Error('hover: canvas/layout not ready')
      const n = layout.byId[args.id]
      if (!n) throw new Error(`hover: node ${args.id} not in current view`)
      const rect = canvas.getBoundingClientRect()
      const pad = 120
      const scale = Math.min(
        1,
        (rect.width - pad) / Math.max(1, layout.bounds.width),
        (rect.height - pad) / Math.max(1, layout.bounds.height)
      )
      canvas.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2 + n.x * scale,
          clientY: rect.top + rect.height / 2 + n.y * scale
        })
      )
      await new Promise((r) => setTimeout(r, 600)) // 350 ms tooltip delay + fetch
      return { hoverTip: debugView().hoverTip }
    }
    case 'link': // drag-to-link between two existing thoughts
      if (args.from && args.to)
        await s().linkThoughts(args.from, args.to, args.type === 'child' ? 'child' : 'jump')
      return debugView()
    case 'sim_drag': {
      // Debug-only: replay a drag gesture through the real DOM handlers, so
      // agents can verify drag-to-link end to end without any OS mouse input.
      if (!args.from || !args.to) throw new Error('sim_drag requires {from,to}')
      const canvas = document.querySelector('canvas.brain-canvas')
      const layout = s().layout
      if (!canvas || !layout) throw new Error('sim_drag: canvas/layout not ready')
      const rect = canvas.getBoundingClientRect()
      const pad = 120
      const scale = Math.min(
        1,
        (rect.width - pad) / Math.max(1, layout.bounds.width),
        (rect.height - pad) / Math.max(1, layout.bounds.height)
      )
      const pt = (id: string) => {
        const n = layout.byId[id]
        if (!n) throw new Error(`sim_drag: node ${id} not in current view`)
        return {
          x: rect.left + rect.width / 2 + n.x * scale,
          y: rect.top + rect.height / 2 + n.y * scale
        }
      }
      const a = pt(args.from)
      const b = pt(args.to)
      const fire = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: x,
            clientY: y,
            shiftKey: args.type === 'child'
          })
        )
      fire('mousedown', a.x, a.y, canvas)
      fire('mousemove', (a.x + b.x) / 2, (a.y + b.y) / 2, window)
      fire('mousemove', b.x, b.y, window)
      fire('mouseup', b.x, b.y, window)
      await new Promise((r) => setTimeout(r, 250)) // let the link + reload land
      return debugView()
    }
    case 'rename':
      if (args.id && args.name) await s().rename(args.id, args.name)
      return debugView()
    case 'delete':
      if (args.id)
        await s().remove(args.id, args.mode === 'cascade' ? 'cascade' : 'detach')
      return debugView()
    case 'toggle_pin':
      if (args.id) await s().togglePin(args.id, args.pinned === true)
      return debugView()
    case 'add_tag':
      if (args.name) await s().addTag(args.name)
      return { tags: s().tags.map((t) => t.name) }
    case 'remove_tag':
      if (args.tagId) await s().removeTag(args.tagId)
      return { tags: s().tags.map((t) => t.name) }
    case 'add_attachment':
      if (args.kind && args.uri)
        await s().addAttachment(args.kind as AttachmentKind, args.uri, args.label)
      return { attachments: debugView().attachments }
    case 'remove_attachment':
      if (args.attachmentId) await s().removeAttachment(args.attachmentId)
      return { attachments: debugView().attachments }
    default:
      throw new Error(`unknown ui rpc method: ${method}`)
  }
}

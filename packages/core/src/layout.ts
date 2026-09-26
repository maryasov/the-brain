import type { Thought } from '@the-brain/shared'
import type { Viewport, NeighborRole } from './navigation.js'

/** Which side of a node's box an edge attaches to. */
export type Side = 'top' | 'bottom' | 'left' | 'right'

/** A node placed in layout space. (x, y) is the box CENTER. */
export interface PositionedNode {
  id: string
  role: 'focus' | NeighborRole
  name: string
  color: string | null
  /** Thought type (drives the node icon in the renderer). */
  type: string | null
  pinned: boolean
  x: number
  y: number
  w: number
  h: number
  /** TheBrain "More" gates: neighbors linked in each direction that are NOT
   * shown in this viewport (omitted when nothing is hidden). */
  hidden?: { parents: number; children: number; jumps: number }
}

export interface Point {
  x: number
  y: number
}

/**
 * An edge between two placed nodes. `sourceId`/`targetId` + `fromSide`/`toSide`
 * let the renderer draw the curve between the (animated) display boxes, so
 * edges stay attached during transitions. Parent->sibling edges are sourced at
 * the parent, matching TheBrain's dynamic grid.
 */
export interface PositionedEdge {
  id: string
  kind: NeighborRole
  directed: boolean
  sourceId: string
  targetId: string
  fromSide: Side
  toSide: Side
  /** TheBrain intimacy of the target vs the focus; render the number when > 1. */
  intimacy: number
  /** Static anchors at layout time (used by tests / non-animated fallbacks). */
  from: Point
  to: Point
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface Layout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  bounds: Bounds
  /** Map thought id -> positioned node for quick lookup in the renderer. */
  byId: Record<string, PositionedNode>
}

/**
 * Layout tuning constants (logical pixels; canvas is translated to viewport
 * center). Geometry follows the four zones defined in TheBrain 13 User Guide
 * (glossary "Zones"):
 *   parent zone ABOVE, child zone BELOW (split into wing stacks),
 *   jump zone to the LEFT, sibling zone to the RIGHT of the active thought.
 */
export const LAYOUT = {
  nodeH: 30,
  minNodeW: 84,
  maxNodeW: 230,
  charW: 7.8,
  padX: 26, // icon dot + horizontal padding
  hGap: 18, // horizontal gap within the parent row
  rowGapY: 8, // vertical gap between stacked nodes in a column/wing

  focusToParentY: 76, // focus center -> parent row center

  focusToChildY: 66, // focus bottom edge -> top row of the child wings
  wingSpacingX: 40, // extra gap between adjacent child wings
  wingHoleX: 0.55, // fraction of focus width kept free under it (wing spacing)
  wingStaggerX: 4, // outward drift per row inside a wing (diagonal cascade)
  wingMaxRows: 8, // max nodes stacked in one wing before adding another
  minChildWings: 2, // TheBrain always spreads children over two wings so the
  // curves from the focus never overlap a shared vertical spine

  jumpGapX: 80, // focus left edge -> first jump column (columns grow leftward)
  jumpMaxRows: 12,
  jumpColGapX: 26,

  siblingGapX: 80, // right edge of focus/parents -> first sibling column
  siblingMaxRows: 12,
  siblingColGapX: 26
} as const

function measure(name: string): number {
  const w = LAYOUT.padX + name.length * LAYOUT.charW
  return Math.max(LAYOUT.minNodeW, Math.min(LAYOUT.maxNodeW, Math.round(w)))
}

function node(t: Thought, role: PositionedNode['role'], x: number, y: number): PositionedNode {
  return {
    id: t.id,
    role,
    name: t.name,
    color: t.color,
    type: t.type,
    pinned: t.pinned,
    x,
    y,
    w: measure(t.name),
    h: LAYOUT.nodeH
  }
}

/** Fixed anchor on a node's box side (used for the converging fan look). */
export function sideAnchor(n: PositionedNode, side: Side): Point {
  switch (side) {
    case 'top':
      return { x: n.x, y: n.y - n.h / 2 }
    case 'bottom':
      return { x: n.x, y: n.y + n.h / 2 }
    case 'left':
      return { x: n.x - n.w / 2, y: n.y }
    case 'right':
      return { x: n.x + n.w / 2, y: n.y }
  }
}

/**
 * Compute the point where the segment center->target exits a node's box.
 * Pure + exported so tests can assert ray-style anchors.
 */
export function boxAnchor(n: PositionedNode, target: Point): Point {
  const dx = target.x - n.x
  const dy = target.y - n.y
  if (dx === 0 && dy === 0) return { x: n.x, y: n.y }
  const hw = n.w / 2
  const hh = n.h / 2
  const scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const s = Math.min(scaleX, scaleY)
  return { x: n.x + dx * s, y: n.y + dy * s }
}

/** Center a horizontal row of nodes on x=0 at the given y; returns placed nodes. */
function placeRow(
  items: Thought[],
  role: NeighborRole,
  centerY: number,
  gap: number
): PositionedNode[] {
  const widths = items.map((t) => measure(t.name))
  const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1)
  let cursor = -total / 2
  const out: PositionedNode[] = []
  items.forEach((t, i) => {
    const w = widths[i]
    const placed = node(t, role, cursor + w / 2, centerY)
    cursor += w + gap
    out.push(placed)
  })
  return out
}

/** Split items into contiguous wings of at most `maxRows`, left to right. */
function splitWings<T>(items: T[], maxRows: number, minWings = 1): T[][] {
  const nWings = Math.max(minWings, Math.ceil(items.length / maxRows))
  const size = Math.ceil(items.length / nWings)
  const wings: T[][] = []
  for (let i = 0; i < items.length; i += size) wings.push(items.slice(i, i + size))
  return wings
}

/**
 * Deterministic "dynamic grid" layout centered on the focus at origin (0,0),
 * reproducing TheBrain's four zones (User Guide glossary "Zones" + refs/
 * screenshots):
 *   - parents in a centered row ABOVE the focus (parent zone)
 *   - children in vertical wing stacks BELOW, hugging the focus but leaving a
 *     hole under it (child zone; matches the two-cluster look in refs)
 *   - jumps stacked in vertical columns in the LEFT zone, at focus level,
 *     linked to the focus's left edge (jump gate)
 *   - siblings stacked in vertical columns in the RIGHT zone, at focus level,
 *     linked to their shared parent (they are the parent's other children)
 * All links leave their source from a single side anchor (top/bottom/left/right
 * edge midpoint), which produces the characteristic converging fan of curves.
 * Coordinates are relative; the renderer translates them to the viewport center.
 */
export function layoutViewport(vp: Viewport): Layout {
  const nodes: PositionedNode[] = []
  const edges: PositionedEdge[] = []

  const focus = node(vp.focus, 'focus', 0, 0)
  nodes.push(focus)

  const addEdge = (
    source: PositionedNode,
    target: PositionedNode,
    kind: NeighborRole,
    directed: boolean,
    fromSide: Side,
    toSide: Side
  ) => {
    edges.push({
      id: `${kind}:${target.id}`,
      kind,
      directed,
      sourceId: source.id,
      targetId: target.id,
      fromSide,
      toSide,
      intimacy: vp.intimacy[target.id] ?? 1,
      from: sideAnchor(source, fromSide),
      to: sideAnchor(target, toSide)
    })
  }

  // --- Parents: centered row directly above the focus ---
  const parentY = -LAYOUT.focusToParentY
  const parents = placeRow(vp.parents, 'parent', parentY, LAYOUT.hGap)
  parents.forEach((p) => {
    nodes.push(p)
    addEdge(focus, p, 'parent', true, 'top', 'bottom')
  })

  // --- Siblings: vertical column(s) in the RIGHT zone, at focus level, each
  // linked to the shared parent (a sibling is the parent's other child) ---
  if (vp.siblings.length > 0) {
    const anchorRight =
      parents.length > 0 ? Math.max(focus.w / 2, ...parents.map((p) => p.x + p.w / 2)) : focus.w / 2
    let colX = anchorRight + LAYOUT.siblingGapX
    const wings = splitWings(vp.siblings, LAYOUT.siblingMaxRows)
    wings.forEach((colItems) => {
      const colW = Math.max(...colItems.map((t) => measure(t.name)))
      const cx = colX + colW / 2
      colX += colW + LAYOUT.siblingColGapX
      const colHeight = colItems.length * LAYOUT.nodeH + (colItems.length - 1) * LAYOUT.rowGapY
      let y = -colHeight / 2 + LAYOUT.nodeH / 2
      colItems.forEach((s) => {
        const placed = node(s, 'sibling', cx, y)
        y += LAYOUT.nodeH + LAYOUT.rowGapY
        nodes.push(placed)
        const src = parents.length > 0 ? nearestParent(parents, placed) : focus
        addEdge(src, placed, 'sibling', parents.length > 0, 'right', 'left')
      })
    })
  }

  // --- Children: vertical wing stacks below the focus ---
  placeChildWings(vp.children, focus, nodes, addEdge)

  // --- Jumps: vertical column(s) in the LEFT zone, on focus level ---
  if (vp.jumps.length > 0) {
    const wings = splitWings(vp.jumps, LAYOUT.jumpMaxRows)
    let colRightEdge = focus.x - focus.w / 2 - LAYOUT.jumpGapX
    wings.forEach((colItems) => {
      const colW = Math.max(...colItems.map((t) => measure(t.name)))
      const cx = colRightEdge - colW / 2
      colRightEdge -= colW + LAYOUT.jumpColGapX
      const colHeight = colItems.length * LAYOUT.nodeH + (colItems.length - 1) * LAYOUT.rowGapY
      let y = -colHeight / 2 + LAYOUT.nodeH / 2
      colItems.forEach((t) => {
        const placed = node(t, 'jump', cx, y)
        y += LAYOUT.nodeH + LAYOUT.rowGapY
        nodes.push(placed)
        addEdge(focus, placed, 'jump', false, 'left', 'right')
      })
    })
  }

  const byId: Record<string, PositionedNode> = {}
  // Attach More-gate counts from the viewport's hidden-neighbor map.
  for (const n of nodes) {
    const h = vp.hidden[n.id]
    if (h && (h.parents.length || h.children.length || h.jumps.length)) {
      n.hidden = { parents: h.parents.length, children: h.children.length, jumps: h.jumps.length }
    }
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const n of nodes) {
    byId[n.id] = n
    minX = Math.min(minX, n.x - n.w / 2)
    maxX = Math.max(maxX, n.x + n.w / 2)
    minY = Math.min(minY, n.y - n.h / 2)
    maxY = Math.max(maxY, n.y + n.h / 2)
  }

  return {
    nodes,
    edges,
    byId,
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
  }
}

function nearestParent(parents: PositionedNode[], sib: PositionedNode): PositionedNode {
  let best = parents[0]
  let bestD = Infinity
  for (const p of parents) {
    const d = Math.abs(p.x - sib.x)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/**
 * Place children in vertical wing stacks below the focus, as in the refs:
 * children ALWAYS spread over at least two wings (left/right of the spine
 * under the focus), so the fanning curves never stack on top of each other.
 * The left wing takes the extra node when the count is odd (Jerry: 7 left /
 * 6 right); more rows than wingMaxRows add further wings outward.
 */
function placeChildWings(
  children: Thought[],
  focus: PositionedNode,
  nodes: PositionedNode[],
  addEdge: (
    s: PositionedNode,
    t: PositionedNode,
    k: NeighborRole,
    d: boolean,
    fs: Side,
    ts: Side
  ) => void
): void {
  if (children.length === 0) return
  const wings = splitWings(children, LAYOUT.wingMaxRows, LAYOUT.minChildWings)
  const widths = wings.map((w) => Math.max(...w.map((t) => measure(t.name))))

  // Horizontal band: wings spaced apart, centered on x=0. A single wing sits
  // directly under the focus; multi-wing bands keep a hole under the focus.
  const hole = wings.length > 1 ? focus.w * LAYOUT.wingHoleX : 0
  const totalW =
    widths.reduce((a, b) => a + b, 0) + hole + LAYOUT.wingSpacingX * (wings.length - 1)
  let cursor = -totalW / 2

  const topY = focus.h / 2 + LAYOUT.focusToChildY + LAYOUT.nodeH / 2
  wings.forEach((wingItems, wi) => {
    const colW = widths[wi]
    const cx = cursor + colW / 2
    cursor += colW + LAYOUT.wingSpacingX + (wi === 0 ? hole : 0)
    const outward = Math.sign(cx)

    wingItems.forEach((th, ri) => {
      const x = cx + outward * ri * LAYOUT.wingStaggerX
      const y = topY + ri * (LAYOUT.nodeH + LAYOUT.rowGapY)
      const placed = node(th, 'child', x, y)
      nodes.push(placed)
      addEdge(focus, placed, 'child', true, 'bottom', 'top')
    })
  })
}

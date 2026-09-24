import type { Neighborhood } from '@the-brain/shared'

/**
 * Minimap layout: a pure, deterministic concentric-ring embedding of a
 * depth-hop subgraph. The focus sits at the center, each BFS ring lands on
 * circle `depth * ringGap`, and nodes keep their parent's angular sector so
 * subtrees stay visually together. UI-free on purpose — the renderer just
 * scales the result into its small canvas.
 */

export interface RingNode {
  id: string
  name: string
  color: string | null
  x: number
  y: number
  depth: number
}

export interface RingLayout {
  nodes: RingNode[]
  /** Links whose both endpoints are in `nodes`, as id pairs. */
  edges: Array<[string, string]>
  /** Max node radius, so a canvas can scale (0,0)-centered content to fit. */
  extent: number
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5)) // per-ring twist avoids spokes

export function ringLayout(nb: Neighborhood, ringGap = 34): RingLayout {
  // Undirected adjacency over the subgraph.
  const adj = new Map<string, string[]>()
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a)!.push(b)
  }
  for (const l of nb.links) {
    add(l.fromId, l.toId)
    add(l.toId, l.fromId)
  }

  // BFS from the focus: depth + the angle of the discovering parent.
  const byId = new Map(nb.thoughts.map((t) => [t.id, t]))
  const depth = new Map<string, number>([[nb.focus.id, 0]])
  const parentAngle = new Map<string, number>([[nb.focus.id, -Math.PI / 2]])
  let frontier = [nb.focus.id]
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb2 of adj.get(id) ?? []) {
        if (depth.has(nb2)) continue
        depth.set(nb2, depth.get(id)! + 1)
        parentAngle.set(nb2, parentAngle.get(id)!)
        next.push(nb2)
      }
    }
    frontier = next
  }

  // Group per ring; sort by (parent angle, name) for stability, then spread
  // evenly over the circle with a per-ring golden twist.
  const rings = new Map<number, string[]>()
  for (const [id, d] of depth) {
    if (!rings.has(d)) rings.set(d, [])
    rings.get(d)!.push(id)
  }
  const nodes: RingNode[] = []
  for (const d of [...rings.keys()].sort((a, b) => a - b)) {
    const ids = rings
      .get(d)!
      .sort(
        (a, b) =>
          parentAngle.get(a)! - parentAngle.get(b)! ||
          (byId.get(a)?.name ?? '').localeCompare(byId.get(b)?.name ?? '')
      )
    const r = d * ringGap
    ids.forEach((id, i) => {
      const a = d === 0 ? 0 : (i / ids.length) * Math.PI * 2 + d * GOLDEN - Math.PI / 2
      const t = byId.get(id)!
      nodes.push({ id, name: t.name, color: t.color, x: Math.cos(a) * r, y: Math.sin(a) * r, depth: d })
    })
  }

  const edges: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const l of nb.links) {
    if (!depth.has(l.fromId) || !depth.has(l.toId)) continue
    const key = l.fromId < l.toId ? `${l.fromId}|${l.toId}` : `${l.toId}|${l.fromId}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push([l.fromId, l.toId])
  }

  return { nodes, edges, extent: Math.max(ringGap, Math.max(...[...depth.values()], 1) * ringGap) }
}

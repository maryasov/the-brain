import type { AttachCounts, HiddenCounts, Thought } from '@the-brain/shared'
import type { Neighborhood } from '@the-brain/shared'

/**
 * Grouped view model of a focus thought's neighborhood, ready for layout.
 * Roles follow TheBrain semantics:
 *  - parents:  thoughts that have a 'child' link INTO focus (parent -> focus)
 *  - children: thoughts focus has a 'child' link OUT TO   (focus -> child)
 *  - jumps:    thoughts associated by an undirected 'jump' link
 *  - siblings: other children of focus's parents (derived, de-duped)
 */
export interface Viewport {
  focus: Thought
  parents: Thought[]
  children: Thought[]
  jumps: Thought[]
  siblings: Thought[]
  /**
   * TheBrain "intimacy": how strongly each shown thought relates to the
   * focus, keyed by thought id. Direct links plus shared neighbors (indirect
   * paths through a third thought); thoughts with score 0 are omitted.
   */
  intimacy: Record<string, number>
  /**
   * TheBrain "More" gates, passed through from the neighborhood: per thought,
   * the ids of linked thoughts that are NOT shown in this viewport.
   */
  hidden: Record<string, HiddenCounts>
  /** Attachment badge counts (live views; empty for as-of replays). */
  attachCounts: Record<string, AttachCounts>
}

/**
 * Pure navigation engine: turns the flat 1-hop neighborhood returned by the
 * repository into a role-grouped viewport. No DB, no UI, fully unit-testable.
 */
export function computeViewport(nb: Neighborhood): Viewport {
  const focusId = nb.focus.id
  const byId = new Map<string, Thought>()
  for (const t of nb.thoughts) byId.set(t.id, t)

  const parentIds = new Set<string>()
  const childIds = new Set<string>()
  const jumpIds = new Set<string>()

  for (const l of nb.links) {
    if (l.type === 'child') {
      if (l.toId === focusId) parentIds.add(l.fromId)
      else if (l.fromId === focusId) childIds.add(l.toId)
    } else if (l.type === 'jump') {
      if (l.fromId === focusId) jumpIds.add(l.toId)
      else if (l.toId === focusId) jumpIds.add(l.fromId)
    }
  }

  // Siblings: children of each parent, excluding the focus and anything already
  // shown in another band (TheBrain hides a thought from siblings if it is, e.g.,
  // also a jump of the focus).
  const shown = new Set<string>([focusId, ...parentIds, ...childIds, ...jumpIds])
  const siblingIds = new Set<string>()
  for (const parentId of parentIds) {
    for (const l of nb.links) {
      if (l.type === 'child' && l.fromId === parentId && !shown.has(l.toId)) {
        siblingIds.add(l.toId)
      }
    }
  }

  const pick = (ids: Set<string>): Thought[] =>
    [...ids].map((id) => byId.get(id)).filter((t): t is Thought => Boolean(t))

  return {
    focus: nb.focus,
    parents: pick(parentIds),
    children: pick(childIds),
    jumps: pick(jumpIds),
    siblings: pick(siblingIds),
    intimacy: computeIntimacy(nb),
    hidden: nb.hidden ?? {},
    attachCounts: nb.attachCounts ?? {}
  }
}

/**
 * Intimacy of the focus vs every other thought in the neighborhood, computed
 * from the undirected view of the returned links:
 *   intimacy(f, n) = direct links between f and n
 *                  + thoughts adjacent to BOTH (excluding f and n themselves)
 * Siblings therefore score 1 via their shared parent, a thought that is both
 * a child and a jump of the focus scores 2, and so on.
 */
export function computeIntimacy(nb: Neighborhood): Record<string, number> {
  const focusId = nb.focus.id
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a)!.add(b)
  }
  const direct = new Map<string, number>()
  for (const l of nb.links) {
    link(l.fromId, l.toId)
    link(l.toId, l.fromId)
    if (l.fromId === focusId) direct.set(l.toId, (direct.get(l.toId) ?? 0) + 1)
    else if (l.toId === focusId) direct.set(l.fromId, (direct.get(l.fromId) ?? 0) + 1)
  }

  const focusNeighbors = adj.get(focusId) ?? new Set<string>()
  const out: Record<string, number> = {}
  for (const t of nb.thoughts) {
    if (t.id === focusId) continue
    const neighbors = adj.get(t.id) ?? new Set<string>()
    let shared = 0
    for (const m of neighbors) {
      if (m !== focusId && m !== t.id && focusNeighbors.has(m)) shared++
    }
    const score = (direct.get(t.id) ?? 0) + shared
    if (score > 0) out[t.id] = score
  }
  return out
}

export type NeighborRole = 'parent' | 'child' | 'jump' | 'sibling'

/** All neighbor thoughts paired with their role (focus excluded). */
export function viewportEntries(vp: Viewport): Array<{ role: NeighborRole; thought: Thought }> {
  return [
    ...vp.parents.map((thought) => ({ role: 'parent' as const, thought })),
    ...vp.children.map((thought) => ({ role: 'child' as const, thought })),
    ...vp.jumps.map((thought) => ({ role: 'jump' as const, thought })),
    ...vp.siblings.map((thought) => ({ role: 'sibling' as const, thought }))
  ]
}

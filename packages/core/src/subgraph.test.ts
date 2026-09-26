import { describe, it, expect } from 'vitest'
import type { Link, Neighborhood, Thought } from '@the-brain/shared'
import { ringLayout } from './subgraph.js'

function t(id: string): Thought {
  return {
    id,
    name: id,
    description: null,
    color: null,
    type: null,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0
  }
}

function l(fromId: string, toId: string, type: Link['type'] = 'child'): Link {
  return { id: `${fromId}-${toId}`, fromId, toId, type, createdAt: 0, label: null, notes: null }
}

function nb(focus: string, thoughts: string[], links: Link[]): Neighborhood {
  return { focus: t(focus), thoughts: thoughts.map(t), links }
}

describe('ringLayout', () => {
  it('puts the focus at the center with depth 0', () => {
    const r = ringLayout(nb('f', ['f'], []))
    expect(r.nodes).toHaveLength(1)
    expect(r.nodes[0]).toMatchObject({ id: 'f', depth: 0, x: 0, y: 0 })
  })

  it('rings grow with BFS depth in both link directions', () => {
    // f -> a -> b, and a jump from f to j: depths 0,1,2,1
    const r = ringLayout(
      nb('f', ['f', 'a', 'b', 'j'], [l('f', 'a'), l('a', 'b'), l('f', 'j', 'jump')])
    )
    const d = Object.fromEntries(r.nodes.map((n) => [n.id, n.depth]))
    expect(d).toEqual({ f: 0, a: 1, b: 2, j: 1 })
    const dist = (id: string) => {
      const n = r.nodes.find((x) => x.id === id)!
      return Math.hypot(n.x, n.y)
    }
    expect(dist('a')).toBeCloseTo(34)
    expect(dist('b')).toBeCloseTo(68)
    expect(r.extent).toBe(68)
  })

  it('dedupes multi-parents and cycles; every node placed once', () => {
    // diamond f->a, f->b, a->c, b->c plus a jump back a->f
    const r = ringLayout(
      nb('f', ['f', 'a', 'b', 'c'], [l('f', 'a'), l('f', 'b'), l('a', 'c'), l('b', 'c'), l('a', 'f', 'jump')])
    )
    const ids = r.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b', 'c', 'f'])
    expect(r.nodes.find((n) => n.id === 'c')!.depth).toBe(2)
    // undirected edge dedupe: f|a appears once despite child + jump rows
    const fa = r.edges.filter(([x, y]) => (x === 'f' && y === 'a') || (x === 'a' && y === 'f'))
    expect(fa).toHaveLength(1)
  })

  it('is deterministic: same input, same coordinates', () => {
    const input = nb('f', ['f', 'a', 'b'], [l('f', 'a'), l('f', 'b')])
    expect(ringLayout(input)).toEqual(ringLayout(input))
  })
})

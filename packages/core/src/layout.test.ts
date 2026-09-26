import { describe, it, expect } from 'vitest'
import type { Thought } from '@the-brain/shared'
import { layoutViewport, boxAnchor, sideAnchor } from './layout.js'
import type { Viewport } from './navigation.js'

function t(id: string, name = id): Thought {
  return {
    id,
    name,
    description: null,
    color: null,
    type: null,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0
  }
}

const empty: Omit<Viewport, 'focus'> = {
  parents: [],
  children: [],
  jumps: [],
  siblings: [],
  intimacy: {},
  hidden: {},
  attachCounts: {},
  linkLabels: {}
}

describe('layoutViewport', () => {
  it('places the focus at the origin', () => {
    const layout = layoutViewport({ focus: t('f'), ...empty })
    const focus = layout.byId['f']
    expect(focus.x).toBe(0)
    expect(focus.y).toBe(0)
    expect(focus.role).toBe('focus')
  })

  it('parents sit above and children below the focus', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      parents: [t('p')],
      children: [t('c')]
    })
    expect(layout.byId['p'].y).toBeLessThan(0)
    expect(layout.byId['c'].y).toBeGreaterThan(0)
  })

  it('jumps sit in the left zone, clear of the focus', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      children: [t('c1'), t('c2'), t('c3')],
      jumps: [t('j')]
    })
    const focus = layout.byId['f']
    const j = layout.byId['j']
    // the whole jump column sits left of the focus's left edge
    expect(j.x + j.w / 2).toBeLessThan(focus.x - focus.w / 2)
    // and links from the focus's left anchor into the jump's right anchor
    const edge = layout.edges.find((e) => e.targetId === 'j')
    expect(edge?.fromSide).toBe('left')
    expect(edge?.toSide).toBe('right')
  })

  it('siblings stack in a vertical column in the right zone', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      parents: [t('p')],
      siblings: [t('s1'), t('s2'), t('s3')]
    })
    const focus = layout.byId['f']
    const s1 = layout.byId['s1']
    const s2 = layout.byId['s2']
    // right of the focus row, at focus level (y ~ 0), stacked downward
    expect(s1.x - s1.w / 2).toBeGreaterThan(focus.x + focus.w / 2)
    expect(s1.y).toBeLessThan(s2.y) // s1 above s2, same column
    expect(Math.round(s1.x)).toBe(Math.round(s2.x))
    // sibling edges are sourced at the shared parent, not the focus
    const edge = layout.edges.find((e) => e.targetId === 's1')
    expect(edge?.sourceId).toBe('p')
    expect(edge?.fromSide).toBe('right')
    expect(edge?.toSide).toBe('left')
  })

  it('siblings without a visible parent still sit right of the focus', () => {
    const layout = layoutViewport({ focus: t('f'), ...empty, siblings: [t('s')] })
    const focus = layout.byId['f']
    const s = layout.byId['s']
    expect(s.y).toBe(0)
    expect(s.x - s.w / 2).toBeGreaterThan(focus.x + focus.w / 2)
    const edge = layout.edges.find((e) => e.targetId === 's')
    expect(edge?.sourceId).toBe('f')
  })

  it('produces one edge per neighbor', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      parents: [t('p1'), t('p2')],
      children: [t('c1')]
    })
    expect(layout.edges).toHaveLength(3)
  })

  it('bounds enclose all nodes', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      parents: [t('p')],
      children: [t('c')],
      jumps: [t('j')],
      siblings: [t('s')]
    })
    for (const n of layout.nodes) {
      expect(layout.bounds.minX).toBeLessThanOrEqual(n.x - n.w / 2)
      expect(layout.bounds.maxX).toBeGreaterThanOrEqual(n.x + n.w / 2)
      expect(layout.bounds.minY).toBeLessThanOrEqual(n.y - n.h / 2)
      expect(layout.bounds.maxY).toBeGreaterThanOrEqual(n.y + n.h / 2)
    }
  })

  it('splits many children into left/right wing stacks below the focus', () => {
    const children = Array.from({ length: 9 }, (_, i) => t(`c${i + 1}`))
    const layout = layoutViewport({ focus: t('f'), ...empty, parents: [t('p')], children })

    const kids = layout.nodes.filter((n) => n.role === 'child')
    expect(kids.every((k) => k.y > 0)).toBe(true)

    // two wings: one entirely left of the focus center, one entirely right
    const left = kids.filter((k) => k.x < 0)
    const right = kids.filter((k) => k.x >= 0)
    expect(left.length).toBeGreaterThan(0)
    expect(right.length).toBeGreaterThan(0)

    // each wing is a vertical stack: rows increase monotonically within it
    const stackY = (wing: typeof kids) => wing.map((k) => k.y).sort((a, b) => a - b)
    expect(new Set(stackY(left)).size).toBe(left.length)
    expect(new Set(stackY(right)).size).toBe(right.length)

    // all child edges converge on the focus bottom anchor
    const childEdges = layout.edges.filter((e) => e.kind === 'child')
    expect(childEdges).toHaveLength(9)
    const focus = layout.byId['f']
    const anchor = sideAnchor(focus, 'bottom')
    for (const e of childEdges) {
      expect(e.from).toEqual(anchor)
      expect(e.fromSide).toBe('bottom')
      expect(e.toSide).toBe('top')
    }
  })

  it('splits even two children across left and right wings', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      children: [t('c1'), t('c2')]
    })
    expect(layout.byId['c1'].x).toBeLessThan(0) // left wing
    expect(layout.byId['c2'].x).toBeGreaterThan(0) // right wing
    expect(layout.byId['c1'].y).toBe(layout.byId['c2'].y) // same top row
  })

  it('never stacks more than half the children in one wing (left-biased)', () => {
    const children = Array.from({ length: 5 }, (_, i) => t(`c${i + 1}`))
    const layout = layoutViewport({ focus: t('f'), ...empty, children })
    const kids = layout.nodes.filter((n) => n.role === 'child')
    const left = kids.filter((k) => k.x < 0)
    const right = kids.filter((k) => k.x >= 0)
    expect(left).toHaveLength(3) // odd node goes to the left wing (Jerry: 7/6)
    expect(right).toHaveLength(2)
    // wings are mirror-placed around the spine under the focus
    expect(Math.min(...left.map((k) => k.x))).toBeLessThan(0)
    expect(Math.max(...right.map((k) => k.x))).toBeGreaterThan(0)
  })

  it('copies intimacy scores onto the edges toward each target', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      intimacy: { c1: 3 },
      children: [t('c1'), t('c2')]
    })
    const e1 = layout.edges.find((e) => e.targetId === 'c1')
    const e2 = layout.edges.find((e) => e.targetId === 'c2')
    expect(e1?.intimacy).toBe(3)
    expect(e2?.intimacy).toBe(1) // default for a plain direct link
  })

  it('stacks jumps in a vertical column centered on the focus', () => {
    const jumps = Array.from({ length: 6 }, (_, i) => t(`j${i + 1}`))
    const layout = layoutViewport({ focus: t('f'), ...empty, jumps })
    const js = layout.nodes.filter((n) => n.role === 'jump')
    // single column: all share (nearly) the same x
    expect(new Set(js.map((k) => Math.round(k.x))).size).toBe(1)
    // centered vertically on the focus
    const ys = js.map((k) => k.y)
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(0)
  })
})

describe('boxAnchor', () => {
  const node = { ...t('f'), role: 'focus' as const, x: 0, y: 0, w: 100, h: 40 }

  it('exits through the right edge when heading right', () => {
    const p = boxAnchor(node, { x: 500, y: 0 })
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeCloseTo(0)
  })

  it('exits through the top edge when heading straight up', () => {
    const p = boxAnchor(node, { x: 0, y: -500 })
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(-20)
  })
})

describe('More-gate counts', () => {
  it('attaches hidden-neighbor counts to positioned nodes', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      children: [t('c')],
      hidden: { c: { parents: [], children: ['grandchild', 'sib'], jumps: [] } }
    })
    expect(layout.byId['f'].hidden).toBeUndefined()
    expect(layout.byId['c'].hidden).toEqual({ parents: 0, children: 2, jumps: 0 })
  })

  it('omits hidden when every direction is empty', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      children: [t('c')],
      hidden: { c: { parents: [], children: [], jumps: [] } }
    })
    expect(layout.byId['c'].hidden).toBeUndefined()
  })

  it('attaches attachment badge counts, omitting zero totals', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      children: [t('c'), t('d')],
      attachCounts: { c: { total: 3, urls: 1 }, d: { total: 0, urls: 0 } }
    })
    expect(layout.byId['c'].attach).toEqual({ total: 3, urls: 1 })
    expect(layout.byId['d'].attach).toBeUndefined()
  })

  it('draws relationship labels on the matching edge only', () => {
    const layout = layoutViewport({
      focus: t('f'),
      ...empty,
      children: [t('c'), t('d')],
      linkLabels: { 'child:c': { id: 'l1', label: 'causes', notes: 'why' } }
    })
    const labeled = layout.edges.find((e) => e.id === 'child:c')
    expect(labeled?.label).toBe('causes')
    expect(layout.edges.find((e) => e.id === 'child:d')?.label).toBeUndefined()
  })
})

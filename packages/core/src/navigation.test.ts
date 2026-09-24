import { describe, it, expect } from 'vitest'
import type { Neighborhood, Thought, Link } from '@the-brain/shared'
import { computeViewport, computeIntimacy } from './navigation.js'

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

function child(from: string, to: string): Link {
  return { id: `${from}->${to}`, fromId: from, toId: to, type: 'child', createdAt: 0 }
}
function jump(a: string, b: string): Link {
  return { id: `${a}<->${b}`, fromId: a, toId: b, type: 'jump', createdAt: 0 }
}

function nb(focusId: string, thoughts: Thought[], links: Link[]): Neighborhood {
  const focus = thoughts.find((x) => x.id === focusId)!
  return { focus, thoughts, links }
}

describe('computeViewport', () => {
  it('classifies parents, children and jumps', () => {
    const thoughts = [t('root'), t('focus'), t('kid'), t('assoc')]
    const links = [child('root', 'focus'), child('focus', 'kid'), jump('focus', 'assoc')]
    const vp = computeViewport(nb('focus', thoughts, links))
    expect(vp.parents.map((x) => x.id)).toEqual(['root'])
    expect(vp.children.map((x) => x.id)).toEqual(['kid'])
    expect(vp.jumps.map((x) => x.id)).toEqual(['assoc'])
  })

  it('supports multiple parents', () => {
    const thoughts = [t('p1'), t('p2'), t('focus')]
    const links = [child('p1', 'focus'), child('p2', 'focus')]
    const vp = computeViewport(nb('focus', thoughts, links))
    expect(vp.parents.map((x) => x.id).sort()).toEqual(['p1', 'p2'])
  })

  it('derives siblings and excludes focus and already-shown nodes', () => {
    // root -> focus, root -> sibA, root -> sibB ; focus -> kid
    const thoughts = [t('root'), t('focus'), t('sibA'), t('sibB'), t('kid')]
    const links = [
      child('root', 'focus'),
      child('root', 'sibA'),
      child('root', 'sibB'),
      child('focus', 'kid')
    ]
    const vp = computeViewport(nb('focus', thoughts, links))
    expect(vp.siblings.map((x) => x.id).sort()).toEqual(['sibA', 'sibB'])
    // focus's own child is NOT a sibling
    expect(vp.siblings.map((x) => x.id)).not.toContain('kid')
  })

  it('a node that is both a jump and a sibling appears only as a jump', () => {
    // root -> focus, root -> other ; focus <-> other (jump)
    const thoughts = [t('root'), t('focus'), t('other')]
    const links = [child('root', 'focus'), child('root', 'other'), jump('focus', 'other')]
    const vp = computeViewport(nb('focus', thoughts, links))
    expect(vp.jumps.map((x) => x.id)).toEqual(['other'])
    expect(vp.siblings).toHaveLength(0)
  })

  it('ignores unknown link endpoints gracefully', () => {
    const thoughts = [t('focus'), t('ghost')]
    const links = [child('missing', 'focus')]
    const vp = computeViewport(nb('focus', thoughts, links))
    expect(vp.parents).toHaveLength(0)
  })
})

describe('computeIntimacy', () => {
  it('scores direct links 1 and shared neighbors add up', () => {
    // root -> focus, root -> sib ; focus -> kid ; kid <-> assoc (jump)
    const thoughts = [t('root'), t('focus'), t('sib'), t('kid'), t('assoc')]
    const links = [
      child('root', 'focus'),
      child('root', 'sib'),
      child('focus', 'kid'),
      jump('kid', 'assoc')
    ]
    const scores = computeIntimacy(nb('focus', thoughts, links))
    expect(scores['root']).toBe(1) // direct parent link
    expect(scores['kid']).toBe(1) // direct child link
    expect(scores['sib']).toBe(1) // no direct link, shares parent 'root'
    expect(scores['assoc']).toBe(1) // 2 hops away, shares neighbor 'kid'
  })

  it('a jump that is also a sibling scores 2', () => {
    // root -> focus, root -> other ; focus <-> other
    const thoughts = [t('root'), t('focus'), t('other')]
    const links = [child('root', 'focus'), child('root', 'other'), jump('focus', 'other')]
    const scores = computeIntimacy(nb('focus', thoughts, links))
    expect(scores['other']).toBe(2) // 1 direct jump + shared parent 'root'
  })

  it('never counts the focus or the node itself as a shared neighbor', () => {
    const thoughts = [t('focus'), t('kid')]
    const links = [child('focus', 'kid')]
    const scores = computeIntimacy(nb('focus', thoughts, links))
    expect(scores['kid']).toBe(1)
    expect(scores['focus']).toBeUndefined()
  })
})

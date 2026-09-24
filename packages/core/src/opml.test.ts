import { describe, it, expect } from 'vitest'
import { buildOpml, parseOpml, type OpmlNode } from './opml.js'

function node(name: string, ...children: OpmlNode[]): OpmlNode {
  return { name, children }
}

describe('buildOpml', () => {
  it('produces a valid OPML 2.0 envelope', () => {
    const xml = buildOpml([node('Root', node('A'), node('B'))], 'My Brain')
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<opml version="2.0">')
    expect(xml).toContain('<title>My Brain</title>')
    expect(xml).toContain('<outline text="Root">')
    expect(xml).toContain('<outline text="A" />')
    expect(xml).toContain('<outline text="B" />')
    expect(xml).toContain('</outline>')
  })

  it('escapes XML entities in names', () => {
    const xml = buildOpml([node('A & B <tag> "q"')])
    expect(xml).toContain('A &amp; B &lt;tag&gt; &quot;q&quot;')
  })

  it('nests children with increasing indent', () => {
    const xml = buildOpml([node('L0', node('L1', node('L2')))])
    const lines = xml.split('\n')
    const idx = (s: string) => lines.findIndex((l) => l.includes(s))
    expect(idx('L0')).toBeLessThan(idx('L1'))
    expect(idx('L1')).toBeLessThan(idx('L2'))
    // L2 is indented deeper than L1.
    const indent = (s: string) => (idx(s) >= 0 ? lines[idx(s)].search(/\S/) : -1)
    expect(indent('L2')).toBeGreaterThan(indent('L1'))
  })
})

describe('parseOpml', () => {
  it('parses nested outlines into depth-tagged entries', () => {
    const xml = buildOpml([node('Root', node('A', node('A1')), node('B'))])
    expect(parseOpml(xml)).toEqual([
      { name: 'Root', depth: 0 },
      { name: 'A', depth: 1 },
      { name: 'A1', depth: 2 },
      { name: 'B', depth: 1 }
    ])
  })

  it('handles self-closing and paired tags in the same document', () => {
    const xml = `<opml version="2.0"><body>
      <outline text="Paired"><outline text="Child" /></outline>
      <outline text="Solo" />
    </body></opml>`
    expect(parseOpml(xml)).toEqual([
      { name: 'Paired', depth: 0 },
      { name: 'Child', depth: 1 },
      { name: 'Solo', depth: 0 }
    ])
  })

  it('accepts single-quoted text attributes', () => {
    expect(parseOpml("<outline text='Hello' />")).toEqual([{ name: 'Hello', depth: 0 }])
  })

  it('unescapes entities', () => {
    expect(parseOpml('<outline text="A &amp; B &lt;p&gt;" />')).toEqual([
      { name: 'A & B <p>', depth: 0 }
    ])
  })

  it('skips outlines with no text and tolerates garbage', () => {
    expect(parseOpml('<outline text="" /><outline />> <not-opml> <outline text="ok" />')).toEqual(
      [{ name: 'ok', depth: 0 }]
    )
  })

  it('clamps depth at zero for unbalanced closing tags', () => {
    expect(parseOpml('</outline></outline><outline text="X" />')).toEqual([
      { name: 'X', depth: 0 }
    ])
  })

  it('round-trips through buildOpml', () => {
    const forest = [node('Root', node('Alpha', node('A1')), node('Beta & Co'))]
    expect(parseOpml(buildOpml(forest))).toEqual([
      { name: 'Root', depth: 0 },
      { name: 'Alpha', depth: 1 },
      { name: 'A1', depth: 2 },
      { name: 'Beta & Co', depth: 1 }
    ])
  })
})

/**
 * OPML 2.0 outline building/parsing for thought-hierarchy exchange
 * (TheBrain's native import/export format). Pure string functions — the
 * repository maps DB rows to/from these shapes.
 */

/** A node of the outline forest used for export. */
export interface OpmlNode {
  name: string
  children: OpmlNode[]
}

/** One parsed outline entry: thought name at nesting depth (0 = top level). */
export interface OpmlEntry {
  name: string
  depth: number
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function unescapeText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Serialize an outline forest to an OPML 2.0 document. */
export function buildOpml(roots: OpmlNode[], title = 'TheBrain outline'): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeAttr(title)}</title>`,
    '  </head>',
    '  <body>'
  ]
  const walk = (nodes: OpmlNode[], indent: string): void => {
    for (const n of nodes) {
      const name = escapeAttr(n.name)
      if (n.children.length === 0) {
        lines.push(`${indent}<outline text="${name}" />`)
      } else {
        lines.push(`${indent}<outline text="${name}">`)
        walk(n.children, `${indent}  `)
        lines.push(`${indent}</outline>`)
      }
    }
  }
  walk(roots, '    ')
  lines.push('  </body>', '</opml>', '')
  return lines.join('\n')
}

/**
 * Parse an OPML document into a flat depth-tagged list (document order).
 * Tolerant by design: only `text` attributes are read, self-closing and
 * paired <outline> tags both work, anything else is ignored. A malformed
 * document yields whatever entries could be recovered (never a throw).
 */
export function parseOpml(xml: string): OpmlEntry[] {
  const entries: OpmlEntry[] = []
  const tag = /<outline\b([^>]*?)(\/?)>|<\/outline>/gi
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tag.exec(xml)) !== null) {
    if (match[0] === '</outline>') {
      depth = Math.max(0, depth - 1)
      continue
    }
    const attrs = match[1] ?? ''
    const selfClosed = match[2] === '/'
    const text = /\btext\s*=\s*"([^"]*)"|\btext\s*=\s*'([^']*)'/i.exec(attrs)
    const name = unescapeText((text?.[1] ?? text?.[2] ?? '').trim())
    if (name) entries.push({ name, depth })
    if (!selfClosed) depth += 1
  }
  return entries
}

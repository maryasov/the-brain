import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

/**
 * Text extraction for the attachment full-text index: read local text-ish
 * files so search can hit their CONTENT, not just the attachment label.
 * Deliberately conservative (TheBrain caps extraction at ~50MB/1M chars;
 * a personal-brain canvas app stays far below that): whitelisted extensions
 * only, small size ceiling, truncated bodies, and any fs error means "no
 * text" — a missing or unreadable file must never break attaching.
 */

/** Extensions treated as readable text (lowercase, with dot). */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh',
  '.zshrc', '.vim', '.el', '.lua', '.pl', '.rb', '.php', '.go', '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.java', '.kt', '.swift',
  '.html', '.css', '.xml', '.sql', '.graphql', '.gitignore'
])

/** Files larger than this are not read at all. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Extracted bodies are indexed only up to this many characters. */
export const MAX_TEXT_CHARS = 200_000

/**
 * Return indexable text for an attachment, or null when it is not a local
 * text file (URLs and images are never fetched or parsed here).
 */
export function extractText(kind: string, uri: string): string | null {
  if (kind !== 'file') return null
  // Only whitelisted extensions are read; anything else (URLs, images,
  // binaries, extension-less paths) is skipped without touching the disk.
  if (!TEXT_EXT.has(extname(basename(uri)).toLowerCase())) return null
  try {
    const st = statSync(uri)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    let text = readFileSync(uri, 'utf8')
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS)
    return text.trim().length > 0 ? text : null
  } catch {
    return null
  }
}

/** Short human label for a search hit's origin: the file's basename. */
export function fileSource(uri: string): string {
  return basename(uri)
}

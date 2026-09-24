/** Emoji badges per thought type (canvas icons + inspector picker). */
export const TYPE_ICONS: Record<string, string> = {
  person: '👤',
  organization: '🏢',
  place: '📍',
  event: '📅',
  book: '📚',
  project: '🛠️',
  task: '✅',
  idea: '💡',
  tool: '🔧',
  source: '📄',
  question: '❓'
}

/** Icon for a type string; unknown types fall back to a letter badge. */
export function typeIcon(type: string | null | undefined): string | null {
  if (!type) return null
  return TYPE_ICONS[type] ?? type.slice(0, 1).toUpperCase()
}

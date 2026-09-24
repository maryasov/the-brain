import type { Repository } from './repository.js'

/**
 * Populate a small demo brain on first launch so the dynamic-grid navigation
 * (parent up, siblings around the parent, children below, jumps right) is
 * immediately explorable — from the app, the MCP server, or the HTTP API.
 */
export function seedIfEmpty(repo: Repository): void {
  if (!repo.isEmpty()) return

  const root = repo.getOrCreateRoot()

  const projects = repo.createThought({ name: 'Projects', parentId: root.id })
  const people = repo.createThought({ name: 'People', parentId: root.id })
  const learning = repo.createThought({ name: 'Learning', parentId: root.id })
  const reference = repo.createThought({ name: 'Reference', parentId: root.id })

  const brainClone = repo.createThought({ name: 'Brain Clone', parentId: projects.id })
  repo.createThought({ name: 'Research Log', parentId: projects.id })
  repo.createThought({ name: 'Roadmap', parentId: brainClone.id })
  repo.createThought({ name: 'Architecture', parentId: brainClone.id })

  repo.createThought({ name: 'Ada Lovelace', parentId: people.id })
  repo.createThought({ name: 'Grace Hopper', parentId: people.id })

  repo.createThought({ name: 'Graph Theory', parentId: learning.id })
  repo.createThought({ name: 'Human Memory', parentId: learning.id })

  repo.createThought({ name: 'TheBrain Help', parentId: reference.id })

  // A couple of associative (jump) links to show non-hierarchical navigation.
  repo.link({ fromId: brainClone.id, toId: learning.id, type: 'jump' })
  repo.link({ fromId: people.id, toId: learning.id, type: 'jump' })
}

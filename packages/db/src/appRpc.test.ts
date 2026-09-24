import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './migrations.js'
import { Repository } from './repository.js'
import { callAppRpc, APP_RPC_REQ_KEY, APP_RPC_RES_KEY, type AppRpcRequest } from './appRpc.js'

function freshRepo(): Repository {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return new Repository(db)
}

describe('callAppRpc', () => {
  it('round-trips a request/response through app_state', async () => {
    const repo = freshRepo()
    // Fake the desktop side: poll for a request and answer with its method.
    const serve = setInterval(() => {
      const raw = repo.getAppState(APP_RPC_REQ_KEY)
      if (!raw) return
      const req = JSON.parse(raw) as AppRpcRequest
      repo.setAppState(APP_RPC_RES_KEY, JSON.stringify({ id: req.id, ok: true, result: req.method }))
    }, 5)
    try {
      const result = await callAppRpc(repo, 'ping', undefined, 2000)
      expect(result).toBe('ping')
    } finally {
      clearInterval(serve)
    }
  })

  it('surfaces an error response from the app', async () => {
    const repo = freshRepo()
    const serve = setInterval(() => {
      const raw = repo.getAppState(APP_RPC_REQ_KEY)
      if (!raw) return
      const req = JSON.parse(raw) as AppRpcRequest
      repo.setAppState(APP_RPC_RES_KEY, JSON.stringify({ id: req.id, ok: false, error: 'boom' }))
    }, 5)
    try {
      await expect(callAppRpc(repo, 'nope', undefined, 2000)).rejects.toThrow('boom')
    } finally {
      clearInterval(serve)
    }
  })

  it('times out when nothing answers', async () => {
    const repo = freshRepo()
    await expect(callAppRpc(repo, 'ping', undefined, 60)).rejects.toThrow(/did not respond/)
  })
})

import { randomUUID } from 'node:crypto'
import type { Repository } from './repository.js'

/**
 * A tiny request/response bus over the shared `app_state` table, so the HTTP
 * API and MCP server can invoke actions inside the RUNNING desktop process
 * (screenshots, view introspection) without touching the user's mouse or
 * keyboard. The desktop main process polls `APP_RPC_REQ_KEY`, executes, and
 * answers on `APP_RPC_RES_KEY`; responses carry the request id so callers
 * ignore unrelated traffic.
 */
export const APP_RPC_REQ_KEY = 'rpc:req'
export const APP_RPC_RES_KEY = 'rpc:res'

export interface AppRpcRequest {
  id: string
  method: string
  params?: unknown
  ts: number
}

export interface AppRpcResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/** Publish a request and wait for the desktop app's matching reply. */
export async function callAppRpc(
  repo: Repository,
  method: string,
  params?: unknown,
  timeoutMs = 8000
): Promise<unknown> {
  const req: AppRpcRequest = { id: randomUUID(), method, params, ts: Date.now() }
  repo.setAppState(APP_RPC_REQ_KEY, JSON.stringify(req))

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const raw = repo.getAppState(APP_RPC_RES_KEY)
    if (raw) {
      try {
        const res = JSON.parse(raw) as AppRpcResponse
        if (res.id === req.id) {
          if (!res.ok) throw new Error(res.error ?? 'app rpc failed')
          return res.result
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue // partial write, retry
        throw err
      }
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('desktop app did not respond (is `pnpm dev` running?)')
}

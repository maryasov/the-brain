import { ipcMain, shell, type BrowserWindow } from 'electron'
import {
  IPC,
  type AddAttachmentInput,
  type Attachment,
  type CreateSetInput,
  type CreateThoughtInput,
  type DeleteOptions,
  type LinkInput,
  type LinkType,
  type UpdateThoughtInput
} from '@the-brain/shared'
import {
  APP_RPC_REQ_KEY,
  APP_RPC_RES_KEY,
  type AppRpcRequest,
  type AppRpcResponse
} from '@the-brain/db'
import { getRepository } from './db.js'

/** Last focus id we pushed/pulled; suppresses echo when the app writes its own. */
let lastFocus: string | null = null

/** Wire every BrainApi method to an ipcMain.handle channel. */
export function registerIpc(): void {
  const r = () => getRepository()

  ipcMain.handle(IPC.getThought, (_e, id: string) => r().getThought(id))
  ipcMain.handle(IPC.getNeighborhood, (_e, focusId: string) => r().getNeighborhood(focusId))
  ipcMain.handle(IPC.createThought, (_e, input: CreateThoughtInput) => r().createThought(input))
  ipcMain.handle(IPC.updateThought, (_e, input: UpdateThoughtInput) => r().updateThought(input))
  ipcMain.handle(IPC.deleteThought, (_e, id: string, options: DeleteOptions) =>
    r().deleteThought(id, options)
  )
  ipcMain.handle(IPC.link, (_e, input: LinkInput) => r().link(input))
  ipcMain.handle(IPC.unlink, (_e, fromId: string, toId: string, type: LinkType) =>
    r().unlink(fromId, toId, type)
  )
  ipcMain.handle(IPC.search, (_e, query: string) => r().search(query))
  ipcMain.handle(IPC.getOrCreateRoot, () => r().getOrCreateRoot())
  ipcMain.handle(IPC.listRecent, (_e, limit?: number) => r().listRecent(limit))
  ipcMain.handle(IPC.getSubgraph, (_e, centerId: string, depth: number) =>
    r().getSubgraph(centerId, depth)
  )
  ipcMain.handle(IPC.listSets, () => r().listSets())
  ipcMain.handle(IPC.runSet, (_e, id: string) => r().runSet(id))
  ipcMain.handle(IPC.createSet, (_e, input: CreateSetInput) => r().createSet(input))
  ipcMain.handle(IPC.deleteSet, (_e, id: string) => r().deleteSet(id))
  ipcMain.handle(IPC.setPinned, (_e, id: string, pinned: boolean) => r().setPinned(id, pinned))
  ipcMain.handle(IPC.listPinned, () => r().listPinned())
  ipcMain.handle(IPC.listTags, (_e, thoughtId: string) => r().listTags(thoughtId))
  ipcMain.handle(IPC.addTag, (_e, thoughtId: string, name: string) => r().addTag(thoughtId, name))
  ipcMain.handle(IPC.removeTag, (_e, thoughtId: string, tagId: string) =>
    r().removeTag(thoughtId, tagId)
  )

  // Attachments. Anchor thoughts ('thought' kind) are opened by the renderer
  // (it focuses the target); everything else goes to the system handler.
  ipcMain.handle(IPC.listAttachments, (_e, thoughtId: string) => r().listAttachments(thoughtId))
  ipcMain.handle(IPC.addAttachment, (_e, input: AddAttachmentInput) => r().addAttachment(input))
  ipcMain.handle(IPC.removeAttachment, (_e, thoughtId: string, id: string) =>
    r().removeAttachment(thoughtId, id)
  )
  ipcMain.handle(IPC.openAttachment, async (_e, att: Attachment) => {
    if (att.kind === 'thought') return
    if (att.kind === 'file') {
      const err = await shell.openPath(att.uri)
      if (err) shell.showItemInFolder(att.uri) // e.g. no default app: reveal it
    } else {
      await shell.openExternal(att.uri)
    }
  })

  // App-view state. Writes to 'focus' from the renderer are the app's own
  // navigation: record them so the watcher below does not echo them back.
  ipcMain.handle(IPC.setAppState, (_e, key: string, value: string) => {
    r().setAppState(key, value)
    if (key === 'focus') lastFocus = value
  })
  ipcMain.handle(IPC.getAppState, (_e, key: string) => r().getAppState(key))
}

/**
 * Poll the shared app_state table so an external agent (HTTP API / MCP) can
 * drive the window: when 'focus' changes outside this process, push it to the
 * renderer; when an rpc request appears, execute it and answer. Cheap
 * single-row reads; WAL keeps the UI and writers unblocked.
 */
export function watchAppFocus(win: BrowserWindow, intervalMs = 250): void {
  let lastRpc: string | null = null
  const timer = setInterval(async () => {
    if (win.isDestroyed()) return clearInterval(timer)
    const repo = getRepository()

    // Remote focus changes (API/MCP driving navigation).
    let focus: string | null
    try {
      focus = repo.getAppState('focus')
    } catch {
      return // db not open yet
    }
    if (focus !== lastFocus) {
      lastFocus = focus
      if (focus) win.webContents.send(IPC.appFocusPush, focus)
    }

    // App RPC: screenshots / view state for agent-side debugging.
    const raw = repo.getAppState(APP_RPC_REQ_KEY)
    if (!raw || raw === lastRpc) return
    lastRpc = raw
    let res: AppRpcResponse
    try {
      const req = JSON.parse(raw) as AppRpcRequest
      res = { id: req.id, ok: true, result: await serveRpc(win, req) }
    } catch (err) {
      res = { id: 'unparsed', ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    repo.setAppState(APP_RPC_RES_KEY, JSON.stringify(res))
  }, intervalMs)
  timer.unref?.()
}

/** Execute one app-RPC request in the main process. */
async function serveRpc(win: BrowserWindow, req: AppRpcRequest): Promise<unknown> {
  const repo = getRepository()
  switch (req.method) {
    case 'ping':
      return { ok: true, title: 'the-brain', focus: repo.getAppState('focus') }
    case 'screenshot': {
      // capturePage renders the window content without raising or focusing it,
      // so agents can visually verify on a shared machine.
      const image = await win.webContents.capturePage()
      const size = win.getContentBounds()
      return {
        pngBase64: image.toPNG().toString('base64'),
        width: size.width,
        height: size.height
      }
    }
    case 'get_view': {
      // Ask the renderer for its live view state (read-only introspection).
      const view = await win.webContents.executeJavaScript(`
        (() => {
          const s = window.__brainDebug?.() ?? null
          return s
        })()
      `)
      return { appStateFocus: repo.getAppState('focus'), renderer: view }
    }
    case 'ui': {
      // Run a renderer UI action (navigate / reload / back / select / add_child…)
      // through window.__brainRpc — the same store actions the mouse drives.
      const params = (req.params ?? {}) as { action?: string; args?: Record<string, unknown> }
      if (!params.action) throw new Error('ui rpc requires params.action')
      return win.webContents.executeJavaScript(
        `window.__brainRpc ? window.__brainRpc(${JSON.stringify(params.action)}, ${JSON.stringify(params.args ?? {})}) : Promise.reject(new Error('renderer not ready'))`
      )
    }
    default:
      throw new Error(`unknown rpc method: ${req.method}`)
  }
}

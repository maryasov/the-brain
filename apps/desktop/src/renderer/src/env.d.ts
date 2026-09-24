/// <reference types="vite/client" />
import type { BrainApi } from '@the-brain/shared'

declare global {
  interface Window {
    /** Exposed by the preload script via contextBridge. */
    brain: BrainApi
    /** Live renderer snapshot for app-RPC debugging (see main/ipc.ts get_view). */
    __brainDebug?: () => unknown
    /** Run a renderer UI action via app-RPC (see main/ipc.ts ui). */
    __brainRpc?: (method: string, args?: Record<string, unknown>) => Promise<unknown>
  }
}

export {}

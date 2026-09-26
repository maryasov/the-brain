import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC,
  type AddAttachmentInput,
  type Attachment,
  type BrainApi,
  type CreateSetInput,
  type CreateThoughtInput,
  type DeleteOptions,
  type LinkInput,
  type LinkInfoInput,
  type LinkType,
  type UpdateThoughtInput
} from '@the-brain/shared'

const api: BrainApi = {
  getThought: (id: string) => ipcRenderer.invoke(IPC.getThought, id),
  getThoughtCard: (id: string) => ipcRenderer.invoke(IPC.getThoughtCard, id),
  getNeighborhood: (focusId: string) => ipcRenderer.invoke(IPC.getNeighborhood, focusId),
  getNeighborhoodAsOf: (focusId: string, at: number) =>
    ipcRenderer.invoke(IPC.getNeighborhoodAsOf, focusId, at),
  listHistory: (thoughtId: string, limit?: number) =>
    ipcRenderer.invoke(IPC.listHistory, thoughtId, limit),
  getEarliestActivity: () => ipcRenderer.invoke(IPC.getEarliestActivity),
  createThought: (input: CreateThoughtInput) => ipcRenderer.invoke(IPC.createThought, input),
  updateThought: (input: UpdateThoughtInput) => ipcRenderer.invoke(IPC.updateThought, input),
  deleteThought: (id: string, options: DeleteOptions) =>
    ipcRenderer.invoke(IPC.deleteThought, id, options),
  link: (input: LinkInput) => ipcRenderer.invoke(IPC.link, input),
  unlink: (fromId: string, toId: string, type: LinkType) =>
    ipcRenderer.invoke(IPC.unlink, fromId, toId, type),
  setLinkInfo: (input: LinkInfoInput) => ipcRenderer.invoke(IPC.setLinkInfo, input),
  search: (query: string) => ipcRenderer.invoke(IPC.search, query),
  getOrCreateRoot: () => ipcRenderer.invoke(IPC.getOrCreateRoot),
  listRecent: (limit?: number) => ipcRenderer.invoke(IPC.listRecent, limit),
  getSubgraph: (centerId: string, depth: number) =>
    ipcRenderer.invoke(IPC.getSubgraph, centerId, depth),
  listSets: () => ipcRenderer.invoke(IPC.listSets),
  runSet: (id: string) => ipcRenderer.invoke(IPC.runSet, id),
  createSet: (input: CreateSetInput) => ipcRenderer.invoke(IPC.createSet, input),
  deleteSet: (id: string) => ipcRenderer.invoke(IPC.deleteSet, id),
  exportBrainFile: () => ipcRenderer.invoke(IPC.exportBrainFile),
  importBrainFile: () => ipcRenderer.invoke(IPC.importBrainFile),
  setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke(IPC.setPinned, id, pinned),
  listPinned: () => ipcRenderer.invoke(IPC.listPinned),
  listTags: (thoughtId: string) => ipcRenderer.invoke(IPC.listTags, thoughtId),
  addTag: (thoughtId: string, name: string) => ipcRenderer.invoke(IPC.addTag, thoughtId, name),
  removeTag: (thoughtId: string, tagId: string) =>
    ipcRenderer.invoke(IPC.removeTag, thoughtId, tagId),
  listAttachments: (thoughtId: string) => ipcRenderer.invoke(IPC.listAttachments, thoughtId),
  addAttachment: (input: AddAttachmentInput) => ipcRenderer.invoke(IPC.addAttachment, input),
  removeAttachment: (thoughtId: string, id: string) =>
    ipcRenderer.invoke(IPC.removeAttachment, thoughtId, id),
  openAttachment: (attachment: Attachment) => ipcRenderer.invoke(IPC.openAttachment, attachment),
  getPathForFile: (file: unknown) => webUtils.getPathForFile(file as File),
  setAppState: (key: string, value: string) => ipcRenderer.invoke(IPC.setAppState, key, value),
  getAppState: (key: string) => ipcRenderer.invoke(IPC.getAppState, key),
  onAppFocus: (cb: (focusId: string | null) => void) => {
    ipcRenderer.on(IPC.appFocusPush, (_e, focusId: string | null) => cb(focusId))
  }
}

contextBridge.exposeInMainWorld('brain', api)

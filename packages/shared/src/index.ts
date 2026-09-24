/**
 * @the-brain/shared
 * Domain types + IPC contract shared between the Electron main process,
 * the preload bridge, and the renderer. No runtime dependencies.
 */

/** A single node in the brain. */
export interface Thought {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  /** Free-form thought type (one of THOUGHT_TYPES or anything custom). */
  type: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Suggested thought types (TheBrain ships a similar preset list). Stored as
 * plain text, so any other string is equally valid — the list only drives the
 * picker UI and the icon map in the renderer.
 */
export const THOUGHT_TYPES = [
  'person',
  'organization',
  'place',
  'event',
  'book',
  'project',
  'task',
  'idea',
  'tool',
  'source',
  'question'
] as const;

/** Row shape as stored in SQLite (booleans are 0/1 integers). */
export interface ThoughtRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  type: string | null;
  pinned: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

/**
 * Link types.
 * - 'child': directed edge parent(from_id) -> child(to_id). A thought may have
 *   multiple parents (multiple incoming child links).
 * - 'jump': undirected association; stored as one row, queried in both directions.
 * Siblings are derived (thoughts sharing a parent), never stored.
 */
export type LinkType = 'child' | 'jump';

export interface Link {
  id: string;
  fromId: string;
  toId: string;
  type: LinkType;
  createdAt: number;
}

export interface LinkRow {
  id: string;
  from_id: string;
  to_id: string;
  type: LinkType;
  created_at: number;
}

/** A search hit from the FTS index. */
export interface SearchHit {
  id: string;
  name: string;
  snippet: string | null;
}

/** A user-defined label that can be attached to many thoughts. */
export interface Tag {
  id: string;
  name: string;
}

export interface TagRow {
  id: string;
  name: string;
}

/**
 * The neighborhood of a focus thought (1-hop, or depth-hop via getSubgraph),
 * as produced by the repository and consumed by the (pure) navigation engine
 * in @the-brain/core.
 */
export interface Neighborhood {
  focus: Thought;
  /** All thought records referenced below (including focus), keyed for lookup. */
  thoughts: Thought[];
  /** Links touching any node in this neighborhood. */
  links: Link[];
}

/**
 * Filtered sets (TheBrain "filtered sets"): a saved search over the whole
 * brain. The definition is stored as JSON; every field is optional and the
 * present ones are AND-ed. `text` runs through the same FTS prefix matcher as
 * the search palette, so partial words work.
 */
export interface SetDef {
  text?: string;
  type?: string;
  tag?: string;
}

export interface ThoughtSet {
  id: string;
  name: string;
  description: string | null;
  def: SetDef;
  createdAt: number;
  updatedAt: number;
}

export interface ThoughtSetRow {
  id: string;
  name: string;
  description: string | null;
  def_json: string;
  created_at: number;
  updated_at: number;
}

export interface CreateSetInput {
  name: string;
  description?: string | null;
  def: SetDef;
}

/** Create-request payloads crossing the IPC boundary. */
export interface CreateThoughtInput {
  name: string;
  description?: string | null;
  color?: string | null;
  type?: string | null;
  parentId?: string | null;
  linkType?: LinkType;
}

export interface RenameThoughtInput {
  id: string;
  name: string;
}

export interface UpdateThoughtInput {
  id: string;
  name?: string;
  description?: string | null;
  color?: string | null;
  type?: string | null;
  pinned?: boolean;
}

export interface DeleteOptions {
  /**
   * 'detach' removes only the links to this thought (keeps it as orphan or root).
   * 'cascade' deletes the thought and recursively its exclusive descendants.
   */
  mode: 'detach' | 'cascade';
}

export interface LinkInput {
  fromId: string;
  toId: string;
  type: LinkType;
}

/**
 * Attachments (TheBrain "thought attachments"): a file on disk, a URL, an
 * image, or an anchor thought (uri = another thought's id, shown as a
 * reference rather than a graph link).
 */
export type AttachmentKind = 'file' | 'url' | 'image' | 'thought';

export interface Attachment {
  id: string;
  thoughtId: string;
  kind: AttachmentKind;
  uri: string;
  label: string | null;
  mime: string | null;
  createdAt: number;
}

export interface AttachmentRow {
  id: string;
  thought_id: string;
  kind: AttachmentKind;
  uri: string;
  label: string | null;
  mime: string | null;
  created_at: number;
}

export interface AddAttachmentInput {
  thoughtId: string;
  kind: AttachmentKind;
  uri: string;
  label?: string | null;
  mime?: string | null;
}

/** The API surface exposed on `window.brain` by the preload script. */
export interface BrainApi {
  getThought(id: string): Promise<Thought | null>;
  getNeighborhood(focusId: string): Promise<Neighborhood | null>;
  createThought(input: CreateThoughtInput): Promise<Thought>;
  updateThought(input: UpdateThoughtInput): Promise<Thought>;
  deleteThought(id: string, options: DeleteOptions): Promise<void>;
  link(input: LinkInput): Promise<Link>;
  unlink(fromId: string, toId: string, type: LinkType): Promise<void>;
  search(query: string): Promise<SearchHit[]>;
  getOrCreateRoot(): Promise<Thought>;
  /** Most recently touched thoughts (TheBrain "Quiet Eye" timeline). */
  listRecent(limit?: number): Promise<Thought[]>;
  /** Depth-hop subgraph around a thought, for the minimap overview. */
  getSubgraph(centerId: string, depth: number): Promise<Neighborhood | null>;
  /** Saved filtered sets: list, run (returns matching thoughts), create, delete. */
  listSets(): Promise<ThoughtSet[]>;
  runSet(id: string): Promise<Thought[]>;
  createSet(input: CreateSetInput): Promise<ThoughtSet>;
  deleteSet(id: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<Thought>;
  listPinned(): Promise<Thought[]>;
  listTags(thoughtId: string): Promise<Tag[]>;
  addTag(thoughtId: string, name: string): Promise<Tag[]>;
  removeTag(thoughtId: string, tagId: string): Promise<Tag[]>;
  /** Files / URLs / images / anchor thoughts attached to a thought. */
  listAttachments(thoughtId: string): Promise<Attachment[]>;
  addAttachment(input: AddAttachmentInput): Promise<Attachment>;
  removeAttachment(thoughtId: string, id: string): Promise<Attachment[]>;
  /** Open a file/URL attachment with the system default app. */
  openAttachment(attachment: Attachment): Promise<void>;
  /** Resolve an Electron File object to its absolute path (drag & drop). */
  getPathForFile(file: unknown): string;
  /** Persist app-view state (e.g. key 'focus') so API/MCP agents can drive the window. */
  setAppState(key: string, value: string): Promise<void>;
  getAppState(key: string): Promise<string | null>;
  /** Subscribe to focus changes requested by an external agent (API/MCP). */
  onAppFocus(cb: (focusId: string | null) => void): void;
}

/** IPC channel names. Kept in one place to avoid string drift. */
export const IPC = {
  getThought: 'brain:getThought',
  getNeighborhood: 'brain:getNeighborhood',
  createThought: 'brain:createThought',
  updateThought: 'brain:updateThought',
  deleteThought: 'brain:deleteThought',
  link: 'brain:link',
  unlink: 'brain:unlink',
  search: 'brain:search',
  getOrCreateRoot: 'brain:getOrCreateRoot',
  listRecent: 'brain:listRecent',
  getSubgraph: 'brain:getSubgraph',
  listSets: 'brain:listSets',
  runSet: 'brain:runSet',
  createSet: 'brain:createSet',
  deleteSet: 'brain:deleteSet',
  setPinned: 'brain:setPinned',
  listPinned: 'brain:listPinned',
  listTags: 'brain:listTags',
  addTag: 'brain:addTag',
  removeTag: 'brain:removeTag',
  listAttachments: 'brain:listAttachments',
  addAttachment: 'brain:addAttachment',
  removeAttachment: 'brain:removeAttachment',
  openAttachment: 'brain:openAttachment',
  setAppState: 'brain:setAppState',
  getAppState: 'brain:getAppState',
  appFocusPush: 'brain:appFocusPush'
} as const;

/** Helper to map a raw DB row to a domain Thought. */
export function rowToThought(row: ThoughtRow): Thought {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    type: row.type,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Helper to map a raw DB link row to a domain Link. */
export function rowToLink(row: LinkRow): Link {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type,
    createdAt: row.created_at
  };
}

/** Helper to map a raw DB filtered-set row to a domain ThoughtSet. */
export function rowToSet(row: ThoughtSetRow): ThoughtSet {
  let def: SetDef = {}
  try {
    def = JSON.parse(row.def_json) as SetDef
  } catch {
    /* a corrupt definition degrades to an empty filter, never a crash */
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    def,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** Helper to map a raw DB attachment row to a domain Attachment. */
export function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    thoughtId: row.thought_id,
    kind: row.kind,
    uri: row.uri,
    label: row.label,
    mime: row.mime,
    createdAt: row.created_at
  };
}

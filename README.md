# TheBrain Open

A **free, open-source, local-first** desktop alternative to [TheBrain](https://thebrain.com/).

The signature feature this project reproduces is **focus-driven navigation**: every
idea is a _Thought_; you center the view on one thought and its neighbors are laid
out around it in TheBrain's zone layout (per the official User Guide): **parents**
in a row above the focus, **children** cascading below in vertical wing stacks,
**jumps** (associations) stacking in the zone to the left, and **siblings**
(the parent's other children) stacking in the zone to the right — all joined by
thin curves that fan out from single gate anchors on the focus box. Moving focus
animates the whole map, so you think in relationships instead of folders.

> Research note: existing open-source knowledge tools (Trilium, Logseq, org-roam,
> Obsidian Canvas) are backlink graphs or static canvases. None implement the
> focus-centric, deterministically-banded dynamic grid — that gap is the point of
> this project.

## Features

- Four-zone focus layout (per TheBrain 13): parents above, children below in
  twin wings, jumps left, siblings right — on Canvas 2D with animated recentring,
  gate dots on the focus, converging fan curves and intimacy numbers on links.
- Typed relationships: **Parent / Child / Jump**, with **Siblings** derived.
- **Thought types**: tag a thought as person, project, book, place… (or any
  custom label) — the node shows a matching icon, set it from the inspector.
- Multi-parent thoughts (one idea living under several contexts).
- Full CRUD on thoughts and links, persisted locally.
- **Thought inspector** (`I`): edit name, description and color of the focused
  thought, and jump across all its relationships from one panel.
- **Attachments**: files, URLs, images, and anchor thoughts per thought —
  added from the inspector, by dropping files onto the graph, or via API/MCP;
  opened with the system default app.
- Keyboard navigation (arrows + Enter) and click-to-jump.
- **Minimap**: a 2-hop overview of the graph around the focus, bottom-right —
  click any dot to navigate there.
- **Timeline** (“Quiet Eye”): the recently touched thoughts in a left dock,
  newest first, with relative ages.
- **Filtered sets**: save a search (text / type / tag, AND-ed) as a named set —
  run it in the Sets panel and click any hit to focus it.
- **Create from zones**: click a gate on the focus box — or any empty spot in
  the parent/child/jump/sibling zone — and the new thought is born already
  linked in that direction.
- **Drag-to-link**: drag one thought onto another to associate them (plain =
  jump, Shift = parent → child); a dashed rubber band previews the drop.
- Full-text search palette (SQLite FTS5) to find and focus any thought.
- Pinboard for quick jumps, plus per-thought tags.
- Agent access: MCP server + HTTP API over the same database, including full
  remote control of the running window (navigate, UI actions, screenshots)
  — no mouse or keyboard required.
- Strictly local-first: a single SQLite file, works fully offline.

## Tech stack

- **Electron + electron-vite + TypeScript** (main / preload / renderer).
- **React 18** + **Zustand** for UI state.
- **Custom Canvas 2D renderer** (no graph library needed for the banded layout).
- **better-sqlite3** for persistence, **FTS5** for search (v12 for Node-side
  packages, v11 rebuilt for Electron in the desktop app — see Notes).
- **electron-builder** for packaging, **Vitest** for tests.

## Repository layout

```
the-brain/
  packages/
    shared/     # Domain types + the IPC contract (BrowserApi). No runtime deps.
    core/       # Pure, UI-free engines: navigation (role grouping) + layout. Unit-tested.
    db/         # Electron-free data layer: Repository, migrations, seed, openRepository().
    mcp/        # MCP stdio server: exposes the graph to AI agents as tools.
    api/        # Dependency-free HTTP JSON API over the same graph.
  apps/
    desktop/    # Electron shell: main (SQLite + IPC), preload (bridge), renderer (React).
```

Keeping `core` free of Electron and DOM means the interesting logic (how a
neighborhood is grouped into parents/children/jumps/siblings and positioned into
bands) is fully unit-testable in plain Node — see `packages/core/src/*.test.ts`.

## Getting started

Requirements: Node >= 20, pnpm >= 10, and a C/C++ toolchain (Python, make, g++)
for the native `better-sqlite3` module.

```bash
# 1. install workspace dependencies
pnpm install

# 2. compile better-sqlite3 against Electron's ABI (required before dev/run).
#    pnpm blocks build scripts by default, so we do this explicitly once.
pnpm --filter @the-brain/desktop run rebuild

# 3. launch the app in dev mode (hot reload)
pnpm dev
```

A first run seeds a small demo brain ("My Brain" with Projects / People /
Learning / Reference) so the navigation is immediately explorable.

### Other commands

```bash
pnpm test          # run core + repository unit/integration tests
pnpm typecheck     # typecheck every package
pnpm build         # bundle main/preload/renderer with electron-vite
pnpm dist          # build bundles + package installers with electron-builder
pnpm mcp           # start the MCP stdio server (for MCP-capable agents)
pnpm api           # start the HTTP JSON API on 127.0.0.1:8788
```

## Usage

| Action                | How                                                                   |
| --------------------- | --------------------------------------------------------------------- |
| Focus a thought       | Click it, or arrow-key to it and press Enter/Space                    |
| Move selection        | Arrow keys (Up parents · Down children · Left jumps · Right siblings) |
| Back / Forward        | Toolbar, `Esc`, or `Shift+Backspace`                                  |
| Search & jump         | `Ctrl/Cmd + K`                                                        |
| Add child/parent/jump | Toolbar buttons, or click the gate / empty zone around the focus      |
| Create a sibling      | Click the empty sibling zone (right) — born as the parent's child     |
| Rename                | Toolbar or `F2`                                                       |
| Link two thoughts     | Drag a node onto another (plain = jump, Shift = parent → child)        |
| Thought inspector     | Toolbar `Info` or `I` (name / description / color / type / jump via links) |
| Attach content        | Inspector list/form, or drop files onto the graph (→ focused thought)  |
| Pin a thought         | Toolbar (appears in the top-left pinboard)                            |
| Timeline (recent)     | Toolbar `Recent` or `T` — click a row to focus it                      |
| Minimap               | Bottom-right 2-hop overview; click a dot to focus that thought         |
| Filtered sets         | Toolbar `Sets` or `S` — save/run/delete named searches (text/type/tag)  |
| Tag the focus         | Top-right tag field                                                   |

## Data model (SQLite)

- `thoughts(id, name, description, color, type, pinned, archived, created_at, updated_at)`
- `links(id, from_id, to_id, type, created_at)` where `type` is `child` (directed
  parent→child) or `jump` (undirected). Siblings are **derived**, never stored.
- `attachments`, `tags`, `thought_tags` for anchors/labels.
- `thoughts_fts` — an FTS5 index kept in sync by triggers on `thoughts`.
- `sets(id, name, description, def_json, …)` — saved filtered sets; `def_json`
  holds `{text?, type?, tag?}`, interpreted (AND-ed) by the repository.

The database lives in the OS user-data directory (on Linux
`~/.config/@the-brain/desktop/brain.db`), so your knowledge base is a single
portable file. Every consumer (desktop, MCP, API) opens the **same file** —
WAL mode + `busy_timeout` let them read and write concurrently. Override the
location with `BRAIN_DB_PATH=/path/to/brain.db`.

### TheBrain architecture learnings (from the official docs & community guides)

- **One brain, many paths**: TheBrain is a single graph, not a folder tree — the
  same thought can have **multiple parents**, so an idea lives in several
  contexts at once without duplication.
- **Jumps are associations, not hierarchy**: links like _Sam → Utah_ ("lives
  in") are non-hierarchical and undirected — exactly our `jump` type.
- **Siblings are derived**: the app never stores "sibling" edges; they appear
  because two thoughts share a parent. Our schema matches this.
- **Orphans are fine**: a thought with no links is a valid starting point, not
  an error. Search and the pinboard are the main rescue routes back to it.
- **Zones, not radial graphs** (TheBrain 13 User Guide, glossary "Zones"): the
  Plex shows the active thought at the center with four fixed zones — **parent
  zone above**, **child zone below**, **jump zone to the left**, and **sibling
  zone to the right** (siblings hang off the shared parent, not the focus —
  they are the parent's other children). Every relationship is relative to the
  current focus: the same thought can be a parent of one node and a child of
  another.
- **Gates**: each thought has small circular gates — parent above, child
  below, jump to the left — solid when links exist, hollow when not. The
  focus node renders them, and clicking one (or any blank area of a zone)
  opens the create dialog for that relationship.
- **Links converge on side anchors**: all child curves leave the focus from a
  single point at its bottom edge (jumps from its left edge; siblings fan out
  of the parent's right edge), producing the signature fan of thin bezier
  curves with a dot at the far end — no arrowheads, no elbow brackets.
- **Intimacy**: legacy TheBrain showed a number on each link — how strongly a
  thought relates to the focus. We compute it in `@the-brain/core`
  (`computeIntimacy`: direct links + shared neighbors) and render it on links
  with score > 1; the viewport API/MCP response exposes it as `intimacy`.

## How navigation works

1. The renderer asks the main process for the **1-hop neighborhood** of the focus
   (`getNeighborhood`) — only the focus, its direct neighbors, and the links
   between them. This keeps the query cheap even for very large brains.
2. `@the-brain/core` `computeViewport()` groups that neighborhood into roles.
3. `layoutViewport()` assigns deterministic banded positions and edge anchors.
4. The Canvas renderer eases each node from its old position to the new one, so
   re-focusing "flows" instead of snapping.

## Agent access: MCP + HTTP API

The graph is not locked inside the Electron window — AI agents (and scripts)
can read and write the same brain through two servers that share the desktop's
SQLite file.

### MCP server (`packages/mcp`)

A stdio Model Context Protocol server with 28 tools: `brain_get_root`,
`brain_get_thought`, `brain_get_neighborhood`, `brain_list_recent` (timeline),
`brain_get_subgraph` (minimap data: the depth-hop neighborhood around a
thought), `brain_navigate` (returns the
role-grouped viewport — focus/parents/children/jumps/siblings, i.e. "what the
UI would show"), `brain_search`, `brain_list_pinned`, `brain_list_tags`,
`brain_create_thought`, `brain_update_thought`, `brain_delete_thought`
(`detach` or `cascade`), `brain_link`, `brain_unlink`, `brain_set_pinned`,
`brain_add_tag`, `brain_remove_tag`, `brain_list_attachments`,
`brain_add_attachment`, `brain_remove_attachment`, `brain_list_sets`,
`brain_create_set`, `brain_run_set`, `brain_delete_set` (filtered sets) — plus
the app-control tools
`brain_get_app_state`, `brain_set_app_focus`, `brain_app_rpc` and
`brain_app_screenshot` (see *Driving the running app*).

Register it in any MCP-capable client (Claude Desktop, OpenClaw, etc.):

```json
{
  "mcpServers": {
    "the-brain": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/the-brain/packages/mcp", "start"]
    }
  }
}
```

### HTTP API (`packages/api`)

```bash
pnpm api            # listens on http://127.0.0.1:8788 (PORT / HOST to change)
curl localhost:8788/   # prints the endpoint index
```

| Read  | `GET /root` · `/thought/:id` · `/neighborhood/:id` · `/viewport/:id` · `/search?q=` · `/pinned` · `/recent?limit=` · `/subgraph/:id?depth=` · `/sets` · `/sets/:id/thoughts` · `/tags/:thoughtId` · `/attachments/:thoughtId` |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| Write | `POST /thoughts` · `PATCH /thoughts/:id` · `DELETE /thoughts/:id?mode=detach\|cascade`                               |
| Links | `POST /links` · `DELETE /links` (body: `{fromId,toId,type}`)                                                         |
| Tags  | `POST /tags` · `DELETE /tags` (body: `{thoughtId,name}` / `{thoughtId,tagId}`)                                       |
| Attach | `POST /attachments` (body: `{thoughtId,kind,uri,label?}`) · `DELETE /attachments` (body: `{thoughtId,id}`)         |
| Sets  | `POST /sets` (body: `{name,def:{text?,type?,tag?}}`) · `DELETE /sets/:id`                                          |
| App   | `GET /state` · `PUT /state/focus` (body: `{id}`) · `POST /app/rpc` · `GET /app/screenshot` (raw PNG)                 |

`GET /viewport/:id` is the agent-friendly projection of the focus view: the
same role grouping the canvas renders.

### Driving the running app (no mouse required)

The desktop window is fully controllable over the shared SQLite file, so agents
can navigate, screenshot and introspect it on a shared machine without ever
grabbing the pointer:

- **Focus**: `PUT /state/focus` / `brain_set_app_focus` write `app_state('focus')`;
  the app polls it (~250 ms) and navigates. The app publishes its own focus
  changes back, so `GET /state` always mirrors what the user sees.
- **App RPC**: `POST /app/rpc` / `brain_app_rpc` publish a request on
  `app_state('rpc:req')`; the desktop's main process executes it and answers on
  `rpc:res` (id-matched, `packages/db/src/appRpc.ts`). Methods: `ping`
  (liveness + focus), `screenshot` (PNG via `capturePage` — renders offscreen,
  does **not** raise or focus the window), `get_view` (live renderer state:
  focus, selection, role counts, layout node coordinates — via the
  `window.__brainDebug` hook) and `ui` (params `{action, args}` — runs any
  store action through `window.__brainRpc`: `reload`, `navigate`, `back`,
  `forward`, `select`, `commit`, `toggle_inspector`, `toggle_timeline`, `toggle_sets`, `set_type` (on the
  focus; empty string clears), `create_set {name,def}` / `run_set {setId}` /
  `delete_set {setId}` (filtered sets; `run_set` opens the Sets panel), `set_dialog` (open/close
  the create/rename/delete modal), `link`, `sim_drag` (replays a drag gesture
  through the real DOM handlers), `sim_click {dx,dy}` (replays a click offset
  from a node — verifies gate/zone routing), `add_attachment` /
  `remove_attachment`, `add_child`/`add_parent`/`add_jump`/`add_sibling`,
  `rename`, `delete`, `toggle_pin`, `add_tag`, `remove_tag`). `brain_app_screenshot` /
  `GET /app/screenshot` wrap the screenshot method as an MCP image / raw PNG
  for convenience.

### Smoke tests

End-to-end checks against isolated DBs (no real brain touched):

```bash
node packages/mcp/scripts/smoke-mcp.mjs   # spawns the MCP server, drives tools via stdio
pnpm api &                                 # then:
node packages/api/scripts/smoke-api.mjs   # CRUD + viewport + search over HTTP
```

## Roadmap / deferred

Not yet built (tracked as post-MVP backlog): the force-directed global
"overview" map, a richer attachment/anchor viewer, multi-device sync, a
plugin/scripting API, AI integrations, and OPML/JSON import-export.

## Notes & known limitations

- On pnpm 10+, dependency build scripts are blocked until approved. This repo
  allows them via `onlyBuiltDependencies` / `allowBuilds` in
  `pnpm-workspace.yaml`; if you see `ERR_PNPM_IGNORED_BUILDS`, run step 2
  (`rebuild`) to compile `better-sqlite3` for Electron.
- `better-sqlite3` is split by runtime on purpose: `packages/db` (and thus the
  MCP/API/tests) uses `^12`, which compiles on Node 20–26; `apps/desktop` uses
  `^11` compiled against **Electron's** ABI via `electron-rebuild` (step 2).
  Do not "unify" these to v13: its N-API binaries load in Node but **hang on
  open inside Electron 33** (dlopen never returns), and v11 cannot compile
  against Node 26 V8 headers. After major Node or Electron upgrades, re-run
  `pnpm install` and `pnpm --filter @the-brain/desktop run rebuild`.
- Add a `apps/desktop/resources/icon.png` (512×512) for polished package icons
  before running `pnpm dist`.
- The app is a GUI and needs a display; CI-style headless environments can run
  `pnpm test`, `pnpm typecheck`, and `pnpm build`, but not `pnpm dev`.

## License

Released under the [MIT License](./LICENSE). "TheBrain" is a trademark of its
respective owner; this project is an independent, free implementation of the
navigation concept and is not affiliated with or endorsed by TheBrain.

import type Database from 'better-sqlite3'

/**
 * Applies the brain schema. Idempotent via a schema_version table.
 * Search is backed by a standalone FTS5 table kept in sync by triggers on
 * `thoughts` (thought_id is UNINDEXED; name/description are searchable).
 */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  const current =
    (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null })?.v ??
    0

  const run = db.transaction((ver: number, sql: string) => {
    db.exec(sql)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      ver,
      Date.now()
    )
  })

  if (current < 1) {
    run(
      1,
      `
      CREATE TABLE thoughts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        color       TEXT,
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE links (
        id         TEXT PRIMARY KEY,
        from_id    TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        to_id      TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        type       TEXT NOT NULL CHECK (type IN ('child','jump')),
        created_at INTEGER NOT NULL,
        UNIQUE (from_id, to_id, type)
      );
      CREATE INDEX links_from_idx ON links(from_id, type);
      CREATE INDEX links_to_idx   ON links(to_id, type);

      CREATE TABLE attachments (
        id         TEXT PRIMARY KEY,
        thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('file','url','image')),
        uri        TEXT NOT NULL,
        mime       TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE tags (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE thought_tags (
        thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (thought_id, tag_id)
      );

      CREATE VIRTUAL TABLE thoughts_fts USING fts5(
        thought_id UNINDEXED,
        name,
        description,
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER thoughts_ai AFTER INSERT ON thoughts BEGIN
        INSERT INTO thoughts_fts (thought_id, name, description)
        VALUES (new.id, new.name, new.description);
      END;

      CREATE TRIGGER thoughts_ad AFTER DELETE ON thoughts BEGIN
        DELETE FROM thoughts_fts WHERE thought_id = old.id;
      END;

      CREATE TRIGGER thoughts_au AFTER UPDATE ON thoughts BEGIN
        UPDATE thoughts_fts SET name = new.name, description = new.description
        WHERE thought_id = new.id;
      END;
    `
    )
  }

  if (current < 2) {
    run(
      2,
      `
      -- Shared app-view state (e.g. 'focus'): the desktop window reads/writes
      -- it, and the HTTP API / MCP server use it to drive the running app.
      CREATE TABLE app_state (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at INTEGER NOT NULL
      );
    `
    )
  }

  if (current < 3) {
    run(
      3,
      `
      -- Attachments v2: add 'thought' (anchor thoughts) as a kind and an
      -- optional display label. SQLite cannot ALTER a CHECK, so rebuild.
      CREATE TABLE attachments_new (
        id         TEXT PRIMARY KEY,
        thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('file','url','image','thought')),
        uri        TEXT NOT NULL,
        label      TEXT,
        mime       TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO attachments_new (id, thought_id, kind, uri, mime, created_at)
        SELECT id, thought_id, kind, uri, mime, created_at FROM attachments;
      DROP TABLE attachments;
      ALTER TABLE attachments_new RENAME TO attachments;
    `
    )
  }

  if (current < 4) {
    run(
      4,
      `
      -- Thought types (TheBrain "thought types"): free-form label, presets in
      -- the shared THOUGHT_TYPES list; drives the node icon on the canvas.
      ALTER TABLE thoughts ADD COLUMN type TEXT;
    `
    )
  }

  if (current < 5) {
    run(
      5,
      `
      -- Filtered sets (TheBrain "filtered sets"): saved searches whose JSON
      -- definition {text?, type?, tag?} is interpreted by the repository.
      CREATE TABLE sets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        def_json    TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `
    )
  }
}

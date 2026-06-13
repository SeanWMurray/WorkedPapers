-- Migration 005: Document template engine.
-- Free-form HTML templates with {{ }} tag expansion, packaged into ordered
-- report packages. Supports note cross-referencing, image/asset embedding,
-- and structured statement embeds.

-- Logos, signatures, letterheads — stored as base64 blobs so the engagement
-- is fully self-contained regardless of where the .db file is moved.
CREATE TABLE IF NOT EXISTS doc_assets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,   -- "firm_logo", "partner_sig"
    mime_type   TEXT    NOT NULL,          -- "image/png", "image/jpeg", "image/svg+xml"
    data_base64 TEXT    NOT NULL,
    width_px    INTEGER,
    height_px   INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Free-form HTML templates with {{ }} tags.
CREATE TABLE IF NOT EXISTS doc_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    kind        TEXT    NOT NULL DEFAULT 'CUSTOM',  -- COVER|LETTER|NOTES|FS_EMBED|CUSTOM
    body_html   TEXT    NOT NULL DEFAULT '',
    description TEXT,
    is_system   INTEGER NOT NULL DEFAULT 0,          -- seeded default, still editable
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- An ordered collection of documents that renders as a single output.
CREATE TABLE IF NOT EXISTS doc_packages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Each item is either a doc_template instance or a structured statement embed.
CREATE TABLE IF NOT EXISTS doc_package_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id      INTEGER NOT NULL REFERENCES doc_packages(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    item_kind       TEXT    NOT NULL CHECK (item_kind IN ('template', 'statement')),
    doc_template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL,
    statement_id    INTEGER REFERENCES statements(id)    ON DELETE SET NULL,
    -- Per-item variable overrides as JSON: e.g. {"title": "Balance Sheet"}
    var_overrides   TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pkg_items_pkg ON doc_package_items(package_id);

-- Note registry: rebuilt on every render pass 1, persisted so the editor can
-- show note numbers without requiring a full render.
-- Always DELETE WHERE package_id = ? before re-inserting to avoid stale rows.
CREATE TABLE IF NOT EXISTS doc_note_registry (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id  INTEGER NOT NULL REFERENCES doc_packages(id) ON DELETE CASCADE,
    note_key    TEXT    NOT NULL,
    note_number INTEGER NOT NULL,
    title       TEXT,
    UNIQUE (package_id, note_key),
    UNIQUE (package_id, note_number)
);

CREATE INDEX IF NOT EXISTS idx_note_registry_pkg ON doc_note_registry(package_id);

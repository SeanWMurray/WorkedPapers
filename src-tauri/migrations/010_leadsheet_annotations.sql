-- Per-account annotations on a leadsheet: a free-text note and/or a file cabinet reference
CREATE TABLE IF NOT EXISTS leadsheet_annotations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number  TEXT NOT NULL,
    scope           TEXT NOT NULL,   -- "map:1000" or "group:3"
    note            TEXT,
    cabinet_item_id INTEGER REFERENCES file_cabinet_items(id) ON DELETE SET NULL,
    updated_by      TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_number, scope)
);

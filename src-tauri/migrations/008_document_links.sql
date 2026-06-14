-- Migration 008: document links in file cabinet
-- Adds doc_template_id and expands the kind CHECK to include 'document'.

ALTER TABLE file_cabinet_items ADD COLUMN doc_template_id INTEGER REFERENCES doc_templates(id) ON DELETE CASCADE;

-- SQLite cannot ALTER a CHECK constraint directly, so recreate the table.
CREATE TABLE file_cabinet_items_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id        INTEGER REFERENCES file_cabinet_folders(id) ON DELETE SET NULL,
    kind             TEXT    NOT NULL CHECK (kind IN ('file', 'leadsheet', 'document')),
    display_name     TEXT    NOT NULL,
    file_path        TEXT,
    leadsheet_scope  TEXT,
    doc_template_id  INTEGER REFERENCES doc_templates(id) ON DELETE CASCADE,
    sort_order       INTEGER NOT NULL DEFAULT 0
);

INSERT INTO file_cabinet_items_new
    SELECT id, folder_id, kind, display_name, file_path, leadsheet_scope, doc_template_id, sort_order
    FROM file_cabinet_items;

DROP TABLE file_cabinet_items;
ALTER TABLE file_cabinet_items_new RENAME TO file_cabinet_items;

CREATE INDEX IF NOT EXISTS idx_cabinet_items_folder ON file_cabinet_items(folder_id);

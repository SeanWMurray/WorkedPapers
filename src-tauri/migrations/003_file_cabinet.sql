-- Migration 003: File cabinet — virtual folder tree for the Files page.
-- Real files stay flat on disk; folder structure and ordering live here.
-- Leadsheet links are pure DB entries with no on-disk counterpart.

CREATE TABLE IF NOT EXISTS file_cabinet_folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    parent_id   INTEGER REFERENCES file_cabinet_folders(id) ON DELETE CASCADE,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- kind: 'file' | 'leadsheet'
-- file_path: bare filename relative to the engagement directory (kind='file')
-- leadsheet_scope: e.g. 'map:1000' or 'group:3'        (kind='leadsheet')
-- folder_id NULL means the item lives at the root level
CREATE TABLE IF NOT EXISTS file_cabinet_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id        INTEGER REFERENCES file_cabinet_folders(id) ON DELETE SET NULL,
    kind             TEXT    NOT NULL CHECK (kind IN ('file', 'leadsheet')),
    display_name     TEXT    NOT NULL,
    file_path        TEXT,
    leadsheet_scope  TEXT,
    sort_order       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cabinet_folders_parent ON file_cabinet_folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_cabinet_items_folder   ON file_cabinet_items(folder_id);

-- Migration 002: Remove account_type column from tb_accounts.
-- SQLite requires a full table rebuild to drop a column.

PRAGMA foreign_keys=OFF;

CREATE TABLE tb_accounts_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number  TEXT NOT NULL UNIQUE,
    account_name    TEXT NOT NULL,
    current_balance REAL NOT NULL DEFAULT 0.0,
    prior_balance   REAL NOT NULL DEFAULT 0.0,
    map_number      TEXT REFERENCES map_numbers(code) ON DELETE SET NULL,
    notes           TEXT,
    imported_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO tb_accounts_new (id, account_number, account_name, current_balance, prior_balance, map_number, notes, imported_at)
SELECT id, account_number, account_name, current_balance, prior_balance, map_number, notes, imported_at
FROM tb_accounts;

DROP TABLE tb_accounts;
ALTER TABLE tb_accounts_new RENAME TO tb_accounts;

-- Recreate the index (was dropped with the old table)
CREATE INDEX IF NOT EXISTS idx_tb_accounts_map ON tb_accounts(map_number);

PRAGMA foreign_keys=ON;

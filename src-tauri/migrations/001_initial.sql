-- ============================================================
-- Migration 001: Initial schema
-- All monetary values stored as REAL (64-bit float).
-- Timestamps stored as TEXT in ISO-8601 UTC format.
-- ============================================================

-- ── Engagement Metadata ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS engagement (
    id           TEXT PRIMARY KEY,
    entity_name  TEXT NOT NULL,
    year_end     TEXT NOT NULL,   -- "YYYY-MM-DD"
    fiscal_year  INTEGER NOT NULL,
    currency     TEXT NOT NULL DEFAULT 'USD',
    is_locked    INTEGER NOT NULL DEFAULT 0,  -- 0=open, 1=locked
    lock_hash    TEXT,            -- SHA-256 seal set on lockdown
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Map Numbers (hierarchical) ────────────────────────────────
CREATE TABLE IF NOT EXISTS map_numbers (
    code        TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    parent_code TEXT REFERENCES map_numbers(code) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    fs_line     TEXT    -- optional financial-statement line tag
);

-- ── Custom Groupings ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groupings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    color       TEXT  -- hex color for UI chip
);

-- ── Trial Balance Accounts ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tb_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number  TEXT NOT NULL UNIQUE,
    account_name    TEXT NOT NULL,
    account_type    TEXT NOT NULL,   -- ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE | OTHER_INCOME | OTHER_EXPENSE
    current_balance REAL NOT NULL DEFAULT 0.0,
    prior_balance   REAL NOT NULL DEFAULT 0.0,
    map_number      TEXT REFERENCES map_numbers(code) ON DELETE SET NULL,
    notes           TEXT,
    imported_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Account ↔ Grouping many-to-many ──────────────────────────
CREATE TABLE IF NOT EXISTS account_groupings (
    account_id  INTEGER NOT NULL REFERENCES tb_accounts(id) ON DELETE CASCADE,
    grouping_id INTEGER NOT NULL REFERENCES groupings(id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, grouping_id)
);

-- ── Adjusting Journal Entries ─────────────────────────────────
CREATE TABLE IF NOT EXISTS ajes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    aje_number   TEXT NOT NULL UNIQUE,
    entry_type   TEXT NOT NULL,   -- ADJUSTING | RECLASSIFYING | TAX
    description  TEXT NOT NULL,
    prepared_by  TEXT NOT NULL,
    posted_at    TEXT NOT NULL DEFAULT (datetime('now')),
    is_voided    INTEGER NOT NULL DEFAULT 0,
    voided_reason TEXT
);

CREATE TABLE IF NOT EXISTS aje_lines (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    aje_id         INTEGER NOT NULL REFERENCES ajes(id) ON DELETE CASCADE,
    account_number TEXT NOT NULL,
    debit          REAL NOT NULL DEFAULT 0.0,
    credit         REAL NOT NULL DEFAULT 0.0,
    description    TEXT
);

-- ── Custom Variables (for report linking) ─────────────────────
CREATE TABLE IF NOT EXISTS custom_vars (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT
);

-- ── Leadsheet Notes ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leadsheet_notes (
    scope       TEXT PRIMARY KEY,   -- e.g. "map:1000" or "group:3"
    content     TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by  TEXT NOT NULL
);

-- ── Tickmarks ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tickmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    description TEXT NOT NULL,
    anchor      TEXT NOT NULL,      -- account_number or doc_ref
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Sign-offs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signoffs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scope           TEXT NOT NULL,   -- "leadsheet:MAP", "engagement", etc.
    role            TEXT NOT NULL,   -- PREPARER | REVIEWER | PARTNER
    signed_by       TEXT NOT NULL,
    signed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    signature_hash  TEXT NOT NULL
);

-- ── Audit Trail (append-only, never deleted) ──────────────────
CREATE TABLE IF NOT EXISTS audit_trail (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    action       TEXT NOT NULL,
    entity       TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    performed_by TEXT NOT NULL,
    performed_at TEXT NOT NULL DEFAULT (datetime('now')),
    detail       TEXT NOT NULL DEFAULT '{}'  -- JSON blob
);

-- ── Performance Indexes ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tb_accounts_map    ON tb_accounts(map_number);
CREATE INDEX IF NOT EXISTS idx_tb_accounts_type   ON tb_accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_aje_lines_account  ON aje_lines(account_number);
CREATE INDEX IF NOT EXISTS idx_aje_lines_aje_id   ON aje_lines(aje_id);
CREATE INDEX IF NOT EXISTS idx_signoffs_scope     ON signoffs(scope);
CREATE INDEX IF NOT EXISTS idx_audit_entity       ON audit_trail(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_performed_at ON audit_trail(performed_at);

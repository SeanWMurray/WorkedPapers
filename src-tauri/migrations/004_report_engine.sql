-- Migration 004: Programmable report engine.
-- A statement is DATA, not hardcoded: an ordered tree of typed lines whose
-- amounts are resolved from map totals, custom variables, and formulas.

CREATE TABLE IF NOT EXISTS statements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    kind        TEXT    NOT NULL DEFAULT 'CUSTOM', -- BALANCE_SHEET | INCOME_STATEMENT | CASH_FLOW | EQUITY | CUSTOM
    sort_order  INTEGER NOT NULL DEFAULT 0
);

-- line_type:
--   HEADER   — section title, no amount
--   MAP      — pull map total(s); expression = 'M:1000' or 'SUM(1000..1999)'
--   FORMULA  — arithmetic over line refs / maps / vars; e.g. 'L:5 + L:6'
--   SUBTOTAL — sum of immediate child lines (expression optional override)
--   VAR      — a custom_vars value; expression = 'V:company_name'
--   SPACER   — blank row
--
-- line_no is a stable per-statement number used by L: references (independent of
-- sort_order so reordering rows doesn't break formulas).
CREATE TABLE IF NOT EXISTS statement_lines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id  INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
    parent_id     INTEGER REFERENCES statement_lines(id) ON DELETE CASCADE,
    line_no       INTEGER NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    line_type     TEXT    NOT NULL,
    label         TEXT    NOT NULL DEFAULT '',
    expression    TEXT,
    bold          INTEGER NOT NULL DEFAULT 0,
    underline     INTEGER NOT NULL DEFAULT 0,
    show_prior    INTEGER NOT NULL DEFAULT 1,
    invert_sign   INTEGER NOT NULL DEFAULT 0   -- flip sign (e.g. show credit-balance revenue as positive)
);

CREATE INDEX IF NOT EXISTS idx_statement_lines_stmt   ON statement_lines(statement_id);
CREATE INDEX IF NOT EXISTS idx_statement_lines_parent ON statement_lines(parent_id);

# Document Template Engine — Architecture Design

## Overview

A **document** is raw HTML with `{{ }}` tags resolved at render time. A **package** is an ordered list of documents (cover page, BS, IS, notes, letters) that render into one printable output.

The existing line-based statement engine (`statements` / `statement_lines`) is preserved unchanged — it becomes one more thing a template can embed via `{{statement:balance_sheet}}`. Everything in this design layers on top of the existing engine, it does not replace it.

---

## Tag Syntax

All tags use `{{ }}` delimiters. Whitespace inside braces is stripped. Tags are dispatched by prefix — known directives are matched first, then the remainder falls through to the existing financial expression evaluator.

### Financial Expressions (existing engine — unchanged)

```
{{M:1000}}                          map total, current axis
{{SUM(4000..4999) * -1}}            arithmetic expression, current axis
{{SUM(4000..4999) * -1|prior}}      same expression, prior-year axis
{{G:42}}                            grouping sum by ID
{{A:1010}}                          single account balance
{{L:5}}                             line reference (within a statement embed)
```

The `|prior` axis modifier applies to the whole expression. Default is current. The existing `EvalContext` already has both axes.

### Engagement Metadata

```
{{entity_name}}
{{year_end}}                        formatted: "December 31, 2024"
{{year_end|short}}                  ISO: "2024-12-31"
{{fiscal_year}}                     "2024"
{{currency}}                        "USD"
{{prepared_date}}                   today's date at render time
{{preparer_name}}                   from app settings (user_name)
{{preparer_initials}}               from app settings (user_initials)
```

### Custom Variables

```
{{V:engagement_partner}}            raw text value (not parsed as number)
{{V:tax_rate}}                      also usable inside financial expressions as V:key
```

When used bare (not nested inside a financial expression), inserts raw text. The same `V:key` syntax works inside arithmetic: `{{V:tax_rate * M:5000}}`.

### Note Cross-References

```
{{note_ref:cash}}                   renders "Note 1" — first appearance anchors the number
{{note_ref:cash|inline}}            renders superscript "(1)"
{{note_def:cash|title=Cash and Cash Equivalents}}
                                    marks where the actual note lives;
                                    renders "Note 1 — Cash and Cash Equivalents" as a heading
```

- `note_ref` and `note_def` share the same key (a programmer-friendly slug).
- Multiple `note_ref` tags with the same key all render the same number.
- The first appearance of a key in document order (pass 1 scan) establishes its number.
- If `note_def` appears before any `note_ref` for that key, the definition anchors the number.
- Note refs can appear inside **statement line labels**: `"Cash and Cash Equivalents  {{note_ref:cash}}"` stored directly in `statement_lines.label`.

### Statement Embeds

```
{{statement:balance_sheet}}         embed by kind (BALANCE_SHEET)
{{statement:income_statement}}
{{statement:cash_flow}}
{{statement:equity}}
{{statement:id:42}}                 embed by database ID (for CUSTOM statements)
```

When encountered, the renderer calls `resolve_statement`, expands any `note_ref` tags in line labels, builds an HTML `<section>` block, and substitutes it inline. The surrounding template controls letterhead and margins; the embed controls the numeric table.

### Images / Assets

```
{{image:firm_logo}}                 renders <img> with base64 data URI
{{image:firm_logo|width=200px}}
{{image:partner_sig|width=120px|alt=Authorized Signature}}
```

### Conditional Tags (reserved — not implemented in phase 1)

```
{{if:V:show_prior_year}}
  ... content ...
{{/if}}
```

Reserved syntax. The tag scanner must detect and skip balanced `if`/`/if` blocks rather than erroring on them, so templates that use them don't break when conditional rendering is added later.

### Literal Escape

```
{{{ }}}     renders a literal {{ }}
```

---

## Note Numbering — Two-Pass Algorithm

Note numbering cannot be done in a single pass. The balance sheet must say "Note 1" before the notes section has been rendered. The two-pass design is mandatory.

### Pass 1 — Discovery

```
note_registry = {}          -- key -> { number, title, first_item_id, first_offset }
next_number   = 1

for each package_item in package.items (sorted by sort_order):
    if item.kind == 'template':
        source = item.body_html
    if item.kind == 'statement':
        -- synthetic source: concatenated line labels from resolve_statement()
        source = resolved_statement.lines.map(l => l.label).join("\n")

    for each {{ tag }} in source (left to right):
        if tag is note_ref:KEY or note_def:KEY:
            if KEY not in note_registry:
                note_registry[KEY] = {
                    number: next_number,
                    title:  (from note_def title= param if present, else null),
                }
                next_number += 1
```

After pass 1, persist the registry to `doc_note_registry` (delete existing rows for this package_id, then bulk-insert) so the editor can display note numbers without a full re-render.

### Pass 2 — Render

```
for each package_item in package.items:
    if item.kind == 'template':
        fragment = expand_tags(item.body_html, note_registry, ctx)
    if item.kind == 'statement':
        -- expand note_ref tags in line labels first, then build the HTML table
        fragment = render_statement_html(resolved, note_registry, ctx)
    output_fragments.push(fragment)
```

`expand_tags` is a left-to-right regex replacement dispatching each `{{ }}` match:

```
dispatch_tag(tag, note_registry, ctx):
    match prefix:
        note_ref:KEY      -> format_note_number(note_registry[KEY], modifier)
        note_def:KEY      -> format_note_heading(note_registry[KEY])
        image:NAME        -> "<img src=\"data:mime;base64,...\" />"
        statement:KIND    -> render_statement_embed(KIND, note_registry, ctx)
        entity_name       -> ctx.engagement.entity_name
        year_end          -> format_date(ctx.engagement.year_end, modifier)
        fiscal_year       -> ctx.engagement.fiscal_year.to_string()
        prepared_date     -> today()
        preparer_name     -> ctx.settings.user_name
        preparer_initials -> ctx.settings.user_initials
        V:KEY             -> ctx.vars[KEY]  (raw text)
        else              -> eval_financial_expr(tag, ctx)  -- existing engine
```

**Critical**: tag expansion runs on line labels in Rust before any HTML escaping. If `esc()` runs first, the `{{` characters get escaped and the tags are never found.

---

## Database Schema (migration 005)

File: `src-tauri/migrations/005_document_templates.sql`

```sql
-- Logos, signatures, letterheads stored as base64 blobs.
-- Self-contained in the DB — no filesystem paths that break on move/extract.
CREATE TABLE IF NOT EXISTS doc_assets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,   -- "firm_logo", "partner_sig"
    mime_type   TEXT    NOT NULL,          -- "image/png", "image/jpeg", "image/svg+xml"
    data_base64 TEXT    NOT NULL,          -- base64-encoded binary
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

-- An ordered set of documents that renders as one output.
CREATE TABLE IF NOT EXISTS doc_packages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Each item is a template instance or a structured statement embed.
CREATE TABLE IF NOT EXISTS doc_package_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id      INTEGER NOT NULL REFERENCES doc_packages(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    item_kind       TEXT    NOT NULL CHECK (item_kind IN ('template', 'statement')),
    doc_template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL,
    statement_id    INTEGER REFERENCES statements(id)    ON DELETE SET NULL,
    var_overrides   TEXT    NOT NULL DEFAULT '{}'        -- per-item JSON overrides
);

CREATE INDEX IF NOT EXISTS idx_pkg_items_pkg ON doc_package_items(package_id);

-- Rebuilt on every pass 1. Persisted so the editor shows note numbers without re-render.
-- Always DELETE WHERE package_id = ? before re-inserting (never accumulate stale rows).
CREATE TABLE IF NOT EXISTS doc_note_registry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id   INTEGER NOT NULL REFERENCES doc_packages(id) ON DELETE CASCADE,
    note_key     TEXT    NOT NULL,
    note_number  INTEGER NOT NULL,
    title        TEXT,
    UNIQUE (package_id, note_key),
    UNIQUE (package_id, note_number)
);

CREATE INDEX IF NOT EXISTS idx_note_registry_pkg ON doc_note_registry(package_id);
```

---

## Rust Models (additions to models.rs)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocAsset {
    pub id: i64,
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub width_px: Option<i64>,
    pub height_px: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocTemplate {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub body_html: String,
    pub description: Option<String>,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocPackage {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocPackageItem {
    pub id: i64,
    pub package_id: i64,
    pub sort_order: i32,
    pub item_kind: String,
    pub doc_template_id: Option<i64>,
    pub statement_id: Option<i64>,
    pub var_overrides: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteInfo {
    pub note_key: String,
    pub note_number: i32,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderPackageResult {
    pub fragments: Vec<String>,
    pub note_registry: Vec<NoteInfo>,
    pub engagement: EngagementMeta,
}
```

---

## Tauri Commands (new file: commands/templates.rs)

```
-- Asset management
upsert_doc_asset(name, mime_type, data_base64, width_px?, height_px?) -> i64
list_doc_assets() -> Vec<DocAsset>
delete_doc_asset(id)

-- Template management
upsert_doc_template(id?, name, kind, body_html, description?) -> i64
list_doc_templates() -> Vec<DocTemplate>
get_doc_template(id) -> DocTemplate
delete_doc_template(id)

-- Package management
upsert_doc_package(id?, name, description?) -> i64
list_doc_packages() -> Vec<DocPackage>
delete_doc_package(id)

-- Package item management
upsert_package_item(id?, package_id, sort_order, item_kind,
                    doc_template_id?, statement_id?, var_overrides) -> i64
reorder_package_items(ordered_ids: Vec<i64>)
delete_package_item(id)

-- Rendering (the core command — implements both passes)
render_package(package_id) -> RenderPackageResult

-- Utilities
get_note_registry(package_id) -> Vec<NoteInfo>
seed_default_templates() -> usize
```

---

## Render Pipeline

```
User clicks "Preview Package"
  → React: invoke("render_package", { package_id })

    → Rust (render_package command):
        1. Load package + items (by sort_order)
        2. Load engagement meta, settings (preparer name/initials)
        3. Load custom_vars HashMap
        4. Load all doc_assets as HashMap<name, data_uri_string>
        5. Build axis maps — reuse existing fetch_axis_maps, fetch_group_maps,
           fetch_account_maps from commands/reports.rs
        6. Resolve all statement-kind items — reuse existing resolve_statement logic
        7. PASS 1: scan labels + body_html → build note_registry
                   → DELETE + re-insert doc_note_registry rows for this package
        8. PASS 2: expand all {{ }} tags in Rust → Vec<String> (HTML fragments)
        9. Return RenderPackageResult { fragments, note_registry, engagement }

  → React: postMessage({ type: "RENDER_PACKAGE", fragments, engagement })

    → Web Worker (reportRenderer.worker.ts, extended):
        Wraps fragments in full document shell:
          DOCTYPE, <html>, <head> with shared print CSS
          <body>: concatenate fragments with page-break-before between items
          Print footer (page numbers, entity name, date)
        Posts back { type: "RENDERED_PACKAGE", html }

  → React: window.open("", "_blank") → document.write(html)
```

**Why all tag expansion is in Rust, not the Web Worker:** the financial expression evaluator cannot be safely re-implemented in TypeScript without duplicating and diverging from the Rust engine. The Worker only does cosmetic document assembly.

---

## Image Storage Decision

**Base64 blobs in SQLite — not filesystem paths.**

Paths break when the user moves the engagement folder, extracts a `.wwp` archive elsewhere, or rolls forward to a new year's file. Base64 in SQLite survives all of those transparently.

- A 150 KB PNG becomes ~200 KB of TEXT — trivial for SQLite.
- Enforce a **512 KB soft limit** per asset in the UI before the IPC call, with a clear error message.
- In rendered HTML: `<img src="data:image/png;base64,..." />` — works offline, works in `window.open`, works in future PDF export (headless browsers handle data URIs natively).
- Upload flow: React reads file via Tauri `readBinaryFile`, converts to base64 with `btoa`, sends string over IPC. No Node.js APIs needed.

---

## Roll-Forward Extension

The existing `roll_forward` command must copy template data to the new year. Add after the `custom_vars` copy block:

```
Copy: doc_assets       (logos/signatures don't change year to year)
Copy: doc_templates    (firm's templates carry forward)
Copy: doc_packages     (package structure carries forward)
Copy: doc_package_items
Skip: doc_note_registry  (rebuilt on first render of the new year)
```

---

## Editor UI Architecture

### Minimum viable (phase 1) — not a dead end

```
DocumentsPage
  ├── Package selector / list
  ├── Package item list (sortable — same pointer-drag pattern as FilesPage)
  │     each item: [TEMPLATE or STATEMENT badge] [name] [Edit] [Remove]
  ├── Template editor panel (when a template item is selected):
  │     - Name field
  │     - Kind selector (COVER | LETTER | NOTES | FS_EMBED | CUSTOM)
  │     - body_html <textarea> (full width, tall, monospace)
  │     - Tag picker button (opens DataPicker-style modal to insert tags)
  │     - "Preview this document" button (single-item render)
  └── Package actions: [Preview All] [Manage Assets]
```

The textarea holds raw HTML. Swapping in CodeMirror or Monaco later is a one-component change — no backend changes required. The tag picker prevents users from having to memorize syntax.

---

## Traps to Avoid

| Trap | Why it matters | Fix |
|------|---------------|-----|
| Expanding tags in the Web Worker | Financial evaluator is Rust — can't safely re-implement in TS | All `{{ }}` expansion stays in Rust |
| Storing asset disk paths | Break on folder move, .wwp extract, roll-forward | Always blobs in DB |
| Single-pass note numbering | Can't render "Note 1" on BS before scanning the notes section | Two-pass is mandatory |
| Applying `esc()` before tag expansion | Escapes `{{` characters, tags never found | Expand tags in Rust before fragments reach the Worker |
| Accumulating stale note registry rows | Note order changes between previews | Always `DELETE WHERE package_id = ?` then bulk-insert in one transaction |
| Assets over 512 KB | Large images in IPC payload + JS string handling | Enforce soft limit at upload in the UI |
| Note key clashing with expression syntax | `note_ref:cash` looks like a ref prefix | Dispatcher checks known directives before falling through to expression evaluator |

---

## Build Order

### Phase 1 — implement now
1. Migration 005 (all four tables)
2. Rust models (`DocAsset`, `DocTemplate`, `DocPackage`, `DocPackageItem`, `NoteInfo`, `RenderPackageResult`)
3. `commands/templates.rs` — all CRUD commands
4. `render_package` — two-pass compositor
5. Web Worker extension — `RENDER_PACKAGE` message type
6. `roll_forward` extension — copy template tables
7. `DocumentsPage` UI — package list, item list, textarea editor, tag picker, asset manager
8. Two seeded starter templates: Cover Page skeleton, Notes to FS skeleton

### Phase 2 — defer
- CodeMirror editor with `{{ }}` syntax highlighting
- Conditional tags `{{if:}}`/`{{/if}}`
- Per-item `var_overrides` structured UI
- PDF export (headless browser wrapping the existing HTML output)
- Visual block-based template builder

# Technical Specification & Development Roadmap: Next-Gen Working Papers Application

## 1. Project Overview & Objective
**Objective:** Develop a lightning-fast, highly efficient desktop and self-hosted server application for accounting firms, serving as a modern alternative to legacy systems like Caseware Working Papers and SmartSync.
**Core Philosophy:** Prioritize absolute speed, programmatic flexibility, and a strictly minimalist, flat user interface to reduce cognitive load. The system must eliminate legacy bloat while retaining rigorous accounting compliance mechanics.

## 2. Tech Stack (Decided & Implemented)
* **Desktop Client:** Tauri 1.x (Rust backend) + React 18 (TypeScript) + Vite
* **Local Data Store:** SQLite via `rusqlite` (bundled, no external install), WAL mode enabled; schema versioned with numbered migration files (`001_initial.sql`, `002_drop_account_type.sql`, …)
* **State Management:** Jotai (atomic — no global re-renders)
* **Virtual Scrolling:** `react-window` `FixedSizeList` for TB grid
* **CSV Parsing:** PapaParse runs in the browser (main thread), column mapping handled by `TbImportWizard`, mapped rows sent to Rust via IPC in a single transaction
* **Encryption:** AES-256-GCM for `.wwp` archives, SHA-256 for engagement seal hash
* **File Attachment:** `opener` crate for system-default open; files stored alongside the engagement `.db` on disk
* **Settings Persistence:** JSON settings file managed by Rust (`settings.rs`); includes `recent_files` list (max 8), user name/initials, theme
* **Self-Hosted Server:** Planned — Dockerized backend with PostgreSQL (Phase 4)
* **Reporting Engine:** HTML/CSS rendered in Web Worker, PDF export planned (Phase 2)

## 3. Core Feature Requirements

### 3.1. Native File Management & Archiving
* **Direct Directory Mirroring:** Each engagement is a self-contained `.db` file the user saves anywhere on disk. No rigid directory structure enforced.
* **File Attachment Panel:** ✅ **Implemented** — `FilesPage` lists all non-DB files in the engagement directory. Supports drag-and-drop (Tauri `onFileDropEvent`) and file-picker attach. Files are copied into the engagement directory with collision-safe naming. Double-click or "Open" launches with the system default application (`opener` crate). Delete is guarded to the engagement directory only. Locked engagements suppress the delete button.
* **Single-File Compression & Sharing:** ✅ **Implemented** — `.wwp` export compresses the engagement directory into an AES-256-GCM encrypted ZIP. Password set by user at export time. Magic bytes `WWP1` for format versioning. Import decrypts and extracts back to a user-chosen directory.

### 3.2. Trial Balance, Mapping, & AJEs
* **TB Import & Management:** ✅ **Implemented** — CSV import via file dialog. PapaParse parses the raw CSV in the browser. A column-mapping wizard (`TbImportWizard`) auto-guesses field assignments (account number, name, debit, credit, signed balance, prior balance, ignore) with per-column override dropdowns and a live preview of the first 5 rows. Confirmed rows sent to Rust in one IPC call, inserted in a single SQLite transaction (clears existing accounts first). Virtualized grid (`react-window`) renders thousands of rows without DOM overhead. TB summary bar shows total debits, total credits, and net with a BALANCED / OUT OF BALANCE badge.
* **Mapping & Groupings:** ✅ **Implemented** — Hierarchical map numbers (code, label, parent, sort order, FS line tag). Parallel custom groupings with color labels. Many-to-many account↔grouping assignments. Both structures visible in Mapping page with add/edit UI.
* **Adjusting Journal Entries (AJEs):** ✅ **Implemented** — Dedicated AJE ledger supporting Adjusting (AJE), Reclassifying (RJE), and Tax (TJE) entry types. Auto-numbered per type. Debit/credit balance validation before posting. Void (never delete) with reason logging. AJE impact flows dynamically into TB balances and report totals via SQL join. All writes in single transactions.

### 3.3. Year-End Roll-Forward & Data Retention
* **Historical Storage:** Each year is a separate `.db` file — open any prior year independently at any time.
* **File Separation:** ✅ **Implemented** — Roll-forward creates a brand-new `.db` at a user-chosen path. Source file is never touched.
* **Roll-Forward Mechanics:** ✅ **Implemented** — Runs on a Rayon background thread. Balance sheet ending balances (post-AJE) become prior-year balances. P&L accounts zeroed. Map numbers, groupings, leadsheet notes, and custom variables all carry forward. AJEs do not carry forward (they belong to the closed year).

### 3.4. Programmatic Financial Statements & Reporting
* **HTML/CSS Foundation:** ✅ **Implemented (skeleton)** — Report data assembled by Rust (map totals, custom vars, engagement meta) and handed to a Web Worker that generates HTML/CSS output.
* **Dynamic Linking:** ✅ **Implemented** — Map number totals (unadjusted and AJE-adjusted), prior year, and custom variables all pulled from SQLite and embedded in report output.
* **Automated Note Referencing:** *(TODO — Phase 2)*
* **Export:** *(TODO — Phase 2, PDF via headless renderer)*

### 3.5. Audit Mechanics & Workflow
* **Leadsheets & Documents:** ✅ **Implemented** — Leadsheet page shows accounts and AJE lines scoped by map number or grouping. Persistent notes per leadsheet saved to DB. Select from sidebar to open.
* **Tickmarks & Cross-Referencing:** ✅ **Implemented (backend)** — Tickmark data model and Rust commands complete. UI drop/remove *(TODO — Phase 3 full UI)*. Deep-linking from report to leadsheet *(TODO — Phase 3)*.
* **Role-Based Sign-offs & Lockdown:** ✅ **Implemented** — Three-level sign-offs (Preparer, Reviewer, Partner) per leadsheet scope. Engagement lock sets a SHA-256 seal hash stored in DB. All Rust write commands check `is_locked` and return `EngagementLocked` error if set.
* **Immutable Audit Trail:** ✅ **Implemented** — `audit_trail` table is append-only (no deletes, no updates). Every AJE post/void, sign-off, lock, TB import, and roll-forward writes a row with action, entity, performer, timestamp, and JSON detail blob. Viewable in Audit Trail page.

### 3.6. Server & Version Management (Sync)
* **Self-Hosted Architecture:** *(TODO — Phase 4)*
* **Smart Syncing:** *(TODO — Phase 4)*

## 4. UI/UX Design Directives
* **Visual Style:** ✅ **Implemented** — Flat, bordered data grids. No drop shadows or gradients. Black/white monochrome palette with dark mode token support. CSS custom properties for full theme switching.
* **Navigation:** ✅ **Implemented** — `Ctrl+K` / `Cmd+K` command palette with fuzzy search, keyboard arrow navigation, and Enter to execute. Sidebar with section grouping.
* **Information Density:** High-density monospace grids for all financial data. Summary bars for at-a-glance totals.

## 5. Performance & Optimization Architecture

### 5.1. Database Optimization (SQLite) — ✅ Implemented
* WAL mode: `PRAGMA journal_mode=WAL`
* `PRAGMA synchronous=NORMAL` and 32MB page cache
* All bulk writes (TB import, roll-forward) in single transactions
* Indexes on all foreign keys and frequently filtered columns
* Schema-versioned migration system for future upgrades

### 5.2. Backend Threading (Rust / Tauri Engine) — ✅ Implemented
* Rayon global thread pool (4 threads) initialised at startup
* Roll-forward runs entirely on Rayon thread — UI never blocks
* All domain types serialized with `serde` across the IPC bridge
* `AppError` implements `Serialize` for clean IPC error propagation

### 5.3. Frontend Rendering Efficiency — ✅ Implemented
* `react-window` `FixedSizeList` for TB grid — only visible rows rendered
* Jotai atoms: engagement, accounts, AJEs, map numbers, groupings each independent — no cascading re-renders
* CSS custom properties design system — theme switch touches zero JS
* PapaParse CSV parsing + `TbImportWizard` column mapper run in the browser before the IPC call — no Web Worker needed at current volumes
* Web Worker for report HTML generation (off main thread)

### 5.4. Network & Sync Performance
* Delta-syncing: *(TODO — Phase 4)*
* Web Workers for reports: ✅ Implemented

## 6. Development Roadmap

* **Phase 1: Local Foundation (MVP)** — ✅ Complete
    * ✅ Tauri/SQLite architecture with WAL mode, transactions, background threading
    * ✅ Engagement create/open/close with metadata
    * ✅ TB import (CSV → PapaParse → column-mapping wizard → Rust transaction), virtualized grid, summary bar
    * ✅ AJE/RJE/TJE entry, auto-numbering, void, balance validation, dynamic impact
    * ✅ Map numbers (hierarchical) and custom groupings
    * ✅ Leadsheets scoped by map number or grouping, with persistent notes
    * ✅ Three-level sign-offs, engagement lock with cryptographic seal
    * ✅ Immutable audit trail
    * ✅ Year-end roll-forward (Rayon thread, new file, P&L zero, BS carry-forward)
    * ✅ `.wwp` export/import (AES-256-GCM encrypted ZIP)
    * ✅ Command palette (`Ctrl+K`), flat/monochrome design system, dark mode tokens
    * ✅ File attachment panel (copy files into engagement directory, drag-and-drop, system-open, delete)
    * ✅ Recent files list on welcome screen (persisted in settings JSON, max 8, removable)

* **Phase 2: The Reporting Engine**
    * Develop full HTML/CSS financial statement templates (BS, IS, CF, equity)
    * FS note auto-numbering and cross-referencing
    * Custom variable editor UI
    * PDF export via headless renderer (Puppeteer/Playwright or `wkhtmltopdf`)

* **Phase 3: Audit Mechanics & Workflow Polish**
    * Tickmark drop UI on leadsheet rows with symbol picker
    * Deep-link: click a balance on a report → jump to the supporting leadsheet
    * Cross-reference tags between documents
    * Full tickmark and sign-off UI pass

* **Phase 4: Server & Sync Integration**
    * Self-hosted Docker backend (Go or Node.js + PostgreSQL)
    * Delta-sync engine: compute local diffs, push only changed records
    * Conflict resolution UI for offline merge
    * Multi-user awareness (who has a file open)

* **Phase 5: Refinement & AI Integration Hooks**
    * Keyboard shortcut customisation
    * Full UI/UX polish pass
    * REST/IPC endpoints for AI agents to read TB data, map totals, and engagement metadata
    * Auto-draft financial statement notes from TB data via LLM integration

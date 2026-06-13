# Worked Papers

A modern, lightning-fast desktop application for accounting firms — a purpose-built alternative to Caseware Working Papers.

Built with **Tauri** (Rust backend) + **React** (TypeScript frontend) + **SQLite** (local data store).

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | https://nodejs.org |
| Rust + Cargo | ≥ 1.77 | https://rustup.rs |
| Tauri CLI | 1.x | `cargo install tauri-cli` |

> **Windows additional requirements:** Visual Studio C++ Build Tools and WebView2 (usually pre-installed on Windows 11).  
> Install guide: https://tauri.app/v1/guides/getting-started/prerequisites

---

## Getting Started

```bash
# 1. Install JS dependencies
npm install

# 2. Run in development mode (hot-reload frontend + Tauri window)
npm run tauri:dev

# 3. Build a release binary
npm run tauri:build
```

The dev build opens a native window at `localhost:1420` automatically.

---

## Project Structure

```
WorkedPapers/
├── src/                        # React frontend (TypeScript)
│   ├── components/
│   │   ├── layout/             # AppLayout, AppHeader, AppSidebar
│   │   └── ui/                 # CommandPalette, shared UI components
│   ├── hooks/                  # Custom React hooks
│   ├── lib/
│   │   ├── tauri.ts            # All Tauri invoke() wrappers
│   │   └── format.ts           # Currency/date formatting
│   ├── pages/                  # One file per route
│   │   ├── WelcomePage.tsx     # Open/create engagement
│   │   ├── TrialBalancePage.tsx
│   │   ├── AjePage.tsx         # AJE / RJE / TJE entry
│   │   ├── LeadsheetPage.tsx
│   │   ├── MappingPage.tsx     # Map numbers & groupings
│   │   ├── ReportsPage.tsx     # HTML financial statements
│   │   ├── AuditPage.tsx       # Immutable audit trail
│   │   └── SettingsPage.tsx    # User prefs, lock, export
│   ├── store/
│   │   └── atoms.ts            # Jotai atomic state
│   ├── types/
│   │   └── index.ts            # TypeScript types (mirrors Rust models)
│   └── workers/
│       ├── tbParser.worker.ts      # CSV parsing off main thread
│       └── reportRenderer.worker.ts # HTML generation off main thread
│
├── src-tauri/                  # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs             # Entry point
│   │   ├── lib.rs              # App setup, command registration
│   │   ├── db.rs               # SQLite connection, WAL config, migrations
│   │   ├── models.rs           # Serde-serializable domain types
│   │   ├── error.rs            # AppError type (IPC-safe)
│   │   └── commands/           # One module per feature area
│   │       ├── engagement.rs   # Open/create/close engagement
│   │       ├── trial_balance.rs
│   │       ├── aje.rs
│   │       ├── mapping.rs
│   │       ├── leadsheet.rs
│   │       ├── signoff.rs
│   │       ├── reports.rs
│   │       ├── archive.rs      # .wwp encrypt/decrypt
│   │       ├── rollforward.rs
│   │       └── settings.rs
│   └── migrations/
│       └── 001_initial.sql     # Full schema with indexes
│
└── sample-data/
    └── sample_trial_balance.csv  # 56-account sample TB to test import
```

---

## Key Architectural Decisions

### Performance

| Concern | Solution |
|---------|----------|
| SQLite concurrency | WAL mode (`PRAGMA journal_mode=WAL`) |
| Heavy imports | Single `BEGIN TRANSACTION` wraps all rows |
| Large TB grids | `react-window` virtual scrolling |
| CSV parsing | Web Worker — never blocks the UI thread |
| Report generation | Web Worker — HTML assembled off main thread |
| Mapping / roll-forward computation | Rayon thread pool on the Rust side |
| State updates | Jotai atoms — only affected components re-render |

### Engagement Files

Each engagement is a **self-contained `.db` SQLite file**. You can save it anywhere. The app has no opinion about directory structure — open any `.db` file to load that engagement.

For sharing, use **Settings → Export as .wwp** which compresses and AES-256-GCM encrypts the entire engagement directory.

### Year-End Roll-Forward

**Settings → Year-End Roll-Forward** creates a brand-new `.db` file. The source file is never modified. Balance sheet ending balances (post-AJE) become the new prior-year figures. P&L accounts are zeroed. All map numbers, groupings, and leadsheet notes carry over.

### Engagement Locking

**Settings → Lock Engagement** sets a cryptographic SHA-256 seal hash. The Rust layer checks `is_locked` before any write operation and returns `AppError::EngagementLocked` if set. The seal hash is stored in the DB and can be used to verify integrity.

---

## User Authentication

For Phase 1 (local desktop), authentication is simplified:
- Default user: `Test User` / initials `TU`
- Change your name/initials in **Settings** — this is used for AJE attribution, sign-offs, and the audit trail
- No password required for local use
- `.wwp` export uses a user-supplied password for encryption

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` / `Cmd+K` | Open command palette |
| `↑` / `↓` in palette | Navigate results |
| `Enter` | Execute selected command |
| `Escape` | Close command palette |

---

## Development Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | **In Progress** | Local foundation — Tauri/SQLite, TB import, AJE entry, leadsheets |
| 2 | Planned | Reporting engine — HTML/CSS financial statements, PDF export |
| 3 | Planned | Audit mechanics — tickmarks, cross-referencing, multi-level sign-offs |
| 4 | Planned | Server & sync — Docker backend, delta-sync, conflict resolution |
| 5 | Planned | AI integration hooks — API endpoints for LLM-drafted notes |

---

## Contributing

This project targets accounting firm practitioners. Domain accuracy (debits = credits, roll-forward mechanics, audit trail immutability) takes precedence over feature velocity.

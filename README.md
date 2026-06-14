# Worked Papers

A desktop application for accounting working papers. Built as a replacement for tools like CaseWare Working Papers — faster, self-contained, and without a server or cloud account requirement.

Each engagement is a single `.db` file that lives wherever the user wants it. No sync, no subscription, no external dependencies at runtime.

Contact me on LinkedIn if you want help setting this up, always happy to meet other professionals! (https://www.linkedin.com/in/sean-mu) 

---

## Screenshots

**Trial balance with prior year, AJEs, and account mapping**

![Trial balance](screenshots/Screenshot%202026-06-13%20172605.png)

**Rendered balance sheet from the document engine**

![Balance sheet document](screenshots/Screenshot%202026-06-13%20173757.png)

**Tag picker for the HTML document editor**

![Tag picker](screenshots/Screenshot%202026-06-13%20172049.png)

---

## Stack

- **Frontend:** React 18, TypeScript, Vite, Jotai
- **Backend:** Tauri 1.x (Rust), rusqlite (bundled SQLite), rayon
- **Encryption:** AES-256-GCM for `.wwp` archive files, SHA-256 engagement seal
- **Database:** One SQLite file per engagement, WAL mode

---

## Features

- Trial balance import via CSV, with prior year, preliminary, AJEs, RJEs, and final columns
- Adjusting journal entries with audit trail and void support
- Account mapping to a financial statement line hierarchy with parent/child codes
- Grouping and leadsheet system for supporting working papers
- Programmable financial statement engine — build balance sheets, income statements, and other statements from map code expressions with prior-year columns
- HTML document templates with a tag system for pulling in live financial data, note references, images, and embedded statements
- Document packages for assembling multi-page financial statement packages in sequence
- PDF export via WebView2's native PrintToPdf — no browser headers or footers
- Virtual file cabinet with folders, file attachments, leadsheet links, and document links
- Sign-offs at any scope with preparer and reviewer roles
- Engagement locking with a SHA-256 integrity seal and post-lock tamper detection
- Roll-forward to a new engagement year without touching the source file
- `.wwp` archive export and import with AES-256-GCM encryption

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org |
| Rust + Cargo | 1.77+ | https://rustup.rs |

Windows also requires Visual Studio C++ Build Tools and WebView2 (pre-installed on Windows 11). See https://tauri.app/v1/guides/getting-started/prerequisites.

---

## Getting Started

```bash
npm install
npm run tauri dev
```

Build for production:

```bash
npm run tauri build
```

---

## Engagement files

Each engagement is a `.db` file. Opening one loads it into the app. The roll-forward command creates a new `.db` for the next year without modifying the source. The `.wwp` export bundles the engagement into an encrypted archive for transfer or archival.

---

## Data integrity and locking

Locking an engagement does two things. First, it sets a flag in the database that every write command checks before executing — the application will refuse any modification attempt. Second, it computes a SHA-256 hash over all material financial data at the moment of locking: trial balance accounts and balances, adjusting journal entry headers and lines, account map codes, and the engagement header. This hash is stored in the database alongside who locked it and when.

The hash covers the actual row data, not just metadata, so any post-lock modification to the underlying `.db` file — whether through the app or a SQLite editor — will produce a different hash. The "Verify Integrity Seal" button in Settings recomputes the hash from the current database state and compares it against the stored value. A mismatch means the file has been altered after signing off.

This is application-level enforcement backed by a content hash. It is not a replacement for chain of custody controls on the file itself. If the source file needs to be treated as a legal record, store it somewhere with access controls (a locked network share, a document management system, etc.) after locking.

---

## Project structure

```
WorkedPapers/
├── src/                        # React frontend
│   ├── components/ui/          # Shared UI components
│   ├── lib/
│   │   ├── tauri.ts            # All Tauri invoke() wrappers
│   │   └── format.ts           # Currency and date formatting
│   ├── pages/                  # One file per route
│   ├── store/atoms.ts          # Jotai global state
│   └── types/index.ts          # TypeScript types
│
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── commands/           # One module per feature area
│   │   ├── db.rs               # SQLite connection, WAL, migrations
│   │   ├── models.rs           # Serde domain types
│   │   └── error.rs            # AppError (IPC-safe)
│   └── migrations/             # SQL migration files
│
└── doc-templates/              # Default HTML document templates
```

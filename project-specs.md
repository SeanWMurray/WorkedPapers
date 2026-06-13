# Technical Specification & Development Roadmap: Next-Gen Working Papers Application

## 1. Project Overview & Objective
**Objective:** Develop a lightning-fast, highly efficient desktop and self-hosted server application for accounting firms, serving as a modern alternative to legacy systems like Caseware Working Papers and SmartSync.
**Core Philosophy:** Prioritize absolute speed, programmatic flexibility, and a strictly minimalist, flat user interface to reduce cognitive load. The system must eliminate legacy bloat while retaining rigorous accounting compliance mechanics.

## 2. Proposed Tech Stack Architecture
*(AI Model: Please validate and adapt these recommendations based on optimal performance)*
* **Desktop Client:** Tauri (Rust backend for near-native file system speed) + React or Vue (TypeScript) for the frontend.
* **Local Data Store:** SQLite (highly portable, single-file capability, excellent for local desktop client data).
* **Self-Hosted Server:** Dockerized Go or Node.js environment (for ease of deployment on firm hardware) with PostgreSQL.
* **Reporting Engine:** Headless browser rendering (Puppeteer/Playwright) or a dedicated HTML/PDF rendering engine.

## 3. Core Feature Requirements

### 3.1. Native File Management & Archiving
* **Direct Directory Mirroring:** All engagement files must physically reside on the local disk in the designated directory. The app's file manager is a fast UI layered over the actual OS file system, not a database of links (unless explicitly specified as a shortcut).
* **Single-File Compression & Sharing:** Implement a robust backup/export utility that compresses the entire engagement directory (database + attachments) into a single, proprietary, encrypted file extension for easy offline sharing between staff.

### 3.2. Trial Balance, Mapping, & AJEs
* **TB Import & Management:** Fast CSV/Excel ingestion mapping source accounts to the internal structure.
* **Mapping & Groupings:** A flexible, hierarchical structure. Users can assign account numbers to standard map numbers, and concurrently assign them to custom groupings (functioning as parallel mapping structures).
* **Adjusting Journal Entries (AJEs):** A dedicated, high-speed ledger for proposing and posting Adjusting, Reclassifying, and Tax entries. These entries must dynamically and instantly flow into the mapped trial balance and all downstream reports.

### 3.3. Year-End Roll-Forward & Data Retention
* **Historical Storage:** The system must seamlessly support up to 5 years of historical data within an entity's ecosystem.
* **File Separation:** The year-end close process must generate a **brand new, distinct file/directory** for the upcoming year. The prior year's file must remain completely unchanged and safely archived.
* **Roll-Forward Mechanics:** The system must automatically shift ending balances to prior-year balances, clear current-year P&L accounts, and retain all established mapping, groupings, and persistent leadsheets.

### 3.4. Programmatic Financial Statements & Reporting
* **HTML/CSS Foundation:** Diverging from rigid legacy text editors, custom financial statements and reports will be rendered using HTML/CSS. This allows for deep programmatic editing and AI interaction.
* **Dynamic Linking:** The reporting engine must seamlessly pull map number totals, current/prior year balances, custom variables, and entity metadata directly from the SQLite database into the DOM.
* **Automated Note Referencing:** Custom processing logic to automatically link and re-number Financial Statement notes to their corresponding balances.
* **Export:** High-fidelity HTML-to-PDF rendering for final print.

### 3.5. Audit Mechanics & Workflow
* **Leadsheets & Documents:** Customizable views displaying specific groupings, mapped accounts, and their underlying AJEs.
* **Tickmarks & Cross-Referencing:** A fast visual system to drop standard/custom tickmarks. Crucially, a deep-linking architecture that allows a user to click a balance on the financial statement and instantly jump back to the supporting leadsheet or source PDF.
* **Role-Based Sign-offs & Lockdown:** Implement multi-level sign-offs (Prepared, Reviewed, Partner). Engaging a final lockdown state on a file must cryptographically seal it, preventing further edits without authorized logging.
* **Immutable Audit Trail:** Background logging of all critical actions (file additions, AJE postings, map changes, sign-offs) with user IDs and timestamps.

### 3.6. Server & Version Management (Sync)
* **Self-Hosted Architecture:** Provide a streamlined Docker-compose package for accounting firm IT departments to deploy on their own local servers.
* **Smart Syncing:** A conflict-resolution engine that manages delta-syncs between the local Tauri client and the self-hosted server, ensuring offline work is seamlessly merged when reconnected.

## 4. UI/UX Design Directives
**Mandate for AI Developer:** The interface must strictly adhere to a modern, minimalist design paradigm.
* **Visual Style:** Flat, simple, heavily bordered data grids. Avoid drop shadows, excessive gradients, or visual clutter. Utilize a predominantly black, white, and high-contrast monochrome palette to keep the focus entirely on the data.
* **Navigation:** Keyboard-first design. Implement command palettes (e.g., `Cmd+K`) to jump between leadsheets, post AJEs, or open settings instantly without using the mouse.
* **Information Density:** High utility, low distraction.

## 5. Performance & Optimization Architecture
**Mandate for AI Developer:** Speed is the primary differentiator of this product. The following architectural patterns MUST be implemented to ensure instant data rendering and zero UI blocking.

### 5.1. Database Optimization (SQLite)
* **WAL Mode:** Enable Write-Ahead Logging (`PRAGMA journal_mode=WAL;`) on the local SQLite databases to allow concurrent reads and writes, preventing UI freezes during background saves.
* **Transaction Batching:** All Trial Balance imports, AJE mass-postings, and Roll-Forward mechanics MUST be wrapped in single transactions (`BEGIN TRANSACTION; ... COMMIT;`).
* **Prepared Statements:** Cache prepared statements for frequently used queries, particularly for fetching dynamically linked variables in financial statements.

### 5.2. Backend Threading (Rust / Tauri Engine)
* **Offload Heavy Computation:** The JavaScript frontend must NEVER block on data processing. Heavy tasks—such as mapping logic computations, rolling forward databases, and parsing massive CSV files—must be executed on background Rust threads.
* **Zero-Copy Serialization:** Utilize efficient data passing (e.g., `serde` in Rust) to hand off large data sets to the frontend without heavy memory duplication.

### 5.3. Frontend Rendering Efficiency (React/Vue)
* **DOM Virtualization:** Trial balances, leadsheets, and AJE lists often contain thousands of rows. The UI must utilize virtual scrolling (e.g., `react-window` or `vue-virtual-scroller`) to only render the DOM nodes visible on the screen.
* **Strict DOM Minimalism:** Align the HTML structure with the flat, simple, bordered visual identity. Avoid deeply nested `div` structures; fewer DOM nodes result in faster repaint and reflow times when grouping variables change.
* **Atomic State Management:** Use lightweight, atomic state management (like Jotai, Zustand, or Vue Composition API) to prevent global re-renders when a single cell in a leadsheet is updated.

### 5.4. Network & Sync Performance
* **Delta-Syncing:** The SmartSync alternative must not push the entire SQLite database to the server. It must compute diffs/deltas locally and only push modified records or file binaries to the PostgreSQL server.
* **Web Workers for Reports:** When generating the HTML/CSS for custom financial statements, process the data linking and DOM string generation in a Web Worker to keep the main application thread smooth and responsive.

## 6. Development Roadmap

* **Phase 1: Local Foundation (MVP)**
    * Setup Tauri/SQLite architecture with WAL mode and background threading.
    * Build native file manager syncing.
    * Implement basic TB import, mapping logic, and manual AJE entry.
* **Phase 2: The Reporting Engine**
    * Develop the HTML/CSS dynamic rendering system using Web Workers.
    * Build the tagging/linking system for mapping numbers to report variables.
    * PDF export functionality.
* **Phase 3: Audit Mechanics & Roll-Forward**
    * Implement tickmarks, cross-referencing, and multi-level sign-offs.
    * Build the Year-End Roll-Forward logic (ensuring the new-file separation mandate) in Rust to guarantee sub-second execution.
* **Phase 4: Server & Sync Integration**
    * Develop the self-hosted Docker backend.
    * Implement delta-syncing and conflict resolution between desktop clients and the server.
* **Phase 5: Refinement & AI Integration Hooks**
    * Finalize keyboard shortcuts, UI polish (flat/minimalist pass).
    * Expose endpoints/API structures within the app for future AI agents to read TB data and auto-draft HTML statement notes.

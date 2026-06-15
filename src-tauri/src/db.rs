use crate::error::{AppError, Result};
use rusqlite::{Connection, params};

pub struct AppDb {
    pub conn: Connection,
    pub path: String,
}

impl AppDb {
    /// Open (or create) an engagement SQLite database.
    /// Applies WAL mode and runs all migrations immediately.
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;

        // Performance pragmas — applied before any schema work
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             PRAGMA cache_size=-32000;   -- 32 MB page cache
             PRAGMA temp_store=MEMORY;",
        )?;

        let mut db = Self {
            conn,
            path: path.to_string(),
        };

        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> Result<()> {
        // Schema version table bootstraps the migration chain
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (
                version  INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )?;

        let version: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if version < 1 {
            self.conn.execute_batch(include_str!("../migrations/001_initial.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])?;
        }

        if version < 2 {
            self.conn.execute_batch(include_str!("../migrations/002_drop_account_type.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (2)", [])?;
        }

        if version < 3 {
            self.conn.execute_batch(include_str!("../migrations/003_file_cabinet.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (3)", [])?;
        }

        if version < 4 {
            self.conn.execute_batch(include_str!("../migrations/004_report_engine.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (4)", [])?;
        }

        if version < 5 {
            self.conn.execute_batch(include_str!("../migrations/005_document_templates.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (5)", [])?;
        }

        if version < 6 {
            self.conn.execute_batch(include_str!("../migrations/006_map_enhancements.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (6)", [])?;
        }

        if version < 7 {
            self.conn.execute_batch(include_str!("../migrations/007_signoff_initials.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (7)", [])?;
        }

        if version < 8 {
            self.conn.execute_batch(include_str!("../migrations/008_document_links.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (8)", [])?;
        }

        if version < 9 {
            self.conn.execute_batch(include_str!("../migrations/009_lock_metadata.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (9)", [])?;
        }

        if version < 10 {
            self.conn.execute_batch(include_str!("../migrations/010_leadsheet_annotations.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (10)", [])?;
        }

        if version < 11 {
            self.conn.execute_batch(include_str!("../migrations/011_annotation_scope_index.sql"))?;
            self.conn.execute("INSERT INTO schema_version (version) VALUES (11)", [])?;
        }

        Ok(())
    }

    /// Convenience: run a closure inside a single transaction.
    /// Heavy operations (TB import, roll-forward) must use this.
    pub fn transaction<F, T>(&mut self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let tx = self.conn.transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    /// Guard for write commands: returns `EngagementLocked` if the engagement
    /// has been sealed. Call this as the first line of every mutating command —
    /// it is the single source of truth for lock enforcement.
    pub fn ensure_unlocked(&self) -> Result<()> {
        let locked: i64 = self
            .conn
            .query_row("SELECT is_locked FROM engagement LIMIT 1", [], |r| r.get(0))?;
        if locked != 0 {
            return Err(AppError::EngagementLocked);
        }
        Ok(())
    }

    /// Append a row to the immutable audit trail.
    pub fn audit(
        conn: &Connection,
        action: &str,
        entity: &str,
        entity_id: &str,
        performed_by: &str,
        detail: &serde_json::Value,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO audit_trail (action, entity, entity_id, performed_by, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                action,
                entity,
                entity_id,
                performed_by,
                serde_json::to_string(detail)?
            ],
        )?;
        Ok(())
    }
}

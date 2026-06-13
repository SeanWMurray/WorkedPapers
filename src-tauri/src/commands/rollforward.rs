use crate::db::AppDb;
use crate::error::{AppError, Result};
use crate::AppState;
use rusqlite::params;
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct RollForwardPayload {
    /// Full path where the NEW year's .db file should be created
    pub new_db_path: String,
    pub new_year_end: String,   // "YYYY-MM-DD"
    pub new_fiscal_year: i32,
}

/// Year-end roll-forward — runs entirely on Rust background thread via rayon.
///
/// Rules enforced:
///   1. The SOURCE engagement is NOT modified.
///   2. A brand-new .db is created at `new_db_path`.
///   3. Ending balances become prior-year balances in the new file.
///   4. Revenue & Expense (P&L) accounts are zeroed in the new file.
///   5. All map numbers, groupings, and persistent leadsheet notes carry over.
///   6. AJEs do NOT carry over (they belong to the closed year).
#[tauri::command]
pub async fn roll_forward(
    payload: RollForwardPayload,
    state: State<'_, AppState>,
) -> std::result::Result<String, AppError> {
    // Snapshot everything we need from the open DB before releasing the lock
    let (source_path, entity_name, currency, _fiscal_year) = {
        let guard = state.db.lock().unwrap();
        let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

        let (entity_name, currency, fiscal_year): (String, String, i32) = db.conn.query_row(
            "SELECT entity_name, currency, fiscal_year FROM engagement LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;

        (db.path.clone(), entity_name, currency, fiscal_year)
    };

    let new_db_path = payload.new_db_path.clone();

    // Run the heavy copy work on a rayon thread so the UI stays responsive
    rayon::scope(|_| -> Result<()> {
        // Open source for reading
        let src = AppDb::open(&source_path)?;

        // Create the new year's DB
        let mut dst = AppDb::open(&new_db_path)?;

        dst.transaction(|conn| {
            use uuid::Uuid;

            // New engagement row
            let new_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO engagement (id, entity_name, year_end, fiscal_year, currency)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    new_id,
                    entity_name,
                    payload.new_year_end,
                    payload.new_fiscal_year,
                    currency,
                ],
            )?;

            // Copy map numbers
            {
                let mut stmt = src.conn.prepare(
                    "SELECT code, label, parent_code, sort_order, fs_line FROM map_numbers",
                )?;
                let maps: Vec<(String, String, Option<String>, i32, Option<String>)> = stmt
                    .query_map([], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                    })?
                    .collect::<std::result::Result<_, _>>()?;

                for (code, label, parent, sort, fs) in maps {
                    conn.execute(
                        "INSERT INTO map_numbers (code, label, parent_code, sort_order, fs_line)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![code, label, parent, sort, fs],
                    )?;
                }
            }

            // Copy groupings
            {
                let mut stmt = src.conn.prepare(
                    "SELECT id, name, description, color FROM groupings",
                )?;
                let groups: Vec<(i64, String, Option<String>, Option<String>)> = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                    .collect::<std::result::Result<_, _>>()?;

                for (id, name, desc, color) in groups {
                    conn.execute(
                        "INSERT INTO groupings (id, name, description, color) VALUES (?1, ?2, ?3, ?4)",
                        params![id, name, desc, color],
                    )?;
                }
            }

            // Roll forward: ending balance (post-AJE) becomes prior year; current resets to 0
            {
                let mut stmt = src.conn.prepare(
                    "SELECT
                         a.account_number,
                         a.account_name,
                         a.map_number,
                         a.notes,
                         a.current_balance + COALESCE((
                             SELECT SUM(l.debit - l.credit)
                             FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                             WHERE l.account_number = a.account_number AND j.is_voided = 0
                         ), 0.0) AS ending_balance
                     FROM tb_accounts a",
                )?;

                let accounts: Vec<(String, String, Option<String>, Option<String>, f64)> =
                    stmt.query_map([], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                    })?
                    .collect::<std::result::Result<_, _>>()?;

                for (num, name, map, notes, ending) in accounts {
                    conn.execute(
                        "INSERT INTO tb_accounts
                             (account_number, account_name, map_number, notes,
                              current_balance, prior_balance)
                         VALUES (?1, ?2, ?3, ?4, 0.0, ?5)",
                        params![num, name, map, notes, ending],
                    )?;
                }
            }

            // Copy persistent leadsheet notes
            {
                let mut stmt = src.conn.prepare(
                    "SELECT scope, content, updated_by FROM leadsheet_notes",
                )?;
                let notes: Vec<(String, String, String)> = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<std::result::Result<_, _>>()?;

                for (scope, content, updated_by) in notes {
                    conn.execute(
                        "INSERT INTO leadsheet_notes (scope, content, updated_by) VALUES (?1, ?2, ?3)",
                        params![scope, content, updated_by],
                    )?;
                }
            }

            // Copy custom vars
            {
                let mut stmt = src.conn.prepare("SELECT key, value, description FROM custom_vars")?;
                let vars: Vec<(String, String, Option<String>)> = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<std::result::Result<_, _>>()?;
                for (key, val, desc) in vars {
                    conn.execute(
                        "INSERT INTO custom_vars (key, value, description) VALUES (?1, ?2, ?3)",
                        params![key, val, desc],
                    )?;
                }
            }

            AppDb::audit(
                conn,
                "ROLL_FORWARD",
                "engagement",
                "global",
                "system",
                &serde_json::json!({
                    "source": source_path,
                    "new_year_end": payload.new_year_end,
                }),
            )?;

            Ok(())
        })
    })?;

    Ok(new_db_path)
}

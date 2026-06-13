use crate::db::AppDb;
use crate::error::{AppError, Result};
use crate::models::{TbAccount, TbSummary};
use crate::AppState;
use rusqlite::params;
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct CsvRow {
    pub account_number: String,
    pub account_name: String,
    pub current_balance: f64,
    pub prior_balance: f64,
}

#[tauri::command]
pub async fn import_tb_csv(
    rows: Vec<CsvRow>,
    state: State<'_, AppState>,
) -> std::result::Result<usize, AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    let count = rows.len();

    db.transaction(|conn| {
        conn.execute("DELETE FROM tb_accounts", [])?;

        let mut stmt = conn.prepare(
            "INSERT INTO tb_accounts (account_number, account_name, current_balance, prior_balance)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(account_number) DO UPDATE SET
               account_name    = excluded.account_name,
               current_balance = excluded.current_balance,
               prior_balance   = excluded.prior_balance",
        )?;

        for row in &rows {
            stmt.execute(params![
                &row.account_number,
                &row.account_name,
                row.current_balance,
                row.prior_balance,
            ])?;
        }

        AppDb::audit(
            conn,
            "IMPORT_TB",
            "tb_accounts",
            "batch",
            "system",
            &serde_json::json!({ "row_count": count }),
        )?;

        Ok(count)
    })
}

#[tauri::command]
pub async fn get_tb_accounts(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<TbAccount>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare(
        "SELECT
             a.id,
             a.account_number,
             a.account_name,
             a.current_balance,
             a.prior_balance,
             a.map_number,
             a.notes,
             COALESCE(SUM(l.debit - l.credit), 0.0) AS aje_net
         FROM tb_accounts a
         LEFT JOIN aje_lines l ON l.account_number = a.account_number
         LEFT JOIN ajes j      ON j.id = l.aje_id AND j.is_voided = 0
         GROUP BY a.id
         ORDER BY a.account_number",
    )?;

    let accounts = stmt
        .query_map([], |row| {
            let aje_net: f64 = row.get(7)?;
            Ok(TbAccount {
                id: row.get(0)?,
                account_number: row.get(1)?,
                account_name: row.get(2)?,
                current_balance: row.get::<_, f64>(3)? + aje_net,
                prior_balance: row.get(4)?,
                map_number: row.get(5)?,
                grouping_ids: vec![],
                notes: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(accounts)
}

#[tauri::command]
pub async fn update_account_mapping(
    account_number: String,
    map_number: Option<String>,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    db.conn.execute(
        "UPDATE tb_accounts SET map_number = ?1 WHERE account_number = ?2",
        params![map_number, account_number],
    )?;

    Ok(())
}

#[tauri::command]
pub async fn get_tb_summary(
    state: State<'_, AppState>,
) -> std::result::Result<TbSummary, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare(
        "SELECT
             COALESCE(SUM(CASE WHEN current_balance > 0 THEN current_balance ELSE 0 END), 0.0),
             COALESCE(SUM(CASE WHEN current_balance < 0 THEN current_balance ELSE 0 END), 0.0)
         FROM tb_accounts",
    )?;

    let (total_debits, total_credits): (f64, f64) = stmt.query_row([], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;

    Ok(TbSummary {
        total_debits,
        total_credits,
        is_balanced: (total_debits + total_credits).abs() < 0.005,
    })
}

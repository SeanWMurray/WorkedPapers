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
    db.ensure_unlocked()?;

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
             a.current_balance AS prelim,
             a.prior_balance,
             a.map_number,
             a.notes,
             COALESCE(SUM(CASE WHEN j.entry_type = 'ADJUSTING'     THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS adj_net,
             COALESCE(SUM(CASE WHEN j.entry_type = 'RECLASSIFYING' THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS rcl_net,
             COALESCE(SUM(CASE WHEN j.entry_type = 'TAX'           THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS tax_net
         FROM tb_accounts a
         LEFT JOIN (
             SELECT l.account_number, l.debit, l.credit, j.entry_type
             FROM aje_lines l
             JOIN ajes j ON j.id = l.aje_id AND j.is_voided = 0
         ) j ON j.account_number = a.account_number
         GROUP BY a.id
         ORDER BY a.account_number",
    )?;

    let accounts = stmt
        .query_map([], |row| {
            let prelim: f64     = row.get(3)?;
            let adj_net: f64    = row.get(7)?;
            let rcl_net: f64    = row.get(8)?;
            let tax_net: f64    = row.get(9)?;
            let final_bal = prelim + adj_net + rcl_net + tax_net;
            Ok(TbAccount {
                id: row.get(0)?,
                account_number: row.get(1)?,
                account_name: row.get(2)?,
                prelim_balance: prelim,
                prior_balance: row.get(4)?,
                adjustment_net: adj_net,
                reclass_net: rcl_net,
                tax_net,
                current_balance: final_bal,
                map_number: row.get(5)?,
                grouping_ids: vec![],
                notes: row.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(accounts)
}

#[tauri::command]
pub async fn update_account_meta(
    old_account_number: String,
    account_number: String,
    account_name: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    db.conn.execute(
        "UPDATE tb_accounts SET account_number = ?1, account_name = ?2 WHERE account_number = ?3",
        params![account_number, account_name, old_account_number],
    )?;

    Ok(())
}

#[tauri::command]
pub async fn update_account_balance(
    account_number: String,
    prelim_balance: f64,
    prior_balance: f64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    db.conn.execute(
        "UPDATE tb_accounts SET current_balance = ?1, prior_balance = ?2 WHERE account_number = ?3",
        params![prelim_balance, prior_balance, account_number],
    )?;

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateAccountPayload {
    pub account_number: String,
    pub account_name: String,
    pub prelim_balance: f64,
    pub prior_balance: f64,
    pub map_number: Option<String>,
}

#[tauri::command]
pub async fn create_account(
    payload: CreateAccountPayload,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    db.conn.execute(
        "INSERT INTO tb_accounts (account_number, account_name, current_balance, prior_balance, map_number)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_number) DO UPDATE SET
           account_name    = excluded.account_name,
           current_balance = excluded.current_balance,
           prior_balance   = excluded.prior_balance,
           map_number      = COALESCE(excluded.map_number, tb_accounts.map_number)",
        params![
            payload.account_number,
            payload.account_name,
            payload.prelim_balance,
            payload.prior_balance,
            payload.map_number,
        ],
    )?;

    Ok(())
}

#[tauri::command]
pub async fn update_account_mapping(
    account_number: String,
    map_number: Option<String>,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    db.conn.execute(
        "UPDATE tb_accounts SET map_number = ?1 WHERE account_number = ?2",
        params![map_number, account_number],
    )?;

    // Auto-apply the map number's default grouping if one is set.
    if let Some(ref code) = map_number {
        let default_group: Option<i64> = db.conn
            .query_row(
                "SELECT default_grouping_id FROM map_numbers WHERE code=?1",
                params![code],
                |r| r.get(0),
            )
            .ok()
            .flatten();

        if let Some(gid) = default_group {
            let account_id: Option<i64> = db.conn
                .query_row(
                    "SELECT id FROM tb_accounts WHERE account_number=?1",
                    params![account_number],
                    |r| r.get(0),
                )
                .ok();

            if let Some(aid) = account_id {
                db.conn.execute(
                    "INSERT OR IGNORE INTO account_groupings (account_id, grouping_id) VALUES (?1, ?2)",
                    params![aid, gid],
                )?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_tb_summary(
    state: State<'_, AppState>,
) -> std::result::Result<TbSummary, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    // Sum using the final (AJE-adjusted) balance per account.
    let mut stmt = db.conn.prepare(
        "SELECT
             COALESCE(SUM(CASE WHEN final > 0 THEN final ELSE 0 END), 0.0),
             COALESCE(SUM(CASE WHEN final < 0 THEN final ELSE 0 END), 0.0)
         FROM (
             SELECT
                 a.current_balance
                 + COALESCE(SUM(CASE WHEN j.entry_type = 'ADJUSTING'     THEN j.debit - j.credit ELSE 0.0 END), 0.0)
                 + COALESCE(SUM(CASE WHEN j.entry_type = 'RECLASSIFYING' THEN j.debit - j.credit ELSE 0.0 END), 0.0)
                 + COALESCE(SUM(CASE WHEN j.entry_type = 'TAX'           THEN j.debit - j.credit ELSE 0.0 END), 0.0)
                 AS final
             FROM tb_accounts a
             LEFT JOIN (
                 SELECT l.account_number, l.debit, l.credit, j.entry_type
                 FROM aje_lines l
                 JOIN ajes j ON j.id = l.aje_id AND j.is_voided = 0
             ) j ON j.account_number = a.account_number
             GROUP BY a.id
         )",
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

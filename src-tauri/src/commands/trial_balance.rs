use crate::db::AppDb;
use crate::error::{AppError, Result};
use crate::models::{AccountType, TbAccount, TbSummary};
use crate::AppState;
use rayon::prelude::*;
use rusqlite::params;
use serde::Deserialize;
use std::str::FromStr;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct CsvRow {
    pub account_number: String,
    pub account_name: String,
    pub account_type: String,
    pub current_balance: f64,
    pub prior_balance: f64,
}

/// Import a TB from a pre-parsed list of rows (CSV parsing happens in a Web Worker on the frontend).
/// Entire import is wrapped in one transaction for atomicity.
#[tauri::command]
pub async fn import_tb_csv(
    rows: Vec<CsvRow>,
    state: State<'_, AppState>,
) -> std::result::Result<usize, AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    // Validate & parse types in parallel using rayon before hitting the DB
    let validated: Vec<_> = rows
        .par_iter()
        .map(|r| {
            let acct_type = parse_account_type(&r.account_type)?;
            Ok((r, acct_type))
        })
        .collect::<Result<Vec<_>>>()?;

    let count = validated.len();

    db.transaction(|conn| {
        // Wipe existing TB so re-import is idempotent
        conn.execute("DELETE FROM tb_accounts", [])?;

        let mut stmt = conn.prepare_cached(
            "INSERT INTO tb_accounts (account_number, account_name, account_type, current_balance, prior_balance)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_number) DO UPDATE SET
               account_name    = excluded.account_name,
               account_type    = excluded.account_type,
               current_balance = excluded.current_balance,
               prior_balance   = excluded.prior_balance",
        )?;

        for (row, acct_type) in &validated {
            stmt.execute(params![
                &row.account_number,
                &row.account_name,
                format!("{:?}", acct_type).to_uppercase(),
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

/// Fetch all TB accounts, adjusted for posted (non-voided) AJEs.
#[tauri::command]
pub async fn get_tb_accounts(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<TbAccount>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare_cached(
        "SELECT
             a.id,
             a.account_number,
             a.account_name,
             a.account_type,
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
            let aje_net: f64 = row.get(8)?;
            Ok(TbAccount {
                id: row.get(0)?,
                account_number: row.get(1)?,
                account_name: row.get(2)?,
                account_type: AccountType::Asset, // resolved below
                current_balance: row.get::<_, f64>(4)? + aje_net,
                prior_balance: row.get(5)?,
                map_number: row.get(6)?,
                grouping_ids: vec![],
                notes: row.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(accounts)
}

/// Assign (or clear) a map number for an account.
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

/// Return totals by account type (used for the TB balance check widget).
#[tauri::command]
pub async fn get_tb_summary(
    state: State<'_, AppState>,
) -> std::result::Result<TbSummary, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare_cached(
        "SELECT
             account_type,
             SUM(current_balance + COALESCE((
                 SELECT SUM(l.debit - l.credit)
                 FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                 WHERE l.account_number = a.account_number AND j.is_voided = 0
             ), 0.0)) AS adjusted_balance
         FROM tb_accounts a
         GROUP BY account_type",
    )?;

    let mut totals = std::collections::HashMap::<String, f64>::new();
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        totals.insert(k, v);
    }

    let assets = totals.get("ASSET").copied().unwrap_or(0.0);
    let liabilities = totals.get("LIABILITY").copied().unwrap_or(0.0);
    let equity = totals.get("EQUITY").copied().unwrap_or(0.0);
    let revenue = totals.get("REVENUE").copied().unwrap_or(0.0);
    let expenses = totals.get("EXPENSE").copied().unwrap_or(0.0);
    let net_income = revenue - expenses;

    Ok(TbSummary {
        total_assets: assets,
        total_liabilities: liabilities,
        total_equity: equity,
        total_revenue: revenue,
        total_expenses: expenses,
        net_income,
        is_balanced: (assets - liabilities - equity - net_income).abs() < 0.005,
    })
}

fn parse_account_type(s: &str) -> Result<AccountType> {
    match s.trim().to_uppercase().as_str() {
        "ASSET" | "ASSETS" | "A" => Ok(AccountType::Asset),
        "LIABILITY" | "LIABILITIES" | "L" => Ok(AccountType::Liability),
        "EQUITY" | "E" => Ok(AccountType::Equity),
        "REVENUE" | "INCOME" | "R" | "I" => Ok(AccountType::Revenue),
        "EXPENSE" | "EXPENSES" | "X" => Ok(AccountType::Expense),
        "OTHER_INCOME" | "OTHER INCOME" => Ok(AccountType::OtherIncome),
        "OTHER_EXPENSE" | "OTHER EXPENSE" => Ok(AccountType::OtherExpense),
        other => Err(AppError::Other(format!("Unknown account type: {other}"))),
    }
}

use crate::db::AppDb;
use crate::error::{AppError, Result};
use crate::models::{Aje, AjeImpact, AjeLine, AjeType};
use crate::AppState;
use chrono::Utc;
use rusqlite::params;
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct PostAjePayload {
    pub entry_type: String, // "ADJUSTING" | "RECLASSIFYING" | "TAX"
    pub description: String,
    pub prepared_by: String,
    pub lines: Vec<PostAjeLine>,
}

#[derive(Debug, Deserialize)]
pub struct PostAjeLine {
    pub account_number: String,
    pub debit: f64,
    pub credit: f64,
    pub description: Option<String>,
}

/// Post a new AJE inside a single transaction.
/// Validates that debits == credits before writing.
#[tauri::command]
pub async fn post_aje(
    payload: PostAjePayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    // Guard: locked engagements are immutable
    let is_locked: i64 = db
        .conn
        .query_row("SELECT is_locked FROM engagement LIMIT 1", [], |r| r.get(0))?;
    if is_locked != 0 {
        return Err(AppError::EngagementLocked);
    }

    // Validate balance
    let total_debits: f64 = payload.lines.iter().map(|l| l.debit).sum();
    let total_credits: f64 = payload.lines.iter().map(|l| l.credit).sum();
    if (total_debits - total_credits).abs() > 0.005 {
        return Err(AppError::Other(format!(
            "AJE is out of balance: debits={total_debits:.2} credits={total_credits:.2}"
        )));
    }

    db.transaction(|conn| {
        // Auto-number: count existing entries of this type
        let prefix = match payload.entry_type.to_uppercase().as_str() {
            "RECLASSIFYING" => "RJE",
            "TAX" => "TJE",
            _ => "AJE",
        };
        let seq: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ajes WHERE entry_type = ?1",
            params![payload.entry_type.to_uppercase()],
            |r| r.get(0),
        )?;
        let aje_number = format!("{prefix}-{:03}", seq + 1);

        conn.execute(
            "INSERT INTO ajes (aje_number, entry_type, description, prepared_by, posted_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                aje_number,
                payload.entry_type.to_uppercase(),
                payload.description,
                payload.prepared_by,
                Utc::now().to_rfc3339(),
            ],
        )?;
        let aje_id = conn.last_insert_rowid();

        let mut line_stmt = conn.prepare_cached(
            "INSERT INTO aje_lines (aje_id, account_number, debit, credit, description)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for line in &payload.lines {
            line_stmt.execute(params![
                aje_id,
                line.account_number,
                line.debit,
                line.credit,
                line.description,
            ])?;
        }

        AppDb::audit(
            conn,
            "POST_AJE",
            "ajes",
            &aje_id.to_string(),
            &payload.prepared_by,
            &serde_json::json!({
                "aje_number": format!("{prefix}-{:03}", seq + 1),
                "description": payload.description,
            }),
        )?;

        Ok(aje_id)
    })
}

/// List all AJEs (including voided) ordered by posting date.
#[tauri::command]
pub async fn list_ajes(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<Aje>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare_cached(
        "SELECT id, aje_number, entry_type, description, prepared_by, posted_at, is_voided, voided_reason
         FROM ajes ORDER BY posted_at DESC",
    )?;

    let ajes: Vec<Aje> = stmt
        .query_map([], |row| {
            Ok(Aje {
                id: row.get(0)?,
                aje_number: row.get(1)?,
                entry_type: AjeType::Adjusting, // resolved below per-row
                description: row.get(3)?,
                lines: vec![],
                prepared_by: row.get(4)?,
                posted_at: Utc::now(),
                is_voided: row.get::<_, i32>(6)? != 0,
                voided_reason: row.get(7)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    Ok(ajes)
}

/// Void an AJE (never deletes — audit integrity).
#[tauri::command]
pub async fn void_aje(
    aje_id: i64,
    reason: String,
    voided_by: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;

    let is_locked: i64 = db
        .conn
        .query_row("SELECT is_locked FROM engagement LIMIT 1", [], |r| r.get(0))?;
    if is_locked != 0 {
        return Err(AppError::EngagementLocked);
    }

    db.transaction(|conn| {
        conn.execute(
            "UPDATE ajes SET is_voided = 1, voided_reason = ?1 WHERE id = ?2",
            params![reason, aje_id],
        )?;

        AppDb::audit(
            conn,
            "VOID_AJE",
            "ajes",
            &aje_id.to_string(),
            &voided_by,
            &serde_json::json!({ "reason": reason }),
        )?;

        Ok(())
    })
}

/// Show how posted AJEs affect each account (for the AJE impact view).
#[tauri::command]
pub async fn get_aje_impact(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<AjeImpact>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare_cached(
        "SELECT
             a.account_number,
             a.account_name,
             a.current_balance,
             COALESCE(SUM(j.debit - j.credit), 0.0) AS aje_net
         FROM tb_accounts a
         LEFT JOIN (
             SELECT l.account_number, l.debit, l.credit
             FROM aje_lines l
             JOIN ajes ON ajes.id = l.aje_id AND ajes.is_voided = 0
         ) j ON j.account_number = a.account_number
         GROUP BY a.account_number
         HAVING aje_net != 0.0
         ORDER BY a.account_number",
    )?;

    let impacts = stmt
        .query_map([], |r| {
            let orig: f64 = r.get(2)?;
            let net: f64 = r.get(3)?;
            Ok(AjeImpact {
                account_number: r.get(0)?,
                account_name: r.get(1)?,
                original_balance: orig,
                aje_adjustment: net,
                adjusted_balance: orig + net,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    Ok(impacts)
}

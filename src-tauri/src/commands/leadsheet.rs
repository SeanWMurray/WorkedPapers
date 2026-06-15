use crate::error::{AppError, Result};
use crate::models::{Leadsheet, TbAccount, AjeLine};
use crate::AppState;
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct LeadsheetAnnotation {
    pub id: i64,
    pub account_number: String,
    pub scope: String,
    pub note: Option<String>,
    pub cabinet_item_id: Option<i64>,
    pub cabinet_item_name: Option<String>,
    pub updated_by: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct LeadsheetQuery {
    pub map_number: Option<String>,
    pub grouping_id: Option<i64>,
}

/// Fetch a leadsheet: accounts + AJE lines for a given map_number or grouping.
#[tauri::command]
pub async fn get_leadsheet(
    query: LeadsheetQuery,
    state: State<'_, AppState>,
) -> std::result::Result<Leadsheet, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<TbAccount> {
        let prelim: f64  = r.get(3)?;
        let adj: f64     = r.get(5)?;
        let rcl: f64     = r.get(6)?;
        let tax: f64     = r.get(7)?;
        Ok(TbAccount {
            id: r.get(0)?,
            account_number: r.get(1)?,
            account_name: r.get(2)?,
            prelim_balance: prelim,
            prior_balance: r.get(4)?,
            adjustment_net: adj,
            reclass_net: rcl,
            tax_net: tax,
            current_balance: prelim + adj + rcl + tax,
            map_number: r.get(8)?,
            grouping_ids: vec![],
            notes: r.get(9)?,
        })
    };

    // Resolve accounts in scope
    let accounts: Vec<TbAccount> = if let Some(ref map) = query.map_number {
        let mut stmt = db.conn.prepare(
            "SELECT a.id, a.account_number, a.account_name,
                    a.current_balance AS prelim,
                    a.prior_balance,
                    COALESCE(SUM(CASE WHEN j.entry_type = 'ADJUSTING'     THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS adj_net,
                    COALESCE(SUM(CASE WHEN j.entry_type = 'RECLASSIFYING' THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS rcl_net,
                    COALESCE(SUM(CASE WHEN j.entry_type = 'TAX'           THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS tax_net,
                    a.map_number, a.notes
             FROM tb_accounts a
             LEFT JOIN (
                 SELECT l.account_number, l.debit, l.credit, j.entry_type
                 FROM aje_lines l JOIN ajes j ON j.id = l.aje_id AND j.is_voided = 0
             ) j ON j.account_number = a.account_number
             WHERE a.map_number = ?1
             GROUP BY a.id
             ORDER BY a.account_number",
        )?;
        let rows = stmt.query_map(params![map], map_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    } else if let Some(gid) = query.grouping_id {
        let mut stmt = db.conn.prepare(
            "SELECT a.id, a.account_number, a.account_name,
                    a.current_balance AS prelim,
                    a.prior_balance,
                    COALESCE(SUM(CASE WHEN j.entry_type = 'ADJUSTING'     THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS adj_net,
                    COALESCE(SUM(CASE WHEN j.entry_type = 'RECLASSIFYING' THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS rcl_net,
                    COALESCE(SUM(CASE WHEN j.entry_type = 'TAX'           THEN j.debit - j.credit ELSE 0.0 END), 0.0) AS tax_net,
                    a.map_number, a.notes
             FROM tb_accounts a
             JOIN account_groupings ag ON ag.account_id = a.id
             LEFT JOIN (
                 SELECT l.account_number, l.debit, l.credit, j.entry_type
                 FROM aje_lines l JOIN ajes j ON j.id = l.aje_id AND j.is_voided = 0
             ) j ON j.account_number = a.account_number
             WHERE ag.grouping_id = ?1
             GROUP BY a.id
             ORDER BY a.account_number",
        )?;
        let rows = stmt.query_map(params![gid], map_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    } else {
        return Err(AppError::Other("Must supply map_number or grouping_id".into()));
    };

    // AJE lines affecting these accounts
    let account_numbers: Vec<String> = accounts.iter().map(|a| a.account_number.clone()).collect();
    let placeholders = account_numbers
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(",");

    let aje_lines: Vec<AjeLine> = if !account_numbers.is_empty() {
        let sql = format!(
            "SELECT l.id, l.aje_id, l.account_number, l.debit, l.credit, l.description
             FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
             WHERE j.is_voided = 0 AND l.account_number IN ({placeholders})
             ORDER BY l.aje_id"
        );
        let mut stmt = db.conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::ToSql> = account_numbers
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        let rows = stmt.query_map(params_ref.as_slice(), |r| {
            Ok(AjeLine {
                id: r.get(0)?,
                aje_id: r.get(1)?,
                account_number: r.get(2)?,
                debit: r.get(3)?,
                credit: r.get(4)?,
                description: r.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    } else {
        vec![]
    };

    // Notes
    let scope_key = query.map_number
        .as_ref()
        .map(|m| format!("map:{m}"))
        .or_else(|| query.grouping_id.map(|g| format!("group:{g}")))
        .unwrap_or_default();

    let notes: Option<String> = db.conn
        .query_row(
            "SELECT content FROM leadsheet_notes WHERE scope = ?1",
            params![scope_key],
            |r| r.get(0),
        )
        .ok();

    let title = query.map_number.unwrap_or_else(|| {
        format!("Group {}", query.grouping_id.unwrap_or_default())
    });

    Ok(Leadsheet {
        map_number: None,
        grouping_id: query.grouping_id,
        title,
        accounts,
        aje_lines,
        notes,
        tickmarks: vec![],
        signoffs: vec![],
    })
}

#[tauri::command]
pub async fn save_leadsheet_note(
    scope: String,
    content: String,
    updated_by: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let is_locked: i64 = db.conn.query_row("SELECT is_locked FROM engagement LIMIT 1", [], |r| r.get(0))?;
    if is_locked != 0 { return Err(AppError::EngagementLocked); }

    db.conn.execute(
        "INSERT INTO leadsheet_notes (scope, content, updated_by, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(scope) DO UPDATE SET
           content    = excluded.content,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at",
        params![scope, content, updated_by],
    )?;

    Ok(())
}

#[tauri::command]
pub async fn add_tickmark(
    symbol: String,
    description: String,
    anchor: String,
    created_by: String,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let is_locked: i64 = db.conn.query_row("SELECT is_locked FROM engagement LIMIT 1", [], |r| r.get(0))?;
    if is_locked != 0 { return Err(AppError::EngagementLocked); }

    db.conn.execute(
        "INSERT INTO tickmarks (symbol, description, anchor, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![symbol, description, anchor, created_by],
    )?;

    Ok(db.conn.last_insert_rowid())
}

#[tauri::command]
pub async fn remove_tickmark(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let is_locked: i64 = db.conn.query_row("SELECT is_locked FROM engagement LIMIT 1", [], |r| r.get(0))?;
    if is_locked != 0 { return Err(AppError::EngagementLocked); }

    db.conn.execute("DELETE FROM tickmarks WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub async fn get_annotations(
    scope: String,
    state: State<'_, AppState>,
) -> std::result::Result<Vec<LeadsheetAnnotation>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare(
        "SELECT a.id, a.account_number, a.scope, a.note, a.cabinet_item_id,
                ci.display_name, a.updated_by, a.updated_at
         FROM leadsheet_annotations a
         LEFT JOIN file_cabinet_items ci ON ci.id = a.cabinet_item_id
         WHERE a.scope = ?1",
    )?;
    let rows = stmt.query_map(params![scope], |r| {
        Ok(LeadsheetAnnotation {
            id: r.get(0)?,
            account_number: r.get(1)?,
            scope: r.get(2)?,
            note: r.get(3)?,
            cabinet_item_id: r.get(4)?,
            cabinet_item_name: r.get(5)?,
            updated_by: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?
    .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
pub struct UpsertAnnotationPayload {
    pub account_number: String,
    pub scope: String,
    pub note: Option<String>,
    pub cabinet_item_id: Option<i64>,
}

#[tauri::command]
pub async fn upsert_annotation(
    payload: UpsertAnnotationPayload,
    updated_by: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let is_locked: i64 = db.conn.query_row("SELECT is_locked FROM engagement LIMIT 1", [], |r| r.get(0))?;
    if is_locked != 0 { return Err(AppError::EngagementLocked); }

    let now = Utc::now().to_rfc3339();

    // If both note and cabinet_item_id are empty, delete the row entirely
    if payload.note.as_deref().map(|s| s.trim()).unwrap_or("").is_empty()
        && payload.cabinet_item_id.is_none()
    {
        db.conn.execute(
            "DELETE FROM leadsheet_annotations WHERE account_number = ?1 AND scope = ?2",
            params![payload.account_number, payload.scope],
        )?;
        return Ok(());
    }

    db.conn.execute(
        "INSERT INTO leadsheet_annotations (account_number, scope, note, cabinet_item_id, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_number, scope) DO UPDATE SET
             note            = excluded.note,
             cabinet_item_id = excluded.cabinet_item_id,
             updated_by      = excluded.updated_by,
             updated_at      = excluded.updated_at",
        params![payload.account_number, payload.scope, payload.note, payload.cabinet_item_id, updated_by, now],
    )?;
    Ok(())
}

use crate::error::{AppError, Result};
use crate::models::{Grouping, MapNumber};
use crate::AppState;
use rusqlite::params;
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct UpsertMapPayload {
    pub code: String,
    pub label: String,
    pub parent_code: Option<String>,
    pub sort_order: i32,
    pub fs_line: Option<String>,
    pub default_grouping_id: Option<i64>,
    pub flip_map_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertGroupingPayload {
    pub id: Option<i64>,
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
}

#[tauri::command]
pub async fn list_map_numbers(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<MapNumber>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare_cached(
        "SELECT code, label, parent_code, sort_order, fs_line, default_grouping_id, flip_map_code
         FROM map_numbers ORDER BY sort_order, code",
    )?;

    let maps = stmt
        .query_map([], |r| {
            Ok(MapNumber {
                code: r.get(0)?,
                label: r.get(1)?,
                parent_code: r.get(2)?,
                sort_order: r.get(3)?,
                fs_line: r.get(4)?,
                default_grouping_id: r.get(5)?,
                flip_map_code: r.get(6)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    Ok(maps)
}

#[tauri::command]
pub async fn upsert_map_number(
    payload: UpsertMapPayload,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    db.conn.execute(
        "INSERT INTO map_numbers (code, label, parent_code, sort_order, fs_line, default_grouping_id, flip_map_code)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(code) DO UPDATE SET
           label               = excluded.label,
           parent_code         = excluded.parent_code,
           sort_order          = excluded.sort_order,
           fs_line             = excluded.fs_line,
           default_grouping_id = excluded.default_grouping_id,
           flip_map_code       = excluded.flip_map_code",
        params![
            payload.code,
            payload.label,
            payload.parent_code,
            payload.sort_order,
            payload.fs_line,
            payload.default_grouping_id,
            payload.flip_map_code,
        ],
    )?;

    // If a default grouping was set, backfill all accounts already mapped to this
    // map number that aren't yet in that grouping.
    if let Some(gid) = payload.default_grouping_id {
        db.conn.execute(
            "INSERT OR IGNORE INTO account_groupings (account_id, grouping_id)
             SELECT id, ?1 FROM tb_accounts WHERE map_number = ?2",
            params![gid, payload.code],
        )?;
    }

    Ok(())
}

#[tauri::command]
pub async fn list_groupings(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<Grouping>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut stmt = db.conn.prepare_cached(
        "SELECT id, name, description, color FROM groupings ORDER BY name",
    )?;

    let groups = stmt
        .query_map([], |r| {
            Ok(Grouping {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                color: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    Ok(groups)
}

#[tauri::command]
pub async fn upsert_grouping(
    payload: UpsertGroupingPayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    if let Some(id) = payload.id {
        db.conn.execute(
            "UPDATE groupings SET name=?1, description=?2, color=?3 WHERE id=?4",
            params![payload.name, payload.description, payload.color, id],
        )?;
        Ok(id)
    } else {
        db.conn.execute(
            "INSERT INTO groupings (name, description, color) VALUES (?1, ?2, ?3)",
            params![payload.name, payload.description, payload.color],
        )?;
        Ok(db.conn.last_insert_rowid())
    }
}

#[tauri::command]
pub async fn delete_grouping(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM groupings WHERE id=?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub async fn delete_map_number(
    code: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM map_numbers WHERE code=?1", params![code])?;
    Ok(())
}

#[tauri::command]
pub async fn assign_grouping(
    account_number: String,
    grouping_id: i64,
    assign: bool,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;

    let account_id: i64 = db.conn.query_row(
        "SELECT id FROM tb_accounts WHERE account_number = ?1",
        params![account_number],
        |r| r.get(0),
    )?;

    if assign {
        db.conn.execute(
            "INSERT OR IGNORE INTO account_groupings (account_id, grouping_id) VALUES (?1, ?2)",
            params![account_id, grouping_id],
        )?;
    } else {
        db.conn.execute(
            "DELETE FROM account_groupings WHERE account_id=?1 AND grouping_id=?2",
            params![account_id, grouping_id],
        )?;
    }

    Ok(())
}

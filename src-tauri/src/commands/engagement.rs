use crate::db::AppDb;
use crate::error::AppError;
use crate::models::{map_engagement_row, EngagementMeta, ENGAGEMENT_COLUMNS};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CreateEngagementPayload {
    pub db_path: String,
    pub entity_name: String,
    pub year_end: String,
    pub fiscal_year: i32,
    pub currency: String,
}

/// Open an existing .db engagement file
#[tauri::command]
pub async fn open_engagement(
    path: String,
    state: State<'_, AppState>,
) -> std::result::Result<EngagementMeta, AppError> {
    let db = AppDb::open(&path)?;

    let meta: EngagementMeta = db.conn.query_row(
        &format!("SELECT {ENGAGEMENT_COLUMNS} FROM engagement LIMIT 1"),
        [],
        |row| map_engagement_row(row, path.clone()),
    )?;

    *state.db.lock().unwrap() = Some(db);
    Ok(meta)
}

/// Create a brand-new engagement .db file
#[tauri::command]
pub async fn create_engagement(
    payload: CreateEngagementPayload,
    state: State<'_, AppState>,
) -> std::result::Result<EngagementMeta, AppError> {
    let db = AppDb::open(&payload.db_path)?;
    let id = Uuid::new_v4().to_string();

    db.conn.execute(
        "INSERT INTO engagement (id, entity_name, year_end, fiscal_year, currency)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            &id,
            &payload.entity_name,
            &payload.year_end,
            payload.fiscal_year,
            &payload.currency,
        ],
    )?;

    // Re-read so created_at reflects the DB default rather than a fabricated value.
    let meta: EngagementMeta = db.conn.query_row(
        &format!("SELECT {ENGAGEMENT_COLUMNS} FROM engagement LIMIT 1"),
        [],
        |row| map_engagement_row(row, payload.db_path.clone()),
    )?;

    *state.db.lock().unwrap() = Some(db);
    Ok(meta)
}

/// Clear the in-memory DB handle (doesn't delete files)
#[tauri::command]
pub async fn close_engagement(
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    *state.db.lock().unwrap() = None;
    Ok(())
}

/// Fetch metadata for the currently open engagement
#[tauri::command]
pub async fn get_engagement_meta(
    state: State<'_, AppState>,
) -> std::result::Result<EngagementMeta, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let meta = db.conn.query_row(
        &format!("SELECT {ENGAGEMENT_COLUMNS} FROM engagement LIMIT 1"),
        [],
        |row| map_engagement_row(row, db.path.clone()),
    )?;

    Ok(meta)
}

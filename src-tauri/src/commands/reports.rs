use crate::error::{AppError, Result};
use crate::models::{CustomVar, EngagementMeta, MapTotal, ReportData};
use crate::AppState;
use chrono::Utc;
use rusqlite::params;
use tauri::State;

/// Returns all data the frontend Web Worker needs to render financial statements.
/// The frontend handles DOM construction; Rust just aggregates numbers.
#[tauri::command]
pub async fn render_report_data(
    state: State<'_, AppState>,
) -> std::result::Result<ReportData, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    // Engagement metadata
    let engagement = db.conn.query_row(
        "SELECT id, entity_name, year_end, fiscal_year, currency, is_locked, created_at
         FROM engagement LIMIT 1",
        [],
        |r| {
            Ok(EngagementMeta {
                id: r.get(0)?,
                entity_name: r.get(1)?,
                year_end: r.get(2)?,
                fiscal_year: r.get(3)?,
                currency: r.get(4)?,
                is_locked: r.get::<_, i32>(5)? != 0,
                created_at: Utc::now(),
                db_path: db.path.clone(),
            })
        },
    )?;

    // Map totals: current & prior, plus AJE-adjusted current
    let mut stmt = db.conn.prepare_cached(
        "SELECT
             m.code,
             m.label,
             COALESCE(SUM(a.current_balance), 0.0) AS current_total,
             COALESCE(SUM(a.prior_balance), 0.0)   AS prior_total,
             COALESCE(SUM(
                 a.current_balance + COALESCE((
                     SELECT SUM(l.debit - l.credit)
                     FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                     WHERE l.account_number = a.account_number AND j.is_voided = 0
                 ), 0.0)
             ), 0.0) AS adjusted_current
         FROM map_numbers m
         LEFT JOIN tb_accounts a ON a.map_number = m.code
         GROUP BY m.code
         ORDER BY m.sort_order, m.code",
    )?;

    let map_totals: Vec<MapTotal> = stmt
        .query_map([], |r| {
            Ok(MapTotal {
                map_number: r.get(0)?,
                label: r.get(1)?,
                current_total: r.get(2)?,
                prior_total: r.get(3)?,
                adjusted_current: r.get(4)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    // Custom variables
    let mut var_stmt = db
        .conn
        .prepare_cached("SELECT key, value, description FROM custom_vars ORDER BY key")?;
    let custom_vars: Vec<CustomVar> = var_stmt
        .query_map([], |r| {
            Ok(CustomVar {
                key: r.get(0)?,
                value: r.get(1)?,
                description: r.get(2)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    Ok(ReportData {
        engagement,
        map_totals,
        custom_vars,
    })
}

use crate::db::AppDb;
use crate::error::{AppError, Result};
use crate::models::{
    map_engagement_row, DocAsset, DocPackage, DocPackageItem, DocTemplate, EngagementMeta,
    NoteInfo, RenderPackageResult, ResolvedLine, ENGAGEMENT_COLUMNS,
};
use crate::AppState;
use chrono::Utc;
use rusqlite::params;
use std::collections::HashMap;
use tauri::State;

// ── PDF export via WebView2 PrintToPdf ───────────────────────────────────────

#[cfg(windows)]
fn print_to_pdf_sync(win: &tauri::Window, pdf_path: &std::path::Path) -> std::result::Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
    use windows::core::{Interface, PCWSTR};

    let pdf_path_wstr: Vec<u16> = pdf_path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0u16))
        .collect();

    let (tx, rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();

    win.with_webview(move |wv| {
        unsafe {
            let ctrl = wv.controller();
            let core = match ctrl.CoreWebView2() {
                Ok(c) => c,
                Err(e) => { tx.send(Err(e.to_string())).ok(); return; }
            };
            // Cast ICoreWebView2 → ICoreWebView2_7 which has PrintToPdf
            let wv7: ICoreWebView2_7 = match core.cast() {
                Ok(v) => v,
                Err(e) => { tx.send(Err(e.to_string())).ok(); return; }
            };
            let tx2 = tx.clone();
            let result = webview2_com::PrintToPdfCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| {
                    wv7.PrintToPdf(
                        PCWSTR::from_raw(pdf_path_wstr.as_ptr()),
                        None,
                        windows::core::InParam::owned(handler),
                    ).map_err(webview2_com::Error::WindowsError)
                }),
                Box::new(move |hresult, success: bool| {
                    if let Err(e) = hresult {
                        tx2.send(Err(e.to_string())).ok();
                    } else if !success {
                        tx2.send(Err("PrintToPdf returned false".into())).ok();
                    } else {
                        tx2.send(Ok(())).ok();
                    }
                    Ok(())
                }),
            );
            if let Err(e) = result {
                tx.send(Err(e.to_string())).ok();
            }
        }
    }).map_err(|e| e.to_string())?;

    rx.recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| "PrintToPdf timed out".to_string())?
}

#[cfg(windows)]
#[tauri::command]
pub async fn export_pdf(html: String, app: tauri::AppHandle) -> std::result::Result<String, AppError> {
    use tauri::Manager;

    let html_path = std::env::temp_dir().join("workedpapers_print.html");
    std::fs::write(&html_path, html.as_bytes())
        .map_err(|e| AppError::Other(e.to_string()))?;

    let pdf_path = std::env::temp_dir().join("workedpapers_print.pdf");
    let _ = std::fs::remove_file(&pdf_path);

    let fwd = html_path.to_string_lossy().replace('\\', "/");
    let url_str = format!("file:///{}", fwd.trim_start_matches('/'));
    let url = tauri::WindowUrl::External(
        url_str.parse().map_err(|_| AppError::Other("bad url".into()))?,
    );

    // Close any stale window from a previous export
    if let Some(w) = app.get_window("pdf-export") {
        let _ = w.close();
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    // Open an off-screen window at 8.5" × 11" at 96 dpi (816 × 1056 px)
    let win = tauri::WindowBuilder::new(&app, "pdf-export", url)
        .title("PDF Export")
        .inner_size(816.0, 1056.0)
        .position(-32000.0, -32000.0)
        .visible(false)
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .build()
        .map_err(|e| AppError::Other(e.to_string()))?;

    // Give WebView2 time to load and render. Our documents are self-contained
    // HTML with no external resources so 1.5 s is more than enough.
    std::thread::sleep(std::time::Duration::from_millis(1500));

    print_to_pdf_sync(&win, &pdf_path)
        .map_err(AppError::Other)?;

    if let Some(w) = app.get_window("pdf-export") {
        let _ = w.close();
    }

    let bytes = std::fs::read(&pdf_path)
        .map_err(|e| AppError::Other(format!("reading pdf: {e}")))?;
    Ok(base64_encode(&bytes))
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn export_pdf(_html: String, _app: tauri::AppHandle) -> std::result::Result<String, AppError> {
    Err(AppError::Other("PDF export only supported on Windows".into()))
}

fn base64_encode(bytes: &[u8]) -> String {
    const C: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(C[((n >> 18) & 63) as usize] as char);
        out.push(C[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { C[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { C[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ── Helpers (re-use the same fetch logic as reports.rs) ──────────────────────

fn fetch_engagement(db: &AppDb) -> Result<EngagementMeta> {
    Ok(db.conn.query_row(
        &format!("SELECT {ENGAGEMENT_COLUMNS} FROM engagement LIMIT 1"),
        [],
        |r| map_engagement_row(r, db.path.clone()),
    )?)
}

fn fetch_axis_maps(
    db: &AppDb,
) -> Result<(HashMap<String, f64>, HashMap<String, f64>, Vec<String>)> {
    let mut stmt = db.conn.prepare_cached(
        "SELECT
             m.code,
             COALESCE(SUM(
                 a.current_balance + COALESCE((
                     SELECT SUM(l.debit - l.credit)
                     FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                     WHERE l.account_number = a.account_number AND j.is_voided = 0
                 ), 0.0)
             ), 0.0),
             COALESCE(SUM(a.prior_balance), 0.0)
         FROM map_numbers m
         LEFT JOIN tb_accounts a ON a.map_number = m.code
         GROUP BY m.code
         ORDER BY m.sort_order, m.code",
    )?;
    let mut cur = HashMap::new();
    let mut pri = HashMap::new();
    let mut codes = Vec::new();
    for row in stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
    })? {
        let (code, c, p) = row?;
        cur.insert(code.clone(), c);
        pri.insert(code.clone(), p);
        codes.push(code);
    }
    codes.sort();
    Ok((cur, pri, codes))
}

fn fetch_group_maps(db: &AppDb) -> Result<(HashMap<String, f64>, HashMap<String, f64>)> {
    let mut stmt = db.conn.prepare_cached(
        "SELECT ag.grouping_id,
             COALESCE(SUM(a.current_balance + COALESCE((
                 SELECT SUM(l.debit - l.credit) FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                 WHERE l.account_number = a.account_number AND j.is_voided = 0
             ), 0.0)), 0.0),
             COALESCE(SUM(a.prior_balance), 0.0)
         FROM account_groupings ag JOIN tb_accounts a ON a.id = ag.account_id
         GROUP BY ag.grouping_id",
    )?;
    let mut cur = HashMap::new();
    let mut pri = HashMap::new();
    for row in stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
    })? {
        let (id, c, p) = row?;
        cur.insert(id.to_string(), c);
        pri.insert(id.to_string(), p);
    }
    Ok((cur, pri))
}

fn fetch_account_maps(db: &AppDb) -> Result<(HashMap<String, f64>, HashMap<String, f64>)> {
    let mut stmt = db.conn.prepare_cached(
        "SELECT a.account_number,
             a.current_balance + COALESCE((
                 SELECT SUM(l.debit - l.credit) FROM aje_lines l JOIN ajes j ON j.id = l.aje_id
                 WHERE l.account_number = a.account_number AND j.is_voided = 0
             ), 0.0),
             a.prior_balance
         FROM tb_accounts a",
    )?;
    let mut cur = HashMap::new();
    let mut pri = HashMap::new();
    for row in stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
    })? {
        let (acct, c, p) = row?;
        cur.insert(acct.clone(), c);
        pri.insert(acct, p);
    }
    Ok((cur, pri))
}

fn fetch_vars(db: &AppDb) -> Result<HashMap<String, String>> {
    let mut stmt = db.conn.prepare_cached("SELECT key, value FROM custom_vars")?;
    let mut map = HashMap::new();
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (k, v) = row?;
        map.insert(k, v);
    }
    // Inject user identity from settings so {{prepared_by}} / {{preparer_name}} resolve
    let settings_path = {
        let base = std::env::var("APPDATA")
            .or_else(|_| std::env::var("HOME"))
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."));
        base.join("WorkedPapers").join("settings.json")
    };
    if let Ok(raw) = std::fs::read_to_string(&settings_path) {
        if let Ok(s) = serde_json::from_str::<crate::models::AppSettings>(&raw) {
            map.entry("user_name".into()).or_insert(s.user_name);
            map.entry("user_initials".into()).or_insert(s.user_initials);
        }
    }
    Ok(map)
}

// ── Asset CRUD ────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct UpsertAssetPayload {
    pub id: Option<i64>,
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub width_px: Option<i64>,
    pub height_px: Option<i64>,
}

#[tauri::command]
pub async fn upsert_doc_asset(
    payload: UpsertAssetPayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute(
        "INSERT INTO doc_assets (name, mime_type, data_base64, width_px, height_px, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
             mime_type    = excluded.mime_type,
             data_base64  = excluded.data_base64,
             width_px     = excluded.width_px,
             height_px    = excluded.height_px,
             updated_at   = excluded.updated_at",
        params![
            payload.name, payload.mime_type, payload.data_base64,
            payload.width_px, payload.height_px
        ],
    )?;
    Ok(db.conn.last_insert_rowid())
}

#[tauri::command]
pub async fn list_doc_assets(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<DocAsset>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, mime_type, data_base64, width_px, height_px
         FROM doc_assets ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DocAsset {
            id: r.get(0)?,
            name: r.get(1)?,
            mime_type: r.get(2)?,
            data_base64: r.get(3)?,
            width_px: r.get(4)?,
            height_px: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[tauri::command]
pub async fn delete_doc_asset(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM doc_assets WHERE id = ?1", params![id])?;
    Ok(())
}

// ── Template CRUD ─────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct UpsertTemplatePayload {
    pub id: Option<i64>,
    pub name: String,
    pub kind: String,
    pub body_html: String,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn upsert_doc_template(
    payload: UpsertTemplatePayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    if let Some(id) = payload.id {
        db.conn.execute(
            "UPDATE doc_templates SET name=?1, kind=?2, body_html=?3, description=?4,
             updated_at=datetime('now') WHERE id=?5",
            params![payload.name, payload.kind, payload.body_html, payload.description, id],
        )?;
        Ok(id)
    } else {
        db.conn.execute(
            "INSERT INTO doc_templates (name, kind, body_html, description)
             VALUES (?1, ?2, ?3, ?4)",
            params![payload.name, payload.kind, payload.body_html, payload.description],
        )?;
        Ok(db.conn.last_insert_rowid())
    }
}

#[tauri::command]
pub async fn list_doc_templates(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<DocTemplate>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, kind, body_html, description, is_system
         FROM doc_templates ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DocTemplate {
            id: r.get(0)?,
            name: r.get(1)?,
            kind: r.get(2)?,
            body_html: r.get(3)?,
            description: r.get(4)?,
            is_system: r.get::<_, i32>(5)? != 0,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[tauri::command]
pub async fn get_doc_template(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<DocTemplate, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    Ok(db.conn.query_row(
        "SELECT id, name, kind, body_html, description, is_system FROM doc_templates WHERE id=?1",
        params![id],
        |r| Ok(DocTemplate {
            id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?,
            body_html: r.get(3)?, description: r.get(4)?,
            is_system: r.get::<_, i32>(5)? != 0,
        }),
    )?)
}

#[tauri::command]
pub async fn delete_doc_template(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM doc_templates WHERE id = ?1", params![id])?;
    Ok(())
}

// ── Package CRUD ──────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct UpsertPackagePayload {
    pub id: Option<i64>,
    pub name: String,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn upsert_doc_package(
    payload: UpsertPackagePayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    if let Some(id) = payload.id {
        db.conn.execute(
            "UPDATE doc_packages SET name=?1, description=?2, updated_at=datetime('now') WHERE id=?3",
            params![payload.name, payload.description, id],
        )?;
        Ok(id)
    } else {
        db.conn.execute(
            "INSERT INTO doc_packages (name, description) VALUES (?1, ?2)",
            params![payload.name, payload.description],
        )?;
        Ok(db.conn.last_insert_rowid())
    }
}

#[tauri::command]
pub async fn list_doc_packages(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<DocPackage>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, description FROM doc_packages ORDER BY name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DocPackage { id: r.get(0)?, name: r.get(1)?, description: r.get(2)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[tauri::command]
pub async fn delete_doc_package(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM doc_packages WHERE id = ?1", params![id])?;
    Ok(())
}

// ── Package Item CRUD ─────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct UpsertPackageItemPayload {
    pub id: Option<i64>,
    pub package_id: i64,
    pub sort_order: i32,
    pub item_kind: String,
    pub doc_template_id: Option<i64>,
    pub statement_id: Option<i64>,
    pub var_overrides: Option<String>,
}

#[tauri::command]
pub async fn upsert_package_item(
    payload: UpsertPackageItemPayload,
    state: State<'_, AppState>,
) -> std::result::Result<i64, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    let overrides = payload.var_overrides.unwrap_or_else(|| "{}".to_string());
    if let Some(id) = payload.id {
        db.conn.execute(
            "UPDATE doc_package_items SET sort_order=?1, item_kind=?2,
             doc_template_id=?3, statement_id=?4, var_overrides=?5 WHERE id=?6",
            params![payload.sort_order, payload.item_kind, payload.doc_template_id,
                    payload.statement_id, overrides, id],
        )?;
        Ok(id)
    } else {
        db.conn.execute(
            "INSERT INTO doc_package_items
             (package_id, sort_order, item_kind, doc_template_id, statement_id, var_overrides)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![payload.package_id, payload.sort_order, payload.item_kind,
                    payload.doc_template_id, payload.statement_id, overrides],
        )?;
        Ok(db.conn.last_insert_rowid())
    }
}

#[tauri::command]
pub async fn list_package_items(
    package_id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<Vec<DocPackageItem>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let mut stmt = db.conn.prepare(
        "SELECT id, package_id, sort_order, item_kind, doc_template_id, statement_id, var_overrides
         FROM doc_package_items WHERE package_id=?1 ORDER BY sort_order, id",
    )?;
    let rows = stmt.query_map(params![package_id], |r| {
        Ok(DocPackageItem {
            id: r.get(0)?, package_id: r.get(1)?, sort_order: r.get(2)?,
            item_kind: r.get(3)?, doc_template_id: r.get(4)?,
            statement_id: r.get(5)?, var_overrides: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[tauri::command]
pub async fn reorder_package_items(
    ordered_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let mut guard = state.db.lock().unwrap();
    let db = guard.as_mut().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.transaction(|conn| {
        for (i, id) in ordered_ids.iter().enumerate() {
            conn.execute(
                "UPDATE doc_package_items SET sort_order=?1 WHERE id=?2",
                params![i as i64, id],
            )?;
        }
        Ok(())
    })?;
    Ok(())
}

#[tauri::command]
pub async fn delete_package_item(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.ensure_unlocked()?;
    db.conn.execute("DELETE FROM doc_package_items WHERE id=?1", params![id])?;
    Ok(())
}

// ── Note registry ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_note_registry(
    package_id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<Vec<NoteInfo>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let mut stmt = db.conn.prepare(
        "SELECT note_key, note_number, title FROM doc_note_registry
         WHERE package_id=?1 ORDER BY note_number",
    )?;
    let rows = stmt.query_map(params![package_id], |r| {
        Ok(NoteInfo { note_key: r.get(0)?, note_number: r.get(1)?, title: r.get(2)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[tauri::command]
pub async fn list_all_note_keys(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<NoteInfo>, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let mut stmt = db.conn.prepare(
        "SELECT note_key, note_number, title FROM doc_note_registry
         ORDER BY note_number",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(NoteInfo { note_key: r.get(0)?, note_number: r.get(1)?, title: r.get(2)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

// ── Two-pass compositor ───────────────────────────────────────────────────────

/// A discovered note entry from pass 1.
struct NoteEntry {
    number: i32,
    title: Option<String>,
}

/// Context available during tag expansion (pass 2).
struct CompositorCtx {
    engagement: EngagementMeta,
    vars: HashMap<String, String>,
    assets: HashMap<String, String>, // name -> "data:mime;base64,..."
    notes: HashMap<String, NoteEntry>,
    cur_maps: HashMap<String, f64>,
    pri_maps: HashMap<String, f64>,
    map_codes: Vec<String>,
    cur_groups: HashMap<String, f64>,
    pri_groups: HashMap<String, f64>,
    cur_accts: HashMap<String, f64>,
    pri_accts: HashMap<String, f64>,
    // Resolved statement line collections keyed by statement_id
    resolved_statements: HashMap<i64, Vec<ResolvedLine>>,
    // Maps tag key ("balance_sheet") -> statement_id for kind-based embeds
    stmt_kind_map: HashMap<String, i64>,
}

/// Scan a string for note_def: tags, assigning sequential numbers.
/// note_ref: tags are intentionally ignored here — refs only resolve to numbers
/// that were assigned by their corresponding note_def:. This prevents
/// unreferenced note_ref: tags in a template from consuming note numbers.
fn pass1_scan(
    text: &str,
    notes: &mut HashMap<String, NoteEntry>,
    next_number: &mut i32,
) {
    let mut remaining = text;
    while let Some(start) = remaining.find("{{") {
        remaining = &remaining[start + 2..];
        if let Some(end) = remaining.find("}}") {
            let tag = remaining[..end].trim();
            remaining = &remaining[end + 2..];
            let rest = match tag.strip_prefix("note_def:") {
                Some(r) => r,
                None => continue,
            };
            let key = rest.split('|').next().unwrap_or(rest).trim().to_string();
            if key.is_empty() { continue; }
            if !notes.contains_key(&key) {
                let title = rest.split('|').skip(1).find_map(|p| {
                    p.trim().strip_prefix("title=").map(|t| t.to_string())
                });
                notes.insert(key, NoteEntry { number: *next_number, title });
                *next_number += 1;
            }
        }
    }
}

/// Format a numeric amount — no currency prefix, parentheses for negatives.
fn fmt_amount(v: f64, _currency: &str) -> String {
    let abs = v.abs();
    let formatted = format_number(abs);
    if v < 0.0 {
        format!("({})", formatted)
    } else {
        formatted
    }
}

fn format_number(v: f64) -> String {
    // Build comma-separated integer part + two decimal places
    let cents = (v * 100.0).round() as i64;
    let int_part = cents / 100;
    let dec_part = cents % 100;
    let s = int_part.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 { result.push(','); }
        result.push(c);
    }
    let int_str: String = result.chars().rev().collect();
    format!("{}.{:02}", int_str, dec_part)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
}

/// Expand all {{ }} tags in a string using the compositor context (pass 2).
fn expand_tags(template: &str, ctx: &CompositorCtx) -> String {
    use crate::report_engine::{eval, EvalContext};

    let mut out = String::with_capacity(template.len() + 256);
    let mut remaining = template;

    while let Some(start) = remaining.find("{{") {
        out.push_str(&remaining[..start]);
        remaining = &remaining[start + 2..];

        // Literal escape {{{ }}}
        if remaining.starts_with("{ }}}") {
            out.push_str("{{ }}");
            remaining = &remaining[5..];
            continue;
        }

        if let Some(end) = remaining.find("}}") {
            let tag = remaining[..end].trim();
            remaining = &remaining[end + 2..];
            out.push_str(&dispatch_tag(tag, ctx));
        } else {
            // Unclosed tag — output as-is
            out.push_str("{{");
        }
    }
    out.push_str(remaining);
    out
}

fn dispatch_tag(tag: &str, ctx: &CompositorCtx) -> String {
    use crate::report_engine::{eval, EvalContext};

    // Split off axis modifier: tag|prior  or  tag  (default = current)
    let (body, modifier) = if let Some(pos) = tag.rfind('|') {
        // Only treat as modifier if the part after | is a known modifier
        let m = &tag[pos + 1..];
        if matches!(m, "prior" | "py" | "py2" | "py3" | "py4" | "py5" | "inline" | "short") {
            (&tag[..pos], m)
        } else {
            (tag, "")
        }
    } else {
        (tag, "")
    };

    // ── Known directives ─────────────────────────────────────────────────────
    if let Some(key) = body.strip_prefix("note_ref:") {
        let key = key.trim();
        return if let Some(entry) = ctx.notes.get(key) {
            if modifier == "inline" {
                format!("<sup>{}</sup>", entry.number)
            } else {
                format!("Note {}", entry.number)
            }
        } else {
            format!("[Note: unknown key '{}']", esc(key))
        };
    }

    if let Some(rest) = body.strip_prefix("note_def:") {
        let key = rest.split('|').next().unwrap_or(rest).trim();
        return if let Some(entry) = ctx.notes.get(key) {
            let heading = if let Some(title) = &entry.title {
                format!("Note {} — {}", entry.number, esc(title))
            } else {
                format!("Note {}", entry.number)
            };
            format!("<h3 class=\"note-heading\" id=\"note-{}\">{}</h3>", entry.number, heading)
        } else {
            format!("[Note def: unknown key '{}']", esc(key))
        };
    }

    if let Some(rest) = body.strip_prefix("image:") {
        let name = rest.split('|').next().unwrap_or(rest).trim();
        return if let Some(data_uri) = ctx.assets.get(name) {
            // Parse optional width/height modifiers
            let mut attrs = String::new();
            for part in body.split('|').skip(1) {
                if let Some(v) = part.trim().strip_prefix("width=") {
                    attrs.push_str(&format!(" width=\"{}\"", esc(v)));
                } else if let Some(v) = part.trim().strip_prefix("height=") {
                    attrs.push_str(&format!(" height=\"{}\"", esc(v)));
                } else if let Some(v) = part.trim().strip_prefix("alt=") {
                    attrs.push_str(&format!(" alt=\"{}\"", esc(v)));
                }
            }
            format!("<img src=\"{}\"{} />", data_uri, attrs)
        } else {
            format!("[image '{}' not found]", esc(name))
        };
    }

    if let Some(rest) = body.strip_prefix("statement:") {
        return render_statement_embed(rest.trim(), ctx);
    }

    // ── Engagement metadata ───────────────────────────────────────────────────
    match body {
        "entity_name"        => return esc(&ctx.engagement.entity_name),
        "fiscal_year"        => return ctx.engagement.fiscal_year.to_string(),
        "currency"           => return esc(&ctx.engagement.currency),
        "prepared_date"      => return Utc::now().format("%B %d, %Y").to_string(),
        "preparer_name" | "prepared_by" => return esc(&ctx.vars.get("user_name").cloned().unwrap_or_default()),
        "preparer_initials"  => return esc(&ctx.vars.get("user_initials").cloned().unwrap_or_default()),
        "year_end" if modifier == "short" => return esc(&ctx.engagement.year_end),
        "year_end" => {
            // Format "2024-12-31" -> "December 31, 2024"
            if let Ok(d) = chrono::NaiveDate::parse_from_str(&ctx.engagement.year_end, "%Y-%m-%d") {
                return d.format("%B %d, %Y").to_string();
            }
            return esc(&ctx.engagement.year_end);
        }
        _ => {}
    }

    // ── Custom var (bare V:key — text, not numeric) ───────────────────────────
    if let Some(key) = body.strip_prefix("V:") {
        return esc(ctx.vars.get(key.trim()).map(|s| s.as_str()).unwrap_or(""));
    }

    // ── Financial expression (fall-through to existing engine) ────────────────
    // |prior / |py / |py2..py5 all resolve to the stored prior-year data.
    // When multi-year history is added, py2-py5 will address older snapshots.
    let use_prior = matches!(modifier, "prior" | "py" | "py2" | "py3" | "py4" | "py5");
    let (cur_maps, pri_maps, cur_groups, pri_groups, cur_accts, pri_accts) = if use_prior {
        (&ctx.pri_maps, &ctx.pri_maps, &ctx.pri_groups, &ctx.pri_groups,
         &ctx.pri_accts, &ctx.pri_accts)
    } else {
        (&ctx.cur_maps, &ctx.pri_maps, &ctx.cur_groups, &ctx.pri_groups,
         &ctx.cur_accts, &ctx.pri_accts)
    };

    let empty_vals: HashMap<i64, f64> = HashMap::new();
    let eval_ctx = EvalContext {
        map_totals:    cur_maps,
        map_codes:     &ctx.map_codes,
        group_totals:  cur_groups,
        account_totals: cur_accts,
        line_values:   &empty_vals,
        vars:          &ctx.vars,
    };

    match eval(body, &eval_ctx) {
        Ok(v)  => fmt_amount(v, &ctx.engagement.currency),
        Err(e) => format!("[expr error: {}]", esc(&e)),
    }
}

/// Render a structured statement as an HTML fragment.
/// `ref_str` is e.g. "balance_sheet", "income_statement", or "id:42".
fn render_statement_embed(ref_str: &str, ctx: &CompositorCtx) -> String {
    let resolved_lines: Option<&Vec<ResolvedLine>> = if let Some(id_str) = ref_str.strip_prefix("id:") {
        id_str.parse::<i64>().ok().and_then(|id| ctx.resolved_statements.get(&id))
    } else {
        ctx.stmt_kind_map
            .get(ref_str)
            .and_then(|id| ctx.resolved_statements.get(id))
    };

    if let Some(lines) = resolved_lines {
        render_statement_lines_html(lines, ctx)
    } else {
        format!("[statement '{}' not found — make sure a statement of that kind exists and is seeded]", esc(ref_str))
    }
}

fn render_statement_lines_html(lines: &[ResolvedLine], ctx: &CompositorCtx) -> String {
    let mut html = String::from("<table class=\"fs-table\">\n");
    for line in lines {
        let indent = line.depth * 20;
        let class = match line.line_type.as_str() {
            "HEADER"   => "fs-header",
            "SUBTOTAL" => "fs-subtotal",
            "SPACER"   => "fs-spacer",
            "VAR"      => "fs-var",
            _          => "fs-line",
        };
        let bold_style = if line.bold { "font-weight:bold;" } else { "" };
        let underline_style = if line.underline { "border-bottom:1px solid #000;" } else { "" };

        html.push_str(&format!("<tr class=\"{class}\">\n"));

        // Label cell — expand note_ref tags within it
        let label_expanded = expand_tags_label(&line.label, ctx);
        html.push_str(&format!(
            "  <td class=\"fs-label\" style=\"padding-left:{indent}px;{bold_style}{underline_style}\">{label_expanded}</td>\n"
        ));

        if line.line_type == "SPACER" || line.line_type == "HEADER" {
            html.push_str("  <td class=\"fs-amount\"></td>\n");
            if line.show_prior {
                html.push_str("  <td class=\"fs-amount\"></td>\n");
            }
        } else if line.line_type == "VAR" {
            let text = line.text.as_deref().unwrap_or("");
            html.push_str(&format!("  <td class=\"fs-amount\" colspan=\"2\">{}</td>\n", esc(text)));
        } else {
            let cur_str = match (line.current, &line.error) {
                (Some(v), _) => fmt_amount(v, &ctx.engagement.currency),
                (_, Some(e)) => format!("[{}]", esc(e)),
                _ => String::new(),
            };
            html.push_str(&format!(
                "  <td class=\"fs-amount\" style=\"{bold_style}{underline_style}\">{cur_str}</td>\n"
            ));
            if line.show_prior {
                let pri_str = line.prior.map(|v| fmt_amount(v, &ctx.engagement.currency)).unwrap_or_default();
                html.push_str(&format!("  <td class=\"fs-amount\">{pri_str}</td>\n"));
            }
        }
        html.push_str("</tr>\n");
    }
    html.push_str("</table>\n");
    html
}

/// Expand only note_ref/note_def tags within a line label (no financial eval).
fn expand_tags_label(label: &str, ctx: &CompositorCtx) -> String {
    let mut out = String::new();
    let mut remaining = label;
    while let Some(start) = remaining.find("{{") {
        out.push_str(&esc(&remaining[..start]));
        remaining = &remaining[start + 2..];
        if let Some(end) = remaining.find("}}") {
            let tag = remaining[..end].trim();
            remaining = &remaining[end + 2..];
            if tag.starts_with("note_ref:") || tag.starts_with("note_def:") {
                out.push_str(&dispatch_tag(tag, ctx));
            } else {
                out.push_str(&format!("{{{{{}}}}}", esc(tag)));
            }
        } else {
            out.push_str("{{");
        }
    }
    out.push_str(&esc(remaining));
    out
}

// ── resolve_statement_for_compositor (inline, no IPC) ────────────────────────

fn resolve_statement_inline(
    db: &AppDb,
    statement_id: i64,
    cur_maps: &HashMap<String, f64>,
    pri_maps: &HashMap<String, f64>,
    map_codes: &[String],
    cur_groups: &HashMap<String, f64>,
    pri_groups: &HashMap<String, f64>,
    cur_accts: &HashMap<String, f64>,
    pri_accts: &HashMap<String, f64>,
    vars: &HashMap<String, String>,
) -> Result<Vec<ResolvedLine>> {
    use crate::models::StatementLine;
    use crate::report_engine::{eval, EvalContext};

    let mut stmt = db.conn.prepare_cached(
        "SELECT id, statement_id, parent_id, line_no, sort_order, line_type,
                label, expression, bold, underline, show_prior, invert_sign
         FROM statement_lines WHERE statement_id = ?1 ORDER BY sort_order, id",
    )?;
    let lines: Vec<StatementLine> = stmt
        .query_map(params![statement_id], |r| {
            Ok(StatementLine {
                id: r.get(0)?, statement_id: r.get(1)?, parent_id: r.get(2)?,
                line_no: r.get(3)?, sort_order: r.get(4)?, line_type: r.get(5)?,
                label: r.get(6)?, expression: r.get(7)?,
                bold: r.get::<_, i32>(8)? != 0, underline: r.get::<_, i32>(9)? != 0,
                show_prior: r.get::<_, i32>(10)? != 0, invert_sign: r.get::<_, i32>(11)? != 0,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;

    let parent_of: HashMap<i64, Option<i64>> = lines.iter().map(|l| (l.id, l.parent_id)).collect();
    let id_to_lineno: HashMap<i64, i64> = lines.iter().map(|l| (l.id, l.line_no)).collect();
    let depth_of = |mut id: i64| -> i32 {
        let mut d = 0;
        while let Some(Some(p)) = parent_of.get(&id) { d += 1; id = *p; }
        d
    };

    let mut child_cur: HashMap<i64, f64> = HashMap::new();
    let mut child_pri: HashMap<i64, f64> = HashMap::new();
    let mut cur_vals: HashMap<i64, f64> = HashMap::new();
    let mut pri_vals: HashMap<i64, f64> = HashMap::new();
    let mut resolved = Vec::with_capacity(lines.len());

    for line in &lines {
        let depth = depth_of(line.id);
        let parent_lineno = line.parent_id.and_then(|p| id_to_lineno.get(&p).copied());
        let mut current: Option<f64> = None;
        let mut prior: Option<f64> = None;
        let mut text: Option<String> = None;
        let mut error: Option<String> = None;

        match line.line_type.as_str() {
            "HEADER" | "SPACER" => {}
            "VAR" => {
                let key = line.expression.as_deref().unwrap_or("").trim()
                    .strip_prefix("V:").unwrap_or(line.expression.as_deref().unwrap_or("").trim());
                text = vars.get(key).cloned().or(Some(String::new()));
            }
            "MAP" | "FORMULA" => {
                let expr = line.expression.clone().unwrap_or_default();
                let cc = EvalContext { map_totals: cur_maps, map_codes, group_totals: cur_groups,
                    account_totals: cur_accts, line_values: &cur_vals, vars };
                let pc = EvalContext { map_totals: pri_maps, map_codes, group_totals: pri_groups,
                    account_totals: pri_accts, line_values: &pri_vals, vars };
                match (eval(&expr, &cc), eval(&expr, &pc)) {
                    (Ok(c), Ok(p)) => {
                        let (c, p) = if line.invert_sign { (-c, -p) } else { (c, p) };
                        current = Some(c); prior = Some(p);
                    }
                    (Err(e), _) | (_, Err(e)) => error = Some(e),
                }
            }
            "SUBTOTAL" => {
                let (c, p) = if let Some(expr) = &line.expression {
                    let cc = EvalContext { map_totals: cur_maps, map_codes, group_totals: cur_groups,
                        account_totals: cur_accts, line_values: &cur_vals, vars };
                    let pc = EvalContext { map_totals: pri_maps, map_codes, group_totals: pri_groups,
                        account_totals: pri_accts, line_values: &pri_vals, vars };
                    match (eval(expr, &cc), eval(expr, &pc)) {
                        (Ok(c), Ok(p)) => (c, p),
                        (Err(e), _) | (_, Err(e)) => { error = Some(e); (0.0, 0.0) }
                    }
                } else {
                    (*child_cur.get(&line.line_no).unwrap_or(&0.0),
                     *child_pri.get(&line.line_no).unwrap_or(&0.0))
                };
                let (c, p) = if line.invert_sign { (-c, -p) } else { (c, p) };
                current = Some(c); prior = Some(p);
            }
            other => error = Some(format!("Unknown line type '{other}'")),
        }

        if let (Some(c), Some(p)) = (current, prior) {
            cur_vals.insert(line.line_no, c);
            pri_vals.insert(line.line_no, p);
            if let Some(pl) = parent_lineno {
                *child_cur.entry(pl).or_insert(0.0) += c;
                *child_pri.entry(pl).or_insert(0.0) += p;
            }
        }

        resolved.push(ResolvedLine {
            line_no: line.line_no, depth, line_type: line.line_type.clone(),
            label: line.label.clone(), current, prior, text,
            bold: line.bold, underline: line.underline,
            show_prior: line.show_prior, error,
        });
    }
    Ok(resolved)
}

// ── render_package ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn render_package(
    package_id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<RenderPackageResult, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    // 1. Engagement + axis data
    let engagement = fetch_engagement(db)?;
    let (cur_maps, pri_maps, map_codes) = fetch_axis_maps(db)?;
    let (cur_groups, pri_groups) = fetch_group_maps(db)?;
    let (cur_accts, pri_accts) = fetch_account_maps(db)?;
    let vars = fetch_vars(db)?;

    // 2. Load assets -> data URIs
    let mut assets: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = db.conn.prepare("SELECT name, mime_type, data_base64 FROM doc_assets")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })? {
            let (name, mime, b64) = row?;
            assets.insert(name, format!("data:{};base64,{}", mime, b64));
        }
    }

    // 3. Load package items
    let items: Vec<(i64, String, Option<i64>, Option<i64>)> = {
        let mut pkg_item_stmt = db.conn.prepare(
            "SELECT id, item_kind, doc_template_id, statement_id
             FROM doc_package_items WHERE package_id=?1 ORDER BY sort_order, id",
        )?;
        let rows = pkg_item_stmt.query_map(params![package_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };

    // 4. Pre-resolve all statement-kind items (keyed by statement_id)
    let mut resolved_stmts: HashMap<i64, Vec<ResolvedLine>> = HashMap::new();
    // Also track statement_id -> kind for {{statement:kind}} tag resolution
    let mut stmt_kind_map: HashMap<String, i64> = HashMap::new();
    for (_, kind, _, stmt_id) in &items {
        if kind == "statement" {
            if let Some(sid) = stmt_id {
                if !resolved_stmts.contains_key(sid) {
                    let lines = resolve_statement_inline(
                        db, *sid,
                        &cur_maps, &pri_maps, &map_codes,
                        &cur_groups, &pri_groups,
                        &cur_accts, &pri_accts,
                        &vars,
                    )?;
                    // Look up this statement's kind for tag routing
                    let skind: String = db.conn.query_row(
                        "SELECT kind FROM statements WHERE id=?1", params![sid], |r| r.get(0)
                    ).unwrap_or_default();
                    // Map normalized kind string -> id
                    let tag_key = match skind.as_str() {
                        "BALANCE_SHEET"     => "balance_sheet",
                        "INCOME_STATEMENT"  => "income_statement",
                        "CASH_FLOW"         => "cash_flow",
                        "EQUITY"            => "equity",
                        _                   => "",
                    };
                    if !tag_key.is_empty() {
                        stmt_kind_map.insert(tag_key.to_string(), *sid);
                    }
                    resolved_stmts.insert(*sid, lines);
                }
            }
        }
    }
    // Also pre-load statement lines for any {{statement:kind}} tags in templates
    {
        let mut stmt = db.conn.prepare(
            "SELECT id, kind FROM statements"
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?)))? {
            let (sid, skind) = row?;
            if !resolved_stmts.contains_key(&sid) {
                let tag_key = match skind.as_str() {
                    "BALANCE_SHEET"     => "balance_sheet",
                    "INCOME_STATEMENT"  => "income_statement",
                    "CASH_FLOW"         => "cash_flow",
                    "EQUITY"            => "equity",
                    _                   => "",
                };
                if !tag_key.is_empty() && !stmt_kind_map.contains_key(tag_key) {
                    let lines = resolve_statement_inline(
                        db, sid, &cur_maps, &pri_maps, &map_codes,
                        &cur_groups, &pri_groups, &cur_accts, &pri_accts, &vars,
                    )?;
                    stmt_kind_map.insert(tag_key.to_string(), sid);
                    resolved_stmts.insert(sid, lines);
                }
            }
        }
    }

    // 5. PASS 1 — note discovery
    // Sub-pass A: scan all template bodies for note_def: tags first, in package
    // item order, so that note numbers are assigned by def location regardless of
    // where note_ref: tags appear (including in earlier templates or statement labels).
    let mut notes: HashMap<String, NoteEntry> = HashMap::new();
    let mut next_number: i32 = 1;

    for (_, kind, tmpl_id, _) in &items {
        if kind == "template" {
            if let Some(tid) = tmpl_id {
                let body: String = db.conn.query_row(
                    "SELECT body_html FROM doc_templates WHERE id=?1", params![tid], |r| r.get(0)
                ).unwrap_or_default();
                pass1_scan(&body, &mut notes, &mut next_number);
            }
        }
    }

    // Sub-pass B: scan statement labels for any note_def: tags embedded there.
    for (_, kind, _, stmt_id) in &items {
        if kind == "statement" {
            if let Some(sid) = stmt_id {
                if let Some(lines) = resolved_stmts.get(sid) {
                    let labels: String = lines.iter().map(|l| l.label.as_str()).collect::<Vec<_>>().join("\n");
                    pass1_scan(&labels, &mut notes, &mut next_number);
                }
            }
        }
    }

    // 6. Persist note registry
    {
        db.conn.execute("DELETE FROM doc_note_registry WHERE package_id=?1", params![package_id])?;
        for (key, entry) in &notes {
            db.conn.execute(
                "INSERT INTO doc_note_registry (package_id, note_key, note_number, title)
                 VALUES (?1, ?2, ?3, ?4)",
                params![package_id, key, entry.number, entry.title],
            )?;
        }
    }

    // 7. Build compositor context
    // Remap resolved_stmts so {{statement:kind}} tags route correctly
    // We use stmt_kind_map to build a kind-keyed secondary lookup inside dispatch_tag
    // by adding resolved lines for kind-string keys too.
    // For simplicity we include all resolved statements keyed by id.
    let ctx = CompositorCtx {
        engagement: engagement.clone(),
        vars,
        assets,
        notes,
        cur_maps,
        pri_maps,
        map_codes,
        cur_groups,
        pri_groups,
        cur_accts,
        pri_accts,
        resolved_statements: resolved_stmts,
        stmt_kind_map,
    };

    // 8. PASS 2 — render fragments
    let mut fragments: Vec<String> = Vec::new();
    for (_, kind, tmpl_id, stmt_id) in &items {
        if kind == "template" {
            if let Some(tid) = tmpl_id {
                let body: String = db.conn.query_row(
                    "SELECT body_html FROM doc_templates WHERE id=?1", params![tid], |r| r.get(0)
                ).unwrap_or_default();
                fragments.push(expand_tags(&body, &ctx));
            }
        } else if kind == "statement" {
            if let Some(sid) = stmt_id {
                if let Some(lines) = ctx.resolved_statements.get(sid) {
                    fragments.push(render_statement_lines_html(lines, &ctx));
                }
            }
        }
    }

    // 9. Build note registry output
    let mut note_registry: Vec<NoteInfo> = ctx.notes.iter().map(|(key, e)| NoteInfo {
        note_key: key.clone(),
        note_number: e.number,
        title: e.title.clone(),
    }).collect();
    note_registry.sort_by_key(|n| n.note_number);

    Ok(RenderPackageResult { fragments, note_registry, engagement })
}

// ── render_template (single template, body passed directly) ──────────────────
// Accepts the raw HTML body so the user can preview unsaved edits.

#[tauri::command]
pub async fn render_template(
    body_html: String,
    state: State<'_, AppState>,
) -> std::result::Result<String, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let engagement = fetch_engagement(db)?;
    let (cur_maps, pri_maps, map_codes) = fetch_axis_maps(db)?;
    let (cur_groups, pri_groups) = fetch_group_maps(db)?;
    let (cur_accts, pri_accts) = fetch_account_maps(db)?;
    let vars = fetch_vars(db)?;

    let mut assets: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = db.conn.prepare("SELECT name, mime_type, data_base64 FROM doc_assets")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })? {
            let (name, mime, b64) = row?;
            assets.insert(name, format!("data:{};base64,{}", mime, b64));
        }
    }

    // Resolve all statements so {{statement:kind}} tags work
    let mut resolved_stmts: HashMap<i64, Vec<ResolvedLine>> = HashMap::new();
    let mut stmt_kind_map: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt_list = db.conn.prepare("SELECT id, kind FROM statements")?;
        let id_kinds: Vec<(i64, String)> = stmt_list.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        for (sid, skind) in id_kinds {
            let lines = resolve_statement_inline(
                db, sid, &cur_maps, &pri_maps, &map_codes,
                &cur_groups, &pri_groups, &cur_accts, &pri_accts, &vars,
            )?;
            let tag_key = match skind.as_str() {
                "BALANCE_SHEET"    => "balance_sheet",
                "INCOME_STATEMENT" => "income_statement",
                "CASH_FLOW"        => "cash_flow",
                "EQUITY"           => "equity",
                _                  => "",
            };
            if !tag_key.is_empty() {
                stmt_kind_map.insert(tag_key.to_string(), sid);
            }
            resolved_stmts.insert(sid, lines);
        }
    }

    // Pass 1 — note discovery: scan ALL template bodies in the DB for note_def:
    // tags first (so defs in later templates are registered before refs in this
    // template are resolved), then scan statement labels.
    let mut notes: HashMap<String, NoteEntry> = HashMap::new();
    let mut next_number: i32 = 1;
    {
        let mut all_stmt = db.conn.prepare_cached(
            "SELECT body_html FROM doc_templates ORDER BY id"
        ).map_err(AppError::from)?;
        let bodies: Vec<String> = all_stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(AppError::from)?
            .flatten()
            .collect();
        for body in &bodies {
            pass1_scan(body, &mut notes, &mut next_number);
        }
    }
    for lines in resolved_stmts.values() {
        let labels: String = lines.iter().map(|l| l.label.as_str()).collect::<Vec<_>>().join("\n");
        pass1_scan(&labels, &mut notes, &mut next_number);
    }

    let ctx = CompositorCtx {
        engagement,
        vars,
        assets,
        notes,
        cur_maps,
        pri_maps,
        map_codes,
        cur_groups,
        pri_groups,
        cur_accts,
        pri_accts,
        resolved_statements: resolved_stmts,
        stmt_kind_map,
    };

    Ok(expand_tags(&body_html, &ctx))
}

// ── Seed default templates ────────────────────────────────────────────────────

#[tauri::command]
pub async fn seed_default_templates(
    state: State<'_, AppState>,
) -> std::result::Result<usize, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let existing: i64 =
        db.conn.query_row("SELECT COUNT(*) FROM doc_templates WHERE is_system=1", [], |r| r.get(0))?;
    if existing > 0 {
        return Ok(0);
    }

    let cover = r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Georgia, serif; margin: 80px; text-align: center;">
  {{image:firm_logo|width=200px}}
  <h1 style="margin-top: 60px; font-size: 2em;">{{entity_name}}</h1>
  <h2 style="font-weight: normal; color: #555;">Financial Statements</h2>
  <h2 style="font-weight: normal; color: #555;">For the Year Ended {{year_end}}</h2>
  <hr style="margin: 60px 0; border: none; border-top: 2px solid #000;" />
  <p style="color: #777; font-size: 0.9em;">Prepared by {{preparer_name}} on {{prepared_date}}</p>
</body>
</html>"#;

    let notes_skeleton = r#"<div class="notes-section" style="font-family: Georgia, serif; margin: 40px;">
  <h2>Notes to Financial Statements</h2>
  <p>For the Year Ended {{year_end}}</p>
  <hr />

  {{note_def:basis|title=Basis of Presentation}}
  <p>
    These financial statements have been prepared on the accrual basis of accounting
    in accordance with generally accepted accounting principles.
  </p>

  {{note_def:cash|title=Cash and Cash Equivalents}}
  <p>
    Cash and cash equivalents consist of cash on hand and highly liquid investments
    with original maturities of three months or less. As at {{year_end}},
    cash totalled {{SUM(1000..1099)}}.
  </p>

  <!-- Add more notes using {{note_def:key|title=Title}} -->
</div>"#;

    let mgmt_letter = r#"<div style="font-family: Arial, sans-serif; margin: 60px; max-width: 700px;">
  {{image:firm_logo|width=160px}}
  <p style="margin-top: 40px;">{{prepared_date}}</p>

  <p>To the Board of Directors of<br />
  <strong>{{entity_name}}</strong></p>

  <p>Dear Board Members,</p>

  <p>
    We have prepared the accompanying financial statements of {{entity_name}}
    for the year ended {{year_end}}, which comprise the balance sheet,
    statement of operations, and related notes.
  </p>

  <p>
    Net income for the year was {{SUM(4000..4999) - SUM(5000..6999) + SUM(7000..7999)}}.
    Total assets as at {{year_end}} were {{SUM(1000..1999)}}.
  </p>

  <p>Sincerely,</p>
  <br /><br />
  {{image:partner_sig|width=150px}}
  <p>{{V:engagement_partner}}<br />{{V:firm_name}}</p>
</div>"#;

    let balance_sheet = include_str!("../../../doc-templates/balance-sheet.html");

    let templates = [
        ("Cover Page", "COVER", cover),
        ("Balance Sheet", "FS_EMBED", balance_sheet),
        ("Notes to Financial Statements", "NOTES", notes_skeleton),
        ("Management Letter", "LETTER", mgmt_letter),
    ];

    for (name, kind, body) in &templates {
        db.conn.execute(
            "INSERT INTO doc_templates (name, kind, body_html, is_system) VALUES (?1, ?2, ?3, 1)",
            params![name, kind, body],
        )?;
    }

    Ok(templates.len())
}

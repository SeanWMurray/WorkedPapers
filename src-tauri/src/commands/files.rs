use crate::error::{AppError, Result};
use crate::AppState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::State;

// ── On-disk file metadata (unchanged) ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachedFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified: String,
    pub ext: String,
}

// ── File cabinet types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CabinetFolder {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CabinetItem {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub kind: String, // "file" | "leadsheet"
    pub display_name: String,
    pub file_path: Option<String>,
    pub leadsheet_scope: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Serialize)]
pub struct CabinetTree {
    pub folders: Vec<CabinetFolder>,
    pub items: Vec<CabinetItem>,
    /// All files present on disk, so the UI can show unregistered files too.
    pub disk_files: Vec<AttachedFile>,
}

// ── Disk helpers ──────────────────────────────────────────────────────────────

fn engagement_dir(state: &AppState) -> Result<String> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    let dir = Path::new(&db.path)
        .parent()
        .ok_or_else(|| AppError::Other("Cannot determine engagement directory".into()))?
        .to_string_lossy()
        .into_owned();
    Ok(dir)
}

fn read_disk_files(dir: &str) -> Vec<AttachedFile> {
    let dir_path = Path::new(dir);
    let Ok(entries) = fs::read_dir(dir_path) else {
        return vec![];
    };
    let mut files: Vec<AttachedFile> = entries
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if matches!(ext.as_str(), "db" | "db-wal" | "db-shm") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| {
                    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| {
                        let dt = chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                            .unwrap_or_default();
                        dt.format("%Y-%m-%d %H:%M").to_string()
                    })
                })
                .unwrap_or_default();
            Some(AttachedFile {
                name: path.file_name()?.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                size_bytes: meta.len(),
                modified,
                ext,
            })
        })
        .collect();
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

// ── Commands: legacy flat listing (still used by drag-drop attach path) ───────

#[tauri::command]
pub async fn list_attachments(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<AttachedFile>, AppError> {
    let dir = engagement_dir(&state)?;
    Ok(read_disk_files(&dir))
}

#[tauri::command]
pub async fn attach_file(
    source_path: String,
    state: State<'_, AppState>,
) -> std::result::Result<AttachedFile, AppError> {
    let dir = engagement_dir(&state)?;
    let dir_path = Path::new(&dir);
    let src = Path::new(&source_path);
    let file_name = src
        .file_name()
        .ok_or_else(|| AppError::Other("Invalid source path".into()))?;

    let dest = dir_path.join(file_name);
    let dest = if dest.exists() {
        let stem = src
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let ext = src
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut i = 1u32;
        loop {
            let candidate = dir_path.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() {
                break candidate;
            }
            i += 1;
        }
    } else {
        dest
    };

    fs::copy(&source_path, &dest)?;
    let meta = fs::metadata(&dest)?;
    let ext = dest
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();

    Ok(AttachedFile {
        name: dest.file_name().unwrap().to_string_lossy().into_owned(),
        path: dest.to_string_lossy().into_owned(),
        size_bytes: meta.len(),
        modified: String::new(),
        ext,
    })
}

#[tauri::command]
pub async fn remove_attachment(
    file_path: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let dir = engagement_dir(&state)?;
    let db_dir = Path::new(&dir);
    let target = Path::new(&file_path);
    if !target.starts_with(db_dir) {
        return Err(AppError::Other(
            "Cannot delete files outside the engagement directory".into(),
        ));
    }
    fs::remove_file(target)?;
    Ok(())
}

#[tauri::command]
pub async fn open_attachment(file_path: String) -> std::result::Result<(), AppError> {
    opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

// ── Commands: cabinet tree ────────────────────────────────────────────────────

/// Load the full cabinet tree + all disk files in one call.
#[tauri::command]
pub async fn get_cabinet(
    state: State<'_, AppState>,
) -> std::result::Result<CabinetTree, AppError> {
    let dir = engagement_dir(&state)?;
    let disk_files = read_disk_files(&dir);

    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let mut folder_stmt = db.conn.prepare(
        "SELECT id, name, parent_id, sort_order FROM file_cabinet_folders ORDER BY sort_order, name",
    )?;
    let folders = folder_stmt
        .query_map([], |r| {
            Ok(CabinetFolder {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                sort_order: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut item_stmt = db.conn.prepare(
        "SELECT id, folder_id, kind, display_name, file_path, leadsheet_scope, sort_order
         FROM file_cabinet_items ORDER BY sort_order, display_name",
    )?;
    let items = item_stmt
        .query_map([], |r| {
            Ok(CabinetItem {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                kind: r.get(2)?,
                display_name: r.get(3)?,
                file_path: r.get(4)?,
                leadsheet_scope: r.get(5)?,
                sort_order: r.get(6)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(CabinetTree { folders, items, disk_files })
}

// ── Folder CRUD ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_folder(
    name: String,
    parent_id: Option<i64>,
    state: State<'_, AppState>,
) -> std::result::Result<CabinetFolder, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    // sort_order = max sibling + 1
    let next_sort: i64 = db.conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM file_cabinet_folders WHERE parent_id IS ?1",
        params![parent_id],
        |r| r.get(0),
    )?;

    db.conn.execute(
        "INSERT INTO file_cabinet_folders (name, parent_id, sort_order) VALUES (?1, ?2, ?3)",
        params![name, parent_id, next_sort],
    )?;
    let id = db.conn.last_insert_rowid();
    Ok(CabinetFolder { id, name, parent_id, sort_order: next_sort })
}

#[tauri::command]
pub async fn rename_folder(
    id: i64,
    name: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.conn.execute(
        "UPDATE file_cabinet_folders SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn delete_folder(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    // ON DELETE CASCADE handles child folders; ON DELETE SET NULL orphans items to root
    db.conn.execute("DELETE FROM file_cabinet_folders WHERE id = ?1", params![id])?;
    Ok(())
}

// ── Item CRUD ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UpsertItemPayload {
    pub id: Option<i64>,
    pub folder_id: Option<i64>,
    pub kind: String,
    pub display_name: String,
    pub file_path: Option<String>,
    pub leadsheet_scope: Option<String>,
}

#[tauri::command]
pub async fn upsert_cabinet_item(
    payload: UpsertItemPayload,
    state: State<'_, AppState>,
) -> std::result::Result<CabinetItem, AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    if let Some(existing_id) = payload.id {
        db.conn.execute(
            "UPDATE file_cabinet_items
             SET folder_id = ?1, kind = ?2, display_name = ?3,
                 file_path = ?4, leadsheet_scope = ?5
             WHERE id = ?6",
            params![
                payload.folder_id,
                payload.kind,
                payload.display_name,
                payload.file_path,
                payload.leadsheet_scope,
                existing_id
            ],
        )?;
        let sort_order: i64 = db.conn.query_row(
            "SELECT sort_order FROM file_cabinet_items WHERE id = ?1",
            params![existing_id],
            |r| r.get(0),
        )?;
        Ok(CabinetItem {
            id: existing_id,
            folder_id: payload.folder_id,
            kind: payload.kind,
            display_name: payload.display_name,
            file_path: payload.file_path,
            leadsheet_scope: payload.leadsheet_scope,
            sort_order,
        })
    } else {
        let next_sort: i64 = db.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM file_cabinet_items WHERE folder_id IS ?1",
            params![payload.folder_id],
            |r| r.get(0),
        )?;
        db.conn.execute(
            "INSERT INTO file_cabinet_items
             (folder_id, kind, display_name, file_path, leadsheet_scope, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                payload.folder_id,
                payload.kind,
                payload.display_name,
                payload.file_path,
                payload.leadsheet_scope,
                next_sort
            ],
        )?;
        let id = db.conn.last_insert_rowid();
        Ok(CabinetItem {
            id,
            folder_id: payload.folder_id,
            kind: payload.kind,
            display_name: payload.display_name,
            file_path: payload.file_path,
            leadsheet_scope: payload.leadsheet_scope,
            sort_order: next_sort,
        })
    }
}

#[tauri::command]
pub async fn delete_cabinet_item(
    id: i64,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
    db.conn.execute("DELETE FROM file_cabinet_items WHERE id = ?1", params![id])?;
    Ok(())
}

/// Move an item to a new folder and/or position.
/// `after_id` = the item it should appear after (None = place first).
#[tauri::command]
pub async fn move_cabinet_item(
    id: i64,
    folder_id: Option<i64>,
    after_id: Option<i64>,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    let new_sort: i64 = if let Some(after) = after_id {
        let after_sort: i64 = db.conn.query_row(
            "SELECT sort_order FROM file_cabinet_items WHERE id = ?1",
            params![after],
            |r| r.get(0),
        )?;
        // Shift everything after the target up by 2 and insert in between
        db.conn.execute(
            "UPDATE file_cabinet_items SET sort_order = sort_order + 2
             WHERE folder_id IS ?1 AND sort_order > ?2 AND id != ?3",
            params![folder_id, after_sort, id],
        )?;
        after_sort + 1
    } else {
        // Place before everything in the target folder
        db.conn.execute(
            "UPDATE file_cabinet_items SET sort_order = sort_order + 2
             WHERE folder_id IS ?1 AND id != ?2",
            params![folder_id, id],
        )?;
        0
    };

    db.conn.execute(
        "UPDATE file_cabinet_items SET folder_id = ?1, sort_order = ?2 WHERE id = ?3",
        params![folder_id, new_sort, id],
    )?;
    Ok(())
}

/// Move a folder to a new parent and/or position.
#[tauri::command]
pub async fn move_cabinet_folder(
    id: i64,
    parent_id: Option<i64>,
    after_id: Option<i64>,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let guard = state.db.lock().unwrap();
    let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;

    // Guard against moving a folder into its own subtree
    // (walk up from parent_id; if we hit `id`, it's a cycle)
    if let Some(new_parent) = parent_id {
        let mut cursor = new_parent;
        loop {
            if cursor == id {
                return Err(AppError::Other("Cannot move a folder into itself".into()));
            }
            let maybe_parent: Option<i64> = db.conn.query_row(
                "SELECT parent_id FROM file_cabinet_folders WHERE id = ?1",
                params![cursor],
                |r| r.get(0),
            ).ok().flatten();
            match maybe_parent {
                Some(p) => cursor = p,
                None => break,
            }
        }
    }

    let new_sort: i64 = if let Some(after) = after_id {
        let after_sort: i64 = db.conn.query_row(
            "SELECT sort_order FROM file_cabinet_folders WHERE id = ?1",
            params![after],
            |r| r.get(0),
        )?;
        db.conn.execute(
            "UPDATE file_cabinet_folders SET sort_order = sort_order + 2
             WHERE parent_id IS ?1 AND sort_order > ?2 AND id != ?3",
            params![parent_id, after_sort, id],
        )?;
        after_sort + 1
    } else {
        db.conn.execute(
            "UPDATE file_cabinet_folders SET sort_order = sort_order + 2
             WHERE parent_id IS ?1 AND id != ?2",
            params![parent_id, id],
        )?;
        0
    };

    db.conn.execute(
        "UPDATE file_cabinet_folders SET parent_id = ?1, sort_order = ?2 WHERE id = ?3",
        params![parent_id, new_sort, id],
    )?;
    Ok(())
}

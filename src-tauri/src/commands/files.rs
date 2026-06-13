use crate::error::{AppError, Result};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachedFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified: String, // ISO timestamp
    pub ext: String,
}

/// List all files in the same directory as the open engagement .db
#[tauri::command]
pub async fn list_attachments(
    state: State<'_, AppState>,
) -> std::result::Result<Vec<AttachedFile>, AppError> {
    let db_path = {
        let guard = state.db.lock().unwrap();
        let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
        db.path.clone()
    };

    let dir = Path::new(&db_path)
        .parent()
        .ok_or_else(|| AppError::Other("Cannot determine engagement directory".into()))?;

    let mut files: Vec<AttachedFile> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            // Skip the .db itself and WAL files
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
                        let secs = d.as_secs();
                        // Format as ISO-ish: YYYY-MM-DD HH:MM
                        let dt = chrono::DateTime::from_timestamp(secs as i64, 0)
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
    Ok(files)
}

/// Copy a file into the engagement directory (the actual attach operation)
#[tauri::command]
pub async fn attach_file(
    source_path: String,
    state: State<'_, AppState>,
) -> std::result::Result<AttachedFile, AppError> {
    let db_path = {
        let guard = state.db.lock().unwrap();
        let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
        db.path.clone()
    };

    let dir = Path::new(&db_path)
        .parent()
        .ok_or_else(|| AppError::Other("Cannot determine engagement directory".into()))?;

    let src = Path::new(&source_path);
    let file_name = src
        .file_name()
        .ok_or_else(|| AppError::Other("Invalid source path".into()))?;

    let dest = dir.join(file_name);

    // Don't overwrite silently — append (1), (2) etc. if name collides
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
            let candidate = dir.join(format!("{stem} ({i}){ext}"));
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

/// Remove an attachment from the engagement directory (moves to recycle bin equivalent — actual delete)
#[tauri::command]
pub async fn remove_attachment(
    file_path: String,
    state: State<'_, AppState>,
) -> std::result::Result<(), AppError> {
    let db_path = {
        let guard = state.db.lock().unwrap();
        let db = guard.as_ref().ok_or(AppError::NoEngagementOpen)?;
        db.path.clone()
    };

    // Safety: only allow deleting files inside the engagement directory
    let db_dir = Path::new(&db_path)
        .parent()
        .ok_or_else(|| AppError::Other("Cannot determine engagement directory".into()))?;

    let target = Path::new(&file_path);
    if !target.starts_with(db_dir) {
        return Err(AppError::Other(
            "Cannot delete files outside the engagement directory".into(),
        ));
    }

    fs::remove_file(target)?;
    Ok(())
}

/// Open a file with the system default application
#[tauri::command]
pub async fn open_attachment(file_path: String) -> std::result::Result<(), AppError> {
    opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

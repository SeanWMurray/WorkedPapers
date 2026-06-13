use crate::error::{AppError, Result};
use crate::models::AppSettings;
use std::fs;
use std::path::PathBuf;

fn settings_path() -> PathBuf {
    // Store next to the binary in dev; use app data dir in release via env var override
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));

    base.join("WorkedPapers").join("settings.json")
}

#[tauri::command]
pub async fn get_settings() -> std::result::Result<AppSettings, AppError> {
    let path = settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path)?;
    let settings: AppSettings = serde_json::from_str(&raw)?;
    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(settings: AppSettings) -> std::result::Result<(), AppError> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&settings)?;
    fs::write(&path, json)?;
    Ok(())
}

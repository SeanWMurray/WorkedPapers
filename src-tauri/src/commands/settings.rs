use crate::error::{AppError, Result};
use crate::models::AppSettings;
use std::fs;
use std::path::PathBuf;
use tauri::api::path::app_data_dir;
use tauri::{Config, State};

fn settings_path(config: &Config) -> PathBuf {
    app_data_dir(config)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("settings.json")
}

#[tauri::command]
pub async fn get_settings(
    config: tauri::State<'_, std::sync::Arc<Config>>,
) -> std::result::Result<AppSettings, AppError> {
    let path = settings_path(&config);
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = fs::read_to_string(&path)?;
    let settings: AppSettings = serde_json::from_str(&raw)?;
    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    config: tauri::State<'_, std::sync::Arc<Config>>,
) -> std::result::Result<(), AppError> {
    let path = settings_path(&config);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&settings)?;
    fs::write(&path, json)?;
    Ok(())
}

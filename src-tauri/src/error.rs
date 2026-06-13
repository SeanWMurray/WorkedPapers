use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("CSV error: {0}")]
    Csv(#[from] csv::Error),

    #[error("Engagement locked — no further edits permitted")]
    EngagementLocked,

    #[error("No engagement is currently open")]
    NoEngagementOpen,

    #[error("Invalid credentials")]
    InvalidCredentials,

    #[error("Encryption error: {0}")]
    Encryption(String),

    #[error("{0}")]
    Other(String),
}

// Tauri requires errors to be serializable so they can cross the IPC bridge
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

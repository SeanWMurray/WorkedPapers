use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ─── Engagement ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngagementMeta {
    pub id: String,
    pub entity_name: String,
    pub year_end: String,      // ISO date: "2024-12-31"
    pub fiscal_year: i32,
    pub currency: String,      // "USD", "CAD", etc.
    pub is_locked: bool,
    pub created_at: DateTime<Utc>,
    pub db_path: String,
}

// ─── Trial Balance ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TbAccount {
    pub id: i64,
    pub account_number: String,
    pub account_name: String,
    pub current_balance: f64,
    pub prior_balance: f64,
    pub map_number: Option<String>,
    pub grouping_ids: Vec<i64>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TbSummary {
    pub total_debits: f64,
    pub total_credits: f64,
    pub is_balanced: bool,
}

// ─── Adjusting Journal Entries ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Aje {
    pub id: i64,
    pub aje_number: String,     // e.g. "AJE-001", "RJE-001", "TJE-001"
    pub entry_type: AjeType,
    pub description: String,
    pub lines: Vec<AjeLine>,
    pub prepared_by: String,
    pub posted_at: DateTime<Utc>,
    pub is_voided: bool,
    pub voided_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AjeType {
    Adjusting,
    Reclassifying,
    Tax,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AjeLine {
    pub id: i64,
    pub aje_id: i64,
    pub account_number: String,
    pub debit: f64,
    pub credit: f64,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AjeImpact {
    pub account_number: String,
    pub account_name: String,
    pub original_balance: f64,
    pub aje_adjustment: f64,
    pub adjusted_balance: f64,
}

// ─── Mapping & Groupings ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapNumber {
    pub code: String,           // e.g. "1000", "2100"
    pub label: String,
    pub parent_code: Option<String>,
    pub sort_order: i32,
    pub fs_line: Option<String>, // which financial statement line this maps to
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grouping {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,  // hex color for UI label
}

// ─── Leadsheets ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Leadsheet {
    pub map_number: Option<String>,
    pub grouping_id: Option<i64>,
    pub title: String,
    pub accounts: Vec<TbAccount>,
    pub aje_lines: Vec<AjeLine>,
    pub notes: Option<String>,
    pub tickmarks: Vec<Tickmark>,
    pub signoffs: Vec<Signoff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tickmark {
    pub id: i64,
    pub symbol: String,         // "✓", "†", custom char, or emoji key
    pub description: String,
    pub anchor: String,         // account_number or doc_ref the tickmark is attached to
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

// ─── Sign-offs & Audit Trail ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signoff {
    pub id: i64,
    pub scope: String,          // "leadsheet:<map>", "engagement", etc.
    pub role: SignoffRole,
    pub signed_by: String,
    pub signed_at: DateTime<Utc>,
    pub signature_hash: String, // SHA-256 of (scope + role + signed_by + timestamp)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SignoffRole {
    Preparer,
    Reviewer,
    Partner,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: i64,
    pub action: String,
    pub entity: String,         // "aje", "account", "signoff", etc.
    pub entity_id: String,
    pub performed_by: String,
    pub performed_at: DateTime<Utc>,
    pub detail: serde_json::Value,
}

// ─── Reports ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportData {
    pub engagement: EngagementMeta,
    pub map_totals: Vec<MapTotal>,
    pub custom_vars: Vec<CustomVar>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapTotal {
    pub map_number: String,
    pub label: String,
    pub current_total: f64,
    pub prior_total: f64,
    pub adjusted_current: f64,  // after AJEs
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomVar {
    pub key: String,
    pub value: String,
    pub description: Option<String>,
}

// ─── Settings ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub user_name: String,
    pub user_initials: String,
    pub default_currency: String,
    pub theme: String,          // "light" | "dark"
    pub recent_files: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            user_name: "Test User".to_string(),
            user_initials: "TU".to_string(),
            default_currency: "USD".to_string(),
            theme: "light".to_string(),
            recent_files: vec![],
        }
    }
}

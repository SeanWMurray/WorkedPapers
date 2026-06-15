use chrono::{DateTime, NaiveDateTime, Utc};
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

/// Parse a timestamp stored by SQLite. Handles both `datetime('now')` output
/// (`YYYY-MM-DD HH:MM:SS`, UTC, no tz) and RFC3339 strings written by Rust.
/// Falls back to "now" only if the value is genuinely unparseable.
pub fn parse_db_datetime(s: &str) -> DateTime<Utc> {
    if let Ok(dt) = s.parse::<DateTime<Utc>>() {
        return dt;
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return naive.and_utc();
    }
    Utc::now()
}

/// Shared row mapper for `EngagementMeta`. Every call site selects the same
/// seven columns in this order:
///   id, entity_name, year_end, fiscal_year, currency, is_locked, created_at
/// Centralizing this prevents the `created_at` field from being fabricated
/// (the bug fixed in B2) and keeps the mapping consistent.
pub fn map_engagement_row(
    row: &rusqlite::Row<'_>,
    db_path: String,
) -> rusqlite::Result<EngagementMeta> {
    Ok(EngagementMeta {
        id: row.get(0)?,
        entity_name: row.get(1)?,
        year_end: row.get(2)?,
        fiscal_year: row.get(3)?,
        currency: row.get(4)?,
        is_locked: row.get::<_, i32>(5)? != 0,
        created_at: parse_db_datetime(&row.get::<_, String>(6)?),
        db_path,
    })
}

/// The canonical column list for `map_engagement_row`, to keep SELECTs in sync.
pub const ENGAGEMENT_COLUMNS: &str =
    "id, entity_name, year_end, fiscal_year, currency, is_locked, created_at";

// ─── Trial Balance ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TbAccount {
    pub id: i64,
    pub account_number: String,
    pub account_name: String,
    /// Raw imported balance — no AJEs applied.
    pub prelim_balance: f64,
    pub prior_balance: f64,
    /// Net of ADJUSTING-type entries only.
    pub adjustment_net: f64,
    /// Net of RECLASSIFYING-type entries only.
    pub reclass_net: f64,
    /// Net of TAX-type entries only.
    pub tax_net: f64,
    /// prelim + all entry nets — used by the report engine and leadsheets.
    pub current_balance: f64,
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
    pub code: String,
    pub label: String,
    pub parent_code: Option<String>,
    pub sort_order: i32,
    pub fs_line: Option<String>,
    pub default_grouping_id: Option<i64>,
    pub flip_map_code: Option<String>,
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
    pub scope: String,
    pub role: SignoffRole,
    pub signed_by: String,
    pub signed_initials: String,
    pub signed_at: DateTime<Utc>,
    pub signature_hash: String,
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

// ─── Report Engine ─────────────────────────────────────────────────────────────
// A statement is a stored, ordered tree of typed lines. Amounts are resolved from
// map totals / custom vars / formulas by the engine, not hardcoded per statement.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Statement {
    pub id: i64,
    pub name: String,
    pub kind: String,           // BALANCE_SHEET | INCOME_STATEMENT | CASH_FLOW | EQUITY | CUSTOM
    pub sort_order: i32,
    pub lines: Vec<StatementLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatementLine {
    pub id: i64,
    pub statement_id: i64,
    pub parent_id: Option<i64>,
    pub line_no: i64,           // stable reference id used by L: formulas
    pub sort_order: i32,
    pub line_type: String,      // HEADER | MAP | FORMULA | SUBTOTAL | VAR | SPACER
    pub label: String,
    pub expression: Option<String>,
    pub bold: bool,
    pub underline: bool,
    pub show_prior: bool,
    pub invert_sign: bool,
}

/// A statement after the engine has evaluated every line into concrete amounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedStatement {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub engagement: EngagementMeta,
    pub lines: Vec<ResolvedLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedLine {
    pub line_no: i64,
    pub depth: i32,             // nesting depth for indentation
    pub line_type: String,
    pub label: String,
    pub current: Option<f64>,   // None = no amount (HEADER / SPACER / VAR-text)
    pub prior: Option<f64>,
    pub text: Option<String>,   // for VAR lines: the resolved variable text
    pub bold: bool,
    pub underline: bool,
    pub show_prior: bool,
    pub error: Option<String>,  // formula/reference error, if any
}

// ─── Document Template Engine ────────────────────────────────────────────────
// Free-form HTML templates with {{ }} tag expansion. Templates are assembled
// into ordered packages that render as a single printable document.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocAsset {
    pub id: i64,
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub width_px: Option<i64>,
    pub height_px: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocTemplate {
    pub id: i64,
    pub name: String,
    pub kind: String,           // COVER | LETTER | NOTES | FS_EMBED | CUSTOM
    pub body_html: String,
    pub description: Option<String>,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocPackage {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocPackageItem {
    pub id: i64,
    pub package_id: i64,
    pub sort_order: i32,
    pub item_kind: String,      // "template" | "statement"
    pub doc_template_id: Option<i64>,
    pub statement_id: Option<i64>,
    pub var_overrides: String,  // JSON text
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteInfo {
    pub note_key: String,
    pub note_number: i32,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderPackageResult {
    pub fragments: Vec<String>,
    pub note_registry: Vec<NoteInfo>,
    pub engagement: EngagementMeta,
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

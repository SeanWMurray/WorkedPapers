// ─── Shared domain types mirroring the Rust models ────────────────────────────
// Keep in sync with src-tauri/src/models.rs

export type AjeType = "ADJUSTING" | "RECLASSIFYING" | "TAX";

export type SignoffRole = "PREPARER" | "REVIEWER" | "PARTNER";

export interface EngagementMeta {
  id: string;
  entity_name: string;
  year_end: string;
  fiscal_year: number;
  currency: string;
  is_locked: boolean;
  created_at: string;
  db_path: string;
}

export interface TbAccount {
  id: number;
  account_number: string;
  account_name: string;
  /** Raw imported balance — no entries applied. */
  prelim_balance: number;
  prior_balance: number;
  /** Net of ADJUSTING-type entries. */
  adjustment_net: number;
  /** Net of RECLASSIFYING-type entries. */
  reclass_net: number;
  /** Net of TAX-type entries. */
  tax_net: number;
  /** prelim + all nets — alias kept for report engine / leadsheet compatibility. */
  current_balance: number;
  map_number: string | null;
  grouping_ids: number[];
  notes: string | null;
}

export interface TbSummary {
  total_debits: number;
  total_credits: number;
  is_balanced: boolean;
}

export interface AjeLine {
  id: number;
  aje_id: number;
  account_number: string;
  debit: number;
  credit: number;
  description: string | null;
}

export interface Aje {
  id: number;
  aje_number: string;
  entry_type: AjeType;
  description: string;
  lines: AjeLine[];
  prepared_by: string;
  posted_at: string;
  is_voided: boolean;
  voided_reason: string | null;
}

export interface AjeImpact {
  account_number: string;
  account_name: string;
  original_balance: number;
  aje_adjustment: number;
  adjusted_balance: number;
}

export interface MapNumber {
  code: string;
  label: string;
  parent_code: string | null;
  sort_order: number;
  fs_line: string | null;
  default_grouping_id: number | null;
  flip_map_code: string | null;
}

export interface Grouping {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
}

export interface Tickmark {
  id: number;
  symbol: string;
  description: string;
  anchor: string;
  created_by: string;
  created_at: string;
}

export interface Signoff {
  id: number;
  scope: string;
  role: SignoffRole;
  signed_by: string;
  signed_initials: string;
  signed_at: string;
  signature_hash: string;
}

export interface Leadsheet {
  map_number: string | null;
  grouping_id: number | null;
  title: string;
  accounts: TbAccount[];
  aje_lines: AjeLine[];
  notes: string | null;
  tickmarks: Tickmark[];
  signoffs: Signoff[];
}

export interface MapTotal {
  map_number: string;
  label: string;
  current_total: number;
  prior_total: number;
  adjusted_current: number;
}

export interface CustomVar {
  key: string;
  value: string;
  description: string | null;
}

export interface ReportData {
  engagement: EngagementMeta;
  map_totals: MapTotal[];
  custom_vars: CustomVar[];
}

// ─── Report Engine (programmable statements) ──────────────────────────────────
// A statement is a stored, ordered tree of typed lines. Amounts are resolved
// from map totals / custom vars / formulas by the engine, not hardcoded.

export type StatementKind =
  | "BALANCE_SHEET"
  | "INCOME_STATEMENT"
  | "CASH_FLOW"
  | "EQUITY"
  | "CUSTOM";

export type LineType =
  | "HEADER"
  | "MAP"
  | "FORMULA"
  | "SUBTOTAL"
  | "VAR"
  | "SPACER";

export interface StatementLine {
  id: number;
  statement_id: number;
  parent_id: number | null;
  line_no: number; // stable reference id used by L: formulas
  sort_order: number;
  line_type: LineType;
  label: string;
  expression: string | null;
  bold: boolean;
  underline: boolean;
  show_prior: boolean;
  invert_sign: boolean;
}

export interface Statement {
  id: number;
  name: string;
  kind: StatementKind;
  sort_order: number;
  lines: StatementLine[];
}

export interface ResolvedLine {
  line_no: number;
  depth: number;
  line_type: LineType;
  label: string;
  current: number | null;
  prior: number | null;
  text: string | null;
  bold: boolean;
  underline: boolean;
  show_prior: boolean;
  error: string | null;
}

export interface ResolvedStatement {
  id: number;
  name: string;
  kind: StatementKind;
  engagement: EngagementMeta;
  lines: ResolvedLine[];
}

// ─── Document Template Engine ─────────────────────────────────────────────────

export interface DocAsset {
  id: number;
  name: string;
  mime_type: string;
  data_base64: string;
  width_px: number | null;
  height_px: number | null;
}

export interface DocTemplate {
  id: number;
  name: string;
  /** COVER | LETTER | NOTES | FS_EMBED | CUSTOM */
  kind: string;
  body_html: string;
  description: string | null;
  is_system: boolean;
}

export interface DocPackage {
  id: number;
  name: string;
  description: string | null;
}

export interface DocPackageItem {
  id: number;
  package_id: number;
  sort_order: number;
  /** "template" | "statement" */
  item_kind: string;
  doc_template_id: number | null;
  statement_id: number | null;
  /** JSON string of per-item variable overrides */
  var_overrides: string;
}

export interface NoteInfo {
  note_key: string;
  note_number: number;
  title: string | null;
}

export interface RenderPackageResult {
  fragments: string[];
  note_registry: NoteInfo[];
  engagement: EngagementMeta;
}

export interface AppSettings {
  user_name: string;
  user_initials: string;
  default_currency: string;
  theme: "light" | "dark";
  recent_files: string[];
}

export interface AttachedFile {
  name: string;
  path: string;
  size_bytes: number;
  modified: string;
  ext: string;
}

export interface CabinetFolder {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
}

export interface CabinetItem {
  id: number;
  folder_id: number | null;
  kind: "file" | "leadsheet" | "document";
  display_name: string;
  file_path: string | null;
  leadsheet_scope: string | null;
  doc_template_id: number | null;
  sort_order: number;
}

export interface CabinetTree {
  folders: CabinetFolder[];
  items: CabinetItem[];
  disk_files: AttachedFile[];
}

export interface AuditEntry {
  id: number;
  action: string;
  entity: string;
  entity_id: string;
  performed_by: string;
  performed_at: string;
  detail: unknown;
}

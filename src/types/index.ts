// ─── Shared domain types mirroring the Rust models ────────────────────────────
// Keep in sync with src-tauri/src/models.rs

export type AccountType =
  | "ASSET"
  | "LIABILITY"
  | "EQUITY"
  | "REVENUE"
  | "EXPENSE"
  | "OTHER_INCOME"
  | "OTHER_EXPENSE";

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
  account_type: AccountType;
  current_balance: number;
  prior_balance: number;
  map_number: string | null;
  grouping_ids: number[];
  notes: string | null;
}

export interface TbSummary {
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
  total_revenue: number;
  total_expenses: number;
  net_income: number;
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

export interface AppSettings {
  user_name: string;
  user_initials: string;
  default_currency: string;
  theme: "light" | "dark";
  recent_files: string[];
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

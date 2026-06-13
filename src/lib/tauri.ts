import { invoke } from "@tauri-apps/api/tauri";
import { open, save } from "@tauri-apps/api/dialog";
import type {
  Aje,
  AjeImpact,
  AppSettings,
  AuditEntry,
  EngagementMeta,
  Grouping,
  Leadsheet,
  LeadsheetQuery,
  MapNumber,
  ReportData,
  Signoff,
  TbAccount,
  TbSummary,
} from "@/types";

// Re-export dialog helpers
export { open, save };

// ─── Engagement ───────────────────────────────────────────────────────────────

export const openEngagement = (path: string) =>
  invoke<EngagementMeta>("open_engagement", { path });

export const createEngagement = (payload: {
  db_path: string;
  entity_name: string;
  year_end: string;
  fiscal_year: number;
  currency: string;
}) => invoke<EngagementMeta>("create_engagement", { payload });

export const closeEngagement = () => invoke<void>("close_engagement");

export const getEngagementMeta = () => invoke<EngagementMeta>("get_engagement_meta");

// ─── Trial Balance ────────────────────────────────────────────────────────────

export const importTbCsv = (rows: {
  account_number: string;
  account_name: string;
  account_type: string;
  current_balance: number;
  prior_balance: number;
}[]) => invoke<number>("import_tb_csv", { rows });

export const getTbAccounts = () => invoke<TbAccount[]>("get_tb_accounts");

export const updateAccountMapping = (account_number: string, map_number: string | null) =>
  invoke<void>("update_account_mapping", { account_number, map_number });

export const getTbSummary = () => invoke<TbSummary>("get_tb_summary");

// ─── AJEs ─────────────────────────────────────────────────────────────────────

export const listAjes = () => invoke<Aje[]>("list_ajes");

export const postAje = (payload: {
  entry_type: string;
  description: string;
  prepared_by: string;
  lines: { account_number: string; debit: number; credit: number; description?: string }[];
}) => invoke<number>("post_aje", { payload });

export const voidAje = (aje_id: number, reason: string, voided_by: string) =>
  invoke<void>("void_aje", { aje_id, reason, voided_by });

export const getAjeImpact = () => invoke<AjeImpact[]>("get_aje_impact");

// ─── Mapping ──────────────────────────────────────────────────────────────────

export const listMapNumbers = () => invoke<MapNumber[]>("list_map_numbers");

export const upsertMapNumber = (payload: {
  code: string;
  label: string;
  parent_code?: string | null;
  sort_order: number;
  fs_line?: string | null;
}) => invoke<void>("upsert_map_number", { payload });

export const listGroupings = () => invoke<Grouping[]>("list_groupings");

export const upsertGrouping = (payload: {
  id?: number | null;
  name: string;
  description?: string | null;
  color?: string | null;
}) => invoke<number>("upsert_grouping", { payload });

export const assignGrouping = (
  account_number: string,
  grouping_id: number,
  assign: boolean
) => invoke<void>("assign_grouping", { account_number, grouping_id, assign });

// ─── Leadsheets ───────────────────────────────────────────────────────────────

export const getLeadsheet = (query: { map_number?: string; grouping_id?: number }) =>
  invoke<Leadsheet>("get_leadsheet", { query });

export const saveLeadsheetNote = (scope: string, content: string, updated_by: string) =>
  invoke<void>("save_leadsheet_note", { scope, content, updated_by });

export const addTickmark = (
  symbol: string,
  description: string,
  anchor: string,
  created_by: string
) => invoke<number>("add_tickmark", { symbol, description, anchor, created_by });

export const removeTickmark = (id: number) => invoke<void>("remove_tickmark", { id });

// ─── Sign-offs & Audit ────────────────────────────────────────────────────────

export const signOff = (scope: string, role: string, signed_by: string) =>
  invoke<number>("sign_off", { scope, role, signed_by });

export const getSignoffs = (scope?: string) =>
  invoke<Signoff[]>("get_signoffs", { scope: scope ?? null });

export const lockEngagement = (locked_by: string) =>
  invoke<string>("lock_engagement", { locked_by });

export const getAuditTrail = (limit?: number) =>
  invoke<AuditEntry[]>("get_audit_trail", { limit: limit ?? null });

// ─── Reports ─────────────────────────────────────────────────────────────────

export const renderReportData = () => invoke<ReportData>("render_report_data");

// ─── Archive (.wwp) ───────────────────────────────────────────────────────────

export const exportWwp = (output_path: string, password: string) =>
  invoke<void>("export_wwp", { output_path, password });

export const importWwp = (wwp_path: string, target_dir: string, password: string) =>
  invoke<string>("import_wwp", { wwp_path, target_dir, password });

// ─── Roll-Forward ─────────────────────────────────────────────────────────────

export const rollForward = (payload: {
  new_db_path: string;
  new_year_end: string;
  new_fiscal_year: number;
}) => invoke<string>("roll_forward", { payload });

// ─── Settings ─────────────────────────────────────────────────────────────────

export const getSettings = () => invoke<AppSettings>("get_settings");
export const saveSettings = (settings: AppSettings) =>
  invoke<void>("save_settings", { settings });

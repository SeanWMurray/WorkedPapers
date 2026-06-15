import { invoke } from "@tauri-apps/api/tauri";
import { open, save } from "@tauri-apps/api/dialog";
import type {
  Aje,
  AjeImpact,
  AppSettings,
  AttachedFile,
  AuditEntry,
  CabinetFolder,
  CabinetItem,
  CabinetTree,
  DocAsset,
  DocPackage,
  DocPackageItem,
  DocTemplate,
  EngagementMeta,
  Grouping,
  Leadsheet,
  MapNumber,
  NoteInfo,
  ReportData,
  RenderPackageResult,
  ResolvedStatement,
  Signoff,
  Statement,
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
  current_balance: number;
  prior_balance: number;
}[]) => invoke<number>("import_tb_csv", { rows });

export const getTbAccounts = () => invoke<TbAccount[]>("get_tb_accounts");

export const updateAccountMapping = (accountNumber: string, mapNumber: string | null) =>
  invoke<void>("update_account_mapping", { accountNumber, mapNumber });

export const updateAccountMeta = (oldAccountNumber: string, accountNumber: string, accountName: string) =>
  invoke<void>("update_account_meta", { oldAccountNumber, accountNumber, accountName });

export const updateAccountBalance = (accountNumber: string, prelimBalance: number, priorBalance: number) =>
  invoke<void>("update_account_balance", { accountNumber, prelimBalance, priorBalance });

export const createAccount = (payload: {
  account_number: string;
  account_name: string;
  prelim_balance: number;
  prior_balance: number;
  map_number?: string | null;
}) => invoke<void>("create_account", { payload });

export const getTbSummary = () => invoke<TbSummary>("get_tb_summary");

// ─── AJEs ─────────────────────────────────────────────────────────────────────

export const listAjes = () => invoke<Aje[]>("list_ajes");

export const postAje = (payload: {
  entry_type: string;
  description: string;
  prepared_by: string;
  lines: { account_number: string; debit: number; credit: number; description?: string }[];
}) => invoke<number>("post_aje", { payload });

export const updateAje = (ajeId: number, payload: {
  entry_type: string;
  description: string;
  prepared_by: string;
  lines: { account_number: string; debit: number; credit: number; description?: string }[];
}) => invoke<void>("update_aje", { ajeId, payload });

export const voidAje = (ajeId: number, reason: string, voidedBy: string) =>
  invoke<void>("void_aje", { ajeId, reason, voidedBy });

export const getAjeImpact = () => invoke<AjeImpact[]>("get_aje_impact");

// ─── Mapping ──────────────────────────────────────────────────────────────────

export const listMapNumbers = () => invoke<MapNumber[]>("list_map_numbers");

export const upsertMapNumber = (payload: {
  code: string;
  label: string;
  parent_code?: string | null;
  sort_order: number;
  fs_line?: string | null;
  default_grouping_id?: number | null;
  flip_map_code?: string | null;
}) => invoke<void>("upsert_map_number", { payload });

export const deleteMapNumber = (code: string) =>
  invoke<void>("delete_map_number", { code });

export const deleteGrouping = (id: number) =>
  invoke<void>("delete_grouping", { id });

export const listGroupings = () => invoke<Grouping[]>("list_groupings");

export const upsertGrouping = (payload: {
  id?: number | null;
  name: string;
  description?: string | null;
  color?: string | null;
}) => invoke<number>("upsert_grouping", { payload });

export const assignGrouping = (
  accountNumber: string,
  groupingId: number,
  assign: boolean
) => invoke<void>("assign_grouping", { accountNumber, groupingId, assign });

// ─── Leadsheets ───────────────────────────────────────────────────────────────

export const getLeadsheet = (query: { map_number?: string; grouping_id?: number }) =>
  invoke<Leadsheet>("get_leadsheet", { query });

export const saveLeadsheetNote = (scope: string, content: string, updatedBy: string) =>
  invoke<void>("save_leadsheet_note", { scope, content, updatedBy });

export const getAnnotations = (scope: string) =>
  invoke<import("@/types").LeadsheetAnnotation[]>("get_annotations", { scope });

export const upsertAnnotation = (payload: {
  account_number: string;
  scope: string;
  note: string | null;
  cabinet_item_id: number | null;
}, updatedBy: string) =>
  invoke<void>("upsert_annotation", { payload, updatedBy });

export const addTickmark = (
  symbol: string,
  description: string,
  anchor: string,
  createdBy: string
) => invoke<number>("add_tickmark", { symbol, description, anchor, createdBy });

export const removeTickmark = (id: number) => invoke<void>("remove_tickmark", { id });

// ─── Sign-offs & Audit ────────────────────────────────────────────────────────

export const signOff = (scope: string, role: string, signedBy: string, signedInitials: string) =>
  invoke<number>("sign_off", { scope, role, signedBy, signedInitials });

export const removeSignoff = (id: number, removedBy: string) =>
  invoke<void>("remove_signoff", { id, removedBy });

export const getSignoffs = (scope?: string) =>
  invoke<Signoff[]>("get_signoffs", { scope: scope ?? null });

export const lockEngagement = (lockedBy: string) =>
  invoke<string>("lock_engagement", { lockedBy });

export const verifyIntegrity = () =>
  invoke<string>("verify_integrity");

export const getAuditTrail = (limit?: number) =>
  invoke<AuditEntry[]>("get_audit_trail", { limit: limit ?? null });

// ─── Reports ─────────────────────────────────────────────────────────────────

export const renderReportData = () => invoke<ReportData>("render_report_data");

// ─── Report Engine (programmable statements) ──────────────────────────────────

export const listStatements = () => invoke<Statement[]>("list_statements");

export const resolveStatement = (statementId: number) =>
  invoke<ResolvedStatement>("resolve_statement", { statementId });

export const upsertStatement = (payload: {
  id?: number | null;
  name: string;
  kind: string;
}) => invoke<number>("upsert_statement", { payload });

export const deleteStatement = (id: number) =>
  invoke<void>("delete_statement", { id });

export const upsertStatementLine = (payload: {
  id?: number | null;
  statement_id: number;
  parent_id?: number | null;
  line_type: string;
  label: string;
  expression?: string | null;
  bold: boolean;
  underline: boolean;
  show_prior: boolean;
  invert_sign: boolean;
}) => invoke<number>("upsert_statement_line", { payload });

export const deleteStatementLine = (id: number) =>
  invoke<void>("delete_statement_line", { id });

export const reorderStatementLines = (orderedIds: number[]) =>
  invoke<void>("reorder_statement_lines", { orderedIds });

export const seedDefaultStatements = () =>
  invoke<number>("seed_default_statements");

// ─── Archive (.wwp) ───────────────────────────────────────────────────────────

export const exportWwp = (outputPath: string, password: string) =>
  invoke<void>("export_wwp", { outputPath, password });

export const importWwp = (wwpPath: string, targetDir: string, password: string) =>
  invoke<string>("import_wwp", { wwpPath, targetDir, password });

// ─── Roll-Forward ─────────────────────────────────────────────────────────────

export const rollForward = (payload: {
  new_db_path: string;
  new_year_end: string;
  new_fiscal_year: number;
}) => invoke<string>("roll_forward", { payload });

// ─── File Attachments ─────────────────────────────────────────────────────────

export const listAttachments = () => invoke<AttachedFile[]>("list_attachments");

export const attachFile = (sourcePath: string) =>
  invoke<AttachedFile>("attach_file", { sourcePath });

export const removeAttachment = (filePath: string) =>
  invoke<void>("remove_attachment", { filePath });

export const openAttachment = (filePath: string) =>
  invoke<void>("open_attachment", { filePath });

// ─── File Cabinet ─────────────────────────────────────────────────────────────

export const getCabinet = () => invoke<CabinetTree>("get_cabinet");

export const createFolder = (name: string, parentId: number | null) =>
  invoke<CabinetFolder>("create_folder", { name, parentId });

export const renameFolder = (id: number, name: string) =>
  invoke<void>("rename_folder", { id, name });

export const deleteFolder = (id: number) =>
  invoke<void>("delete_folder", { id });

export const upsertCabinetItem = (payload: {
  id?: number | null;
  folder_id: number | null;
  kind: "file" | "leadsheet" | "document";
  display_name: string;
  file_path?: string | null;
  leadsheet_scope?: string | null;
  doc_template_id?: number | null;
}) => invoke<CabinetItem>("upsert_cabinet_item", { payload });

export const deleteCabinetItem = (id: number) =>
  invoke<void>("delete_cabinet_item", { id });

export const moveCabinetItem = (id: number, folderId: number | null, afterId: number | null) =>
  invoke<void>("move_cabinet_item", { id, folderId, afterId });

export const moveCabinetFolder = (id: number, parentId: number | null, afterId: number | null) =>
  invoke<void>("move_cabinet_folder", { id, parentId, afterId });

// ─── Settings ─────────────────────────────────────────────────────────────────

export const getSettings = () => invoke<AppSettings>("get_settings");
export const saveSettings = (settings: AppSettings) =>
  invoke<void>("save_settings", { settings });

// ─── Document Template Engine ─────────────────────────────────────────────────

// Assets
export const upsertDocAsset = (payload: {
  id?: number | null;
  name: string;
  mime_type: string;
  data_base64: string;
  width_px?: number | null;
  height_px?: number | null;
}) => invoke<number>("upsert_doc_asset", { payload });

export const listDocAssets = () => invoke<DocAsset[]>("list_doc_assets");

export const deleteDocAsset = (id: number) =>
  invoke<void>("delete_doc_asset", { id });

// Templates
export const upsertDocTemplate = (payload: {
  id?: number | null;
  name: string;
  kind: string;
  body_html: string;
  description?: string | null;
}) => invoke<number>("upsert_doc_template", { payload });

export const listDocTemplates = () => invoke<DocTemplate[]>("list_doc_templates");

export const getDocTemplate = (id: number) =>
  invoke<DocTemplate>("get_doc_template", { id });

export const deleteDocTemplate = (id: number) =>
  invoke<void>("delete_doc_template", { id });

// Packages
export const upsertDocPackage = (payload: {
  id?: number | null;
  name: string;
  description?: string | null;
}) => invoke<number>("upsert_doc_package", { payload });

export const listDocPackages = () => invoke<DocPackage[]>("list_doc_packages");

export const deleteDocPackage = (id: number) =>
  invoke<void>("delete_doc_package", { id });

// Package items
export const upsertPackageItem = (payload: {
  id?: number | null;
  package_id: number;
  sort_order: number;
  item_kind: "template" | "statement";
  doc_template_id?: number | null;
  statement_id?: number | null;
  var_overrides?: string;
}) => invoke<number>("upsert_package_item", { payload });

export const listPackageItems = (packageId: number) =>
  invoke<DocPackageItem[]>("list_package_items", { packageId });

export const reorderPackageItems = (orderedIds: number[]) =>
  invoke<void>("reorder_package_items", { orderedIds });

export const deletePackageItem = (id: number) =>
  invoke<void>("delete_package_item", { id });

// Rendering
export const renderPackage = (packageId: number) =>
  invoke<RenderPackageResult>("render_package", { packageId });

export const renderTemplate = (bodyHtml: string) =>
  invoke<string>("render_template", { bodyHtml });


export const exportPdf = (html: string) =>
  invoke<string>("export_pdf", { html });

export const getNoteRegistry = (packageId: number) =>
  invoke<NoteInfo[]>("get_note_registry", { packageId });

export const listAllNoteKeys = () =>
  invoke<NoteInfo[]>("list_all_note_keys");

export const seedDefaultTemplates = () =>
  invoke<number>("seed_default_templates");

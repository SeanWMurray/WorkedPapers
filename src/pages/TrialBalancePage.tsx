import { useEffect, useState, useRef, useCallback } from "react";
import { useAtom } from "jotai";
import { tbAccountsAtom, engagementAtom } from "@/store/atoms";
import {
  getTbAccounts, getTbSummary, importTbCsv, listMapNumbers,
  updateAccountMapping, updateAccountMeta, updateAccountBalance, createAccount, open,
} from "@/lib/tauri";
import { readTextFile } from "@tauri-apps/api/fs";
import { formatAccounting, formatNumber } from "@/lib/format";
import { FixedSizeList as List } from "react-window";
import Papa from "papaparse";
import TbImportWizard, { type ImportRow } from "@/components/ui/TbImportWizard";
import type { TbAccount, TbSummary, MapNumber } from "@/types";

export default function TrialBalancePage() {
  const [accounts, setAccounts] = useAtom(tbAccountsAtom);
  const [engagement] = useAtom(engagementAtom);
  const [summary, setSummary] = useState<TbSummary | null>(null);
  const [mapNumbers, setMapNumbers] = useState<MapNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewAccount, setShowNewAccount] = useState(false);

  const [wizardData, setWizardData] = useState<{
    headers: string[];
    rows: string[][];
  } | null>(null);

  const refresh = useCallback(async () => {
    const [accts, sum, maps] = await Promise.all([getTbAccounts(), getTbSummary(), listMapNumbers()]);
    setAccounts(accts);
    setSummary(sum);
    setMapNumbers(maps);
  }, [setAccounts]);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  const handleImport = async () => {
    try {
      const selected = await open({
        title: "Import Trial Balance CSV",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setError(null);
      const raw = await readTextFile(selected);
      const result = Papa.parse<string[]>(raw, { header: false, skipEmptyLines: true });
      if (result.errors.length) { setError(result.errors[0].message); return; }
      const [headerRow, ...dataRows] = result.data as string[][];
      setWizardData({ headers: headerRow, rows: dataRows });
    } catch (e) { setError(String(e)); }
  };

  const handleMapChange = useCallback(async (accountNumber: string, mapCode: string | null) => {
    try {
      await updateAccountMapping(accountNumber, mapCode);
      const accts = await getTbAccounts();
      setAccounts(accts);
    } catch (e) { setError(String(e)); }
  }, [setAccounts]);

  const handleMetaChange = useCallback(async (oldNum: string, newNum: string, newName: string) => {
    try {
      await updateAccountMeta(oldNum, newNum, newName);
      const accts = await getTbAccounts();
      setAccounts(accts);
    } catch (e) { setError(String(e)); }
  }, [setAccounts]);

  const handleBalanceChange = useCallback(async (accountNumber: string, prelim: number, prior: number) => {
    try {
      await updateAccountBalance(accountNumber, prelim, prior);
      const [accts, sum] = await Promise.all([getTbAccounts(), getTbSummary()]);
      setAccounts(accts);
      setSummary(sum);
    } catch (e) { setError(String(e)); }
  }, [setAccounts]);

  const handleWizardConfirm = async (rows: ImportRow[]) => {
    setWizardData(null);
    setLoading(true);
    setError(null);
    try {
      await importTbCsv(rows);
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  const handleCreateAccount = async (payload: {
    account_number: string; account_name: string;
    prelim_balance: number; prior_balance: number; map_number?: string | null;
  }) => {
    try {
      await createAccount(payload);
      await refresh();
      setShowNewAccount(false);
    } catch (e) { setError(String(e)); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {wizardData && (
        <TbImportWizard
          headers={wizardData.headers}
          rows={wizardData.rows}
          onConfirm={handleWizardConfirm}
          onCancel={() => setWizardData(null)}
        />
      )}

      {showNewAccount && (
        <NewAccountModal
          mapNumbers={mapNumbers}
          onSave={handleCreateAccount}
          onClose={() => setShowNewAccount(false)}
        />
      )}

      <div className="page-header">
        <span className="page-header__title">Trial Balance</span>
        {summary && (
          <span className={`badge ${summary.is_balanced ? "badge-open" : "badge-locked"}`}>
            {summary.is_balanced ? "BALANCED" : "OUT OF BALANCE"}
          </span>
        )}
        <button
          className="btn btn-sm"
          onClick={() => setShowNewAccount(true)}
          disabled={!!engagement?.is_locked}
        >
          + Add Account
        </button>
        <button
          className="btn btn-sm"
          onClick={handleImport}
          disabled={loading || !!engagement?.is_locked}
        >
          {loading ? "Importing…" : "Import CSV"}
        </button>
      </div>

      {summary && (
        <TbSummaryBar summary={summary} currency={engagement?.currency ?? "USD"} />
      )}

      {error && (
        <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflow: "hidden" }}>
        {accounts.length > 0 ? (
          <VirtualTbGrid
            accounts={accounts}
            currency={engagement?.currency ?? "USD"}
            mapNumbers={mapNumbers}
            locked={!!engagement?.is_locked}
            onMapChange={handleMapChange}
            onMetaChange={handleMetaChange}
            onBalanceChange={handleBalanceChange}
          />
        ) : (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "100%", color: "var(--color-text-muted)", fontSize: 12,
          }}>
            No accounts — import a CSV or add one manually
          </div>
        )}
      </div>
    </div>
  );
}

// ── New account modal ─────────────────────────────────────────────────────────

function NewAccountModal({
  mapNumbers, onSave, onClose,
}: {
  mapNumbers: MapNumber[];
  onSave: (p: { account_number: string; account_name: string; prelim_balance: number; prior_balance: number; map_number?: string | null }) => void;
  onClose: () => void;
}) {
  const [num, setNum] = useState("");
  const [name, setName] = useState("");
  const [prelim, setPrelim] = useState("");
  const [prior, setPrior] = useState("");
  const [map, setMap] = useState("");

  const submit = () => {
    if (!num.trim() || !name.trim()) return;
    onSave({
      account_number: num.trim(),
      account_name: name.trim(),
      prelim_balance: parseFloat(prelim) || 0,
      prior_balance: parseFloat(prior) || 0,
      map_number: map || null,
    });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: "var(--color-bg)", border: "1px solid var(--color-border)",
        borderRadius: 6, padding: 24, width: 400, display: "flex", flexDirection: "column", gap: 12,
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Add Account</div>

        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 110 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Account #</label>
            <input
              className="input input-sm"
              value={num}
              onChange={(e) => setNum(e.target.value)}
              placeholder="1010"
              autoFocus
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Name</label>
            <input
              className="input input-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Cash and Cash Equivalents"
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Prelim Balance</label>
            <input
              className="input input-sm"
              value={prelim}
              onChange={(e) => setPrelim(e.target.value)}
              placeholder="0.00"
              style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
            <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Prior Balance</label>
            <input
              className="input input-sm"
              value={prior}
              onChange={(e) => setPrior(e.target.value)}
              placeholder="0.00"
              style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}
            />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Map Number</label>
          <select className="select" value={map} onChange={(e) => setMap(e.target.value)}>
            <option value="">— unassigned —</option>
            {mapNumbers.map((m) => (
              <option key={m.code} value={m.code}>{m.code} {m.label}</option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm btn-primary" onClick={submit} disabled={!num.trim() || !name.trim()}>
            Add Account
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function TbSummaryBar({ summary, currency }: { summary: TbSummary; currency: string }) {
  return (
    <div style={{
      display: "flex", gap: 24, padding: "6px 16px",
      borderBottom: "1px solid var(--color-border)", fontSize: 11,
      fontFamily: "var(--font-mono)", flexShrink: 0,
    }}>
      {[
        { label: "Total Debits",  value: summary.total_debits },
        { label: "Total Credits", value: summary.total_credits },
        { label: "Net",           value: summary.total_debits + summary.total_credits, bold: true },
      ].map(({ label, value, bold }) => (
        <div key={label} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ color: "var(--color-text-muted)", fontSize: 10, textTransform: "uppercase" }}>
            {label}
          </span>
          <span style={{ fontWeight: bold ? 700 : 400, color: value < 0 ? "var(--color-danger)" : undefined }}>
            {formatAccounting(value, currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Inline editable cell ──────────────────────────────────────────────────────

function EditableCell({
  value, width, numeric, right, onCommit,
}: {
  value: string | number;
  width: number;
  numeric?: boolean;
  right?: boolean;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setRaw(numeric ? (value as number).toFixed(2) : String(value));
    setEditing(true);
    requestAnimationFrame(() => { inputRef.current?.select(); });
  };

  const commit = () => {
    setEditing(false);
    const next = raw.trim();
    if (next !== String(value)) onCommit(next);
  };

  const cancel = () => {
    setEditing(false);
    setRaw(String(value));
  };

  const displayColor = numeric && (value as number) < 0 ? "var(--color-danger)" : "var(--color-text)";

  if (editing) {
    return (
      <div style={{ width, minWidth: width, padding: "0 4px", height: 32, display: "flex", alignItems: "center" }}>
        <input
          ref={inputRef}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } if (e.key === "Escape") cancel(); }}
          style={{
            width: "100%", height: 22, fontSize: 12, fontFamily: "var(--font-mono)",
            textAlign: right ? "right" : "left",
            border: "1px solid var(--color-accent)", borderRadius: 2,
            background: "var(--color-bg)", color: "var(--color-text)",
            padding: "0 4px", outline: "none",
          }}
        />
      </div>
    );
  }

  return (
    <div
      onClick={startEdit}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width, minWidth: width, padding: "0 8px", height: 32,
        display: "flex", alignItems: "center",
        justifyContent: right ? "flex-end" : "flex-start",
        cursor: "text",
        color: displayColor,
        background: hovered ? "var(--color-hover-bg)" : "transparent",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}
    >
      {numeric ? formatNumber(value as number) : value}
    </div>
  );
}

// ── Virtualized grid ──────────────────────────────────────────────────────────

const COL_WIDTHS = { num: 90, name: 260, prior: 110, prelim: 110, adj: 100, rcl: 100, tax: 100, final: 120, map: 110 };

function VirtualTbGrid({
  accounts, currency, mapNumbers, locked, onMapChange, onMetaChange, onBalanceChange,
}: {
  accounts: TbAccount[];
  currency: string;
  mapNumbers: MapNumber[];
  locked: boolean;
  onMapChange: (accountNumber: string, mapCode: string | null) => void;
  onMetaChange: (oldNum: string, newNum: string, newName: string) => void;
  onBalanceChange: (accountNumber: string, prelim: number, prior: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);
  const hasTax = accounts.some((a) => a.tax_net !== 0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setHeight(el.clientHeight));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const fmt = (v: number) => formatAccounting(v, currency);
  const fmtNet = (v: number) => v === 0 ? "—" : formatAccounting(v, currency);

  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const a = accounts[index];
    return (
      <div style={{
        ...style, display: "flex", alignItems: "center",
        borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-mono)", fontSize: 12,
      }}>
        {locked ? (
          <Cell w={COL_WIDTHS.num}>{a.account_number}</Cell>
        ) : (
          <EditableCell
            value={a.account_number}
            width={COL_WIDTHS.num}
            onCommit={(v) => onMetaChange(a.account_number, v, a.account_name)}
          />
        )}

        {locked ? (
          <Cell w={COL_WIDTHS.name}>{a.account_name}</Cell>
        ) : (
          <EditableCell
            value={a.account_name}
            width={COL_WIDTHS.name}
            onCommit={(v) => onMetaChange(a.account_number, a.account_number, v)}
          />
        )}

        {locked ? (
          <Cell w={COL_WIDTHS.prior} right negative={a.prior_balance < 0}>
            {fmt(a.prior_balance)}
          </Cell>
        ) : (
          <EditableCell
            value={a.prior_balance}
            width={COL_WIDTHS.prior}
            numeric right
            onCommit={(v) => onBalanceChange(a.account_number, a.prelim_balance, parseFloat(v) || 0)}
          />
        )}

        {locked ? (
          <Cell w={COL_WIDTHS.prelim} right negative={a.prelim_balance < 0}>
            {fmt(a.prelim_balance)}
          </Cell>
        ) : (
          <EditableCell
            value={a.prelim_balance}
            width={COL_WIDTHS.prelim}
            numeric right
            onCommit={(v) => onBalanceChange(a.account_number, parseFloat(v) || 0, a.prior_balance)}
          />
        )}

        <Cell w={COL_WIDTHS.adj} right negative={a.adjustment_net < 0} muted={a.adjustment_net === 0}>
          {fmtNet(a.adjustment_net)}
        </Cell>
        <Cell w={COL_WIDTHS.rcl} right negative={a.reclass_net < 0} muted={a.reclass_net === 0}>
          {fmtNet(a.reclass_net)}
        </Cell>
        {hasTax && (
          <Cell w={COL_WIDTHS.tax} right negative={a.tax_net < 0} muted={a.tax_net === 0}>
            {fmtNet(a.tax_net)}
          </Cell>
        )}
        <Cell w={COL_WIDTHS.final} right negative={a.current_balance < 0} bold>
          {fmt(a.current_balance)}
        </Cell>
        <Cell w={COL_WIDTHS.map}>
          <select
            value={a.map_number ?? ""}
            onChange={(e) => onMapChange(a.account_number, e.target.value || null)}
            disabled={locked}
            style={{
              width: "100%", height: 22, fontSize: 11, border: "1px solid transparent",
              background: "transparent",
              color: a.map_number ? "var(--color-text)" : "var(--color-text-muted)",
              fontFamily: "var(--font-mono)", cursor: locked ? "default" : "pointer", outline: "none",
            }}
            onMouseEnter={(e) => { if (!locked) e.currentTarget.style.borderColor = "var(--color-border)"; }}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}
          >
            <option value="">—</option>
            {mapNumbers.map((m) => (
              <option key={m.code} value={m.code}>{m.code} {m.label}</option>
            ))}
          </select>
        </Cell>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{
        display: "flex", borderBottom: "2px solid var(--color-border-strong)",
        fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0,
      }}>
        <Cell w={COL_WIDTHS.num}>Account #</Cell>
        <Cell w={COL_WIDTHS.name}>Name</Cell>
        <Cell w={COL_WIDTHS.prior} right>Prior Year</Cell>
        <Cell w={COL_WIDTHS.prelim} right>Preliminary</Cell>
        <Cell w={COL_WIDTHS.adj} right>AJEs</Cell>
        <Cell w={COL_WIDTHS.rcl} right>RJEs</Cell>
        {hasTax && <Cell w={COL_WIDTHS.tax} right>TJEs</Cell>}
        <Cell w={COL_WIDTHS.final} right>Final</Cell>
        <Cell w={COL_WIDTHS.map}>Map</Cell>
      </div>

      <div ref={containerRef} style={{ flex: 1, overflow: "hidden" }}>
        <List height={height} itemCount={accounts.length} itemSize={32} width="100%">
          {Row}
        </List>
      </div>
    </div>
  );
}

function Cell({
  w, children, right, muted, negative, bold,
}: {
  w: number; children: React.ReactNode;
  right?: boolean; muted?: boolean; negative?: boolean; bold?: boolean;
}) {
  return (
    <div style={{
      width: w, minWidth: w, padding: "0 8px", height: 32,
      display: "flex", alignItems: "center",
      justifyContent: right ? "flex-end" : "flex-start",
      fontWeight: bold ? 700 : undefined,
      color: negative ? "var(--color-danger)" : muted ? "var(--color-text-muted)" : undefined,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>
      {children}
    </div>
  );
}

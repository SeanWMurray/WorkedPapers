import { useEffect, useState, useRef, useCallback } from "react";
import { useAtom } from "jotai";
import { tbAccountsAtom, engagementAtom } from "@/store/atoms";
import { getTbAccounts, getTbSummary, importTbCsv, open } from "@/lib/tauri";
import { readTextFile } from "@tauri-apps/api/fs";
import { formatAccounting } from "@/lib/format";
import { FixedSizeList as List } from "react-window";
import Papa from "papaparse";
import TbImportWizard, { type ImportRow } from "@/components/ui/TbImportWizard";
import type { TbAccount, TbSummary } from "@/types";

export default function TrialBalancePage() {
  const [accounts, setAccounts] = useAtom(tbAccountsAtom);
  const [engagement] = useAtom(engagementAtom);
  const [summary, setSummary] = useState<TbSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wizard state
  const [wizardData, setWizardData] = useState<{
    headers: string[];
    rows: string[][];
  } | null>(null);

  const refresh = useCallback(async () => {
    const [accts, sum] = await Promise.all([getTbAccounts(), getTbSummary()]);
    setAccounts(accts);
    setSummary(sum);
  }, [setAccounts]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const handleImport = async () => {
    try {
      const selected = await open({
        title: "Import Trial Balance CSV",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!selected || Array.isArray(selected)) return;

      setError(null);
      const raw = await readTextFile(selected);

      // Parse into raw rows — wizard handles mapping
      const result = Papa.parse<string[]>(raw, {
        header: false,
        skipEmptyLines: true,
      });

      if (result.errors.length) {
        setError(result.errors[0].message);
        return;
      }

      const [headerRow, ...dataRows] = result.data as string[][];
      setWizardData({ headers: headerRow, rows: dataRows });
    } catch (e) {
      setError(String(e));
    }
  };

  const handleWizardConfirm = async (rows: ImportRow[]) => {
    setWizardData(null);
    setLoading(true);
    setError(null);
    try {
      await importTbCsv(rows);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
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

      <div className="page-header">
        <span className="page-header__title">Trial Balance</span>
        {summary && (
          <span className={`badge ${summary.is_balanced ? "badge-open" : "badge-locked"}`}>
            {summary.is_balanced ? "BALANCED" : "OUT OF BALANCE"}
          </span>
        )}
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
          <VirtualTbGrid accounts={accounts} currency={engagement?.currency ?? "USD"} />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--color-text-muted)",
              fontSize: 12,
            }}
          >
            No accounts — import a CSV to get started
          </div>
        )}
      </div>
    </div>
  );
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function TbSummaryBar({ summary, currency }: { summary: TbSummary; currency: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 24,
        padding: "6px 16px",
        borderBottom: "1px solid var(--color-border)",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        flexShrink: 0,
      }}
    >
      {[
        { label: "Total Debits",  value: summary.total_debits },
        { label: "Total Credits", value: summary.total_credits },
        { label: "Net",           value: summary.total_debits + summary.total_credits, bold: true },
      ].map(({ label, value, bold }) => (
        <div key={label} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ color: "var(--color-text-muted)", fontSize: 10, textTransform: "uppercase" }}>
            {label}
          </span>
          <span
            style={{
              fontWeight: bold ? 700 : 400,
              color: value < 0 ? "var(--color-danger)" : undefined,
            }}
          >
            {formatAccounting(value, currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Virtualized grid ──────────────────────────────────────────────────────────

const COL_WIDTHS = { num: 90, name: 420, current: 130, prior: 130, map: 80 };

function VirtualTbGrid({ accounts, currency }: { accounts: TbAccount[]; currency: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setHeight(el.clientHeight));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const a = accounts[index];
    return (
      <div
        style={{
          ...style,
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--color-border)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      >
        <Cell w={COL_WIDTHS.num}>{a.account_number}</Cell>
        <Cell w={COL_WIDTHS.name}>{a.account_name}</Cell>
        <Cell w={COL_WIDTHS.current} right negative={a.current_balance < 0}>
          {formatAccounting(a.current_balance, currency)}
        </Cell>
        <Cell w={COL_WIDTHS.prior} right negative={a.prior_balance < 0}>
          {formatAccounting(a.prior_balance, currency)}
        </Cell>
        <Cell w={COL_WIDTHS.map} muted>{a.map_number ?? "—"}</Cell>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          borderBottom: "2px solid var(--color-border-strong)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          flexShrink: 0,
        }}
      >
        <Cell w={COL_WIDTHS.num}>Account #</Cell>
        <Cell w={COL_WIDTHS.name}>Name</Cell>
        <Cell w={COL_WIDTHS.current} right>Current (adj)</Cell>
        <Cell w={COL_WIDTHS.prior} right>Prior Year</Cell>
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
  w,
  children,
  right,
  muted,
  negative,
}: {
  w: number;
  children: React.ReactNode;
  right?: boolean;
  muted?: boolean;
  negative?: boolean;
}) {
  return (
    <div
      style={{
        width: w,
        minWidth: w,
        padding: "0 8px",
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: right ? "flex-end" : "flex-start",
        color: negative
          ? "var(--color-danger)"
          : muted
          ? "var(--color-text-muted)"
          : undefined,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

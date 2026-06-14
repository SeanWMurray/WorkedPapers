import { useEffect, useState } from "react";
import {
  listStatements,
  resolveStatement,
  seedDefaultStatements,
  upsertStatement,
  deleteStatement,
} from "@/lib/tauri";
import { formatAccounting } from "@/lib/format";
import type { ResolvedLine, ResolvedStatement, Statement, StatementKind } from "@/types";
import StatementEditor from "@/components/ui/StatementEditor";

const KINDS: StatementKind[] = ["BALANCE_SHEET", "INCOME_STATEMENT", "CASH_FLOW", "EQUITY", "CUSTOM"];

// HTML generation for the printable preview runs in a Web Worker so the UI
// stays responsive while a large statement set is laid out.
const reportWorker = new Worker(
  new URL("@/workers/reportRenderer.worker.ts", import.meta.url),
  { type: "module" }
);

export default function ReportsPage() {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [resolved, setResolved] = useState<ResolvedStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [stmtModal, setStmtModal] = useState<{ id?: number; name: string; kind: StatementKind } | null>(null);

  // Load the statement list; seed the four standard templates on first visit.
  const loadStatements = async () => {
    setError(null);
    try {
      let list = await listStatements();
      if (list.length === 0) {
        await seedDefaultStatements();
        list = await listStatements();
      }
      setStatements(list);
      if (list.length > 0 && selectedId === null) {
        setSelectedId(list[0].id);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    loadStatements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve whenever the selection changes.
  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    resolveStatement(selectedId)
      .then((r) => {
        if (!cancelled) setResolved(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleSaveStatement = async () => {
    if (!stmtModal) return;
    try {
      const id = await upsertStatement({ id: stmtModal.id ?? null, name: stmtModal.name, kind: stmtModal.kind });
      setStmtModal(null);
      await loadStatements();
      setSelectedId(id);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteStatement = async () => {
    if (!selectedId) return;
    const stmt = statements.find((s) => s.id === selectedId);
    if (!confirm(`Delete "${stmt?.name}"? This cannot be undone.`)) return;
    try {
      await deleteStatement(selectedId);
      setSelectedId(null);
      setResolved(null);
      await loadStatements();
    } catch (e) {
      setError(String(e));
    }
  };

  // Preview the full statement set as a standalone printable document.
  const handlePreviewAll = async () => {
    setError(null);
    try {
      const all = await Promise.all(statements.map((s) => resolveStatement(s.id)));
      reportWorker.postMessage({ type: "RENDER", statements: all });
      reportWorker.onmessage = (e) => {
        if (e.data.type === "RENDERED") {
          const w = window.open("", "_blank");
          w?.document.write(e.data.html);
          w?.document.close();
        }
      };
    } catch (e) {
      setError(String(e));
    }
  };

  const currency = resolved?.engagement.currency ?? "USD";

  const renderLine = (l: ResolvedLine) => {
    if (l.line_type === "SPACER") {
      return (
        <tr key={l.line_no}>
          <td colSpan={3} style={{ height: 10 }} />
        </tr>
      );
    }

    const indent = 8 + l.depth * 18;
    const isHeader = l.line_type === "HEADER";
    const isSubtotal = l.line_type === "SUBTOTAL";

    const labelStyle: React.CSSProperties = {
      paddingLeft: indent,
      fontWeight: l.bold || isSubtotal ? 700 : undefined,
      textTransform: isHeader ? "uppercase" : undefined,
      fontSize: isHeader ? 11 : undefined,
      letterSpacing: isHeader ? "0.04em" : undefined,
      color: isHeader ? "var(--color-text-muted)" : undefined,
    };

    const rowStyle: React.CSSProperties = {
      borderTop: isSubtotal ? "1px solid var(--color-border)" : undefined,
      borderBottom: l.underline ? "2.5px double var(--color-text)" : undefined,
    };

    const amtStyle = (v: number | null): React.CSSProperties => ({
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
      fontWeight: l.bold || isSubtotal ? 700 : undefined,
      color: v != null && v < 0 ? "var(--color-danger)" : undefined,
    });

    if (l.error) {
      return (
        <tr key={l.line_no} style={rowStyle}>
          <td style={labelStyle}>{l.label}</td>
          <td colSpan={2} style={{ textAlign: "right", color: "var(--color-danger)", fontSize: 11 }}>
            ⚠ {l.error}
          </td>
        </tr>
      );
    }

    if (isHeader) {
      return (
        <tr key={l.line_no} style={rowStyle}>
          <td style={labelStyle}>{l.label}</td>
          <td />
          <td />
        </tr>
      );
    }

    if (l.line_type === "VAR") {
      return (
        <tr key={l.line_no} style={rowStyle}>
          <td style={labelStyle}>{l.label}</td>
          <td colSpan={2} style={{ textAlign: "right" }}>
            {l.text ?? ""}
          </td>
        </tr>
      );
    }

    return (
      <tr key={l.line_no} style={rowStyle}>
        <td style={labelStyle}>{l.label}</td>
        <td className="numeric" style={amtStyle(l.current)}>
          {l.current != null ? formatAccounting(l.current, currency) : ""}
        </td>
        <td className="numeric" style={amtStyle(l.prior)}>
          {l.show_prior && l.prior != null ? formatAccounting(l.prior, currency) : ""}
        </td>
      </tr>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <span className="page-header__title">Reports</span>
        <select
          className="input input-sm"
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(Number(e.target.value))}
          disabled={statements.length === 0}
          style={{ minWidth: 200 }}
        >
          {statements.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button
          className="btn btn-sm"
          onClick={() => {
            const stmt = statements.find((s) => s.id === selectedId);
            if (stmt) setStmtModal({ id: stmt.id, name: stmt.name, kind: stmt.kind as StatementKind });
          }}
          disabled={selectedId === null}
          title="Rename this statement"
        >
          Rename
        </button>
        <button
          className="btn btn-sm"
          onClick={handleDeleteStatement}
          disabled={selectedId === null}
          title="Delete this statement"
        >
          Delete
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setStmtModal({ name: "", kind: "CUSTOM" })}
        >
          + New
        </button>
        <div style={{ width: 1, background: "var(--color-border)", alignSelf: "stretch", margin: "0 4px" }} />
        <button
          className="btn btn-sm"
          onClick={() => setEditing(true)}
          disabled={selectedId === null}
        >
          Edit lines
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={handlePreviewAll}
          disabled={statements.length === 0}
        >
          Preview All
        </button>
      </div>

      {error && (
        <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12 }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ padding: "8px 16px", color: "var(--color-text-muted)", fontSize: 12 }}>
          Resolving…
        </div>
      )}

      {resolved && (
        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          <div style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>
            {resolved.engagement.entity_name}
          </div>
          <div style={{ marginBottom: 20, fontSize: 12, color: "var(--color-text-muted)" }}>
            {resolved.name} — Year Ended {resolved.engagement.year_end} ({currency})
          </div>
          <table style={{ width: "100%", maxWidth: 720, borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid var(--color-border)", padding: "4px 8px" }} />
                <th style={{ textAlign: "right", borderBottom: "1px solid var(--color-border)", padding: "4px 8px", fontSize: 10, textTransform: "uppercase", color: "var(--color-text-muted)" }}>
                  Current
                </th>
                <th style={{ textAlign: "right", borderBottom: "1px solid var(--color-border)", padding: "4px 8px", fontSize: 10, textTransform: "uppercase", color: "var(--color-text-muted)" }}>
                  Prior
                </th>
              </tr>
            </thead>
            <tbody>{resolved.lines.map(renderLine)}</tbody>
          </table>
        </div>
      )}

      {!resolved && !loading && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--color-text-muted)", fontSize: 12 }}>
          Select a statement to resolve
        </div>
      )}

      {editing && selectedId !== null && (
        <StatementEditor
          statementId={selectedId}
          onClose={() => setEditing(false)}
          onChanged={() => {
            setLoading(true);
            resolveStatement(selectedId)
              .then(setResolved)
              .catch((e) => setError(String(e)))
              .finally(() => setLoading(false));
          }}
        />
      )}

      {stmtModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setStmtModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border-strong)", padding: 20, width: 360, display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              {stmtModal.id ? "Rename statement" : "New statement"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", fontWeight: 600 }}>Name</label>
              <input
                autoFocus
                className="input"
                value={stmtModal.name}
                onChange={(e) => setStmtModal({ ...stmtModal, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveStatement(); if (e.key === "Escape") setStmtModal(null); }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, color: "var(--color-text-muted)", textTransform: "uppercase", fontWeight: 600 }}>Kind</label>
              <select
                className="select"
                value={stmtModal.kind}
                onChange={(e) => setStmtModal({ ...stmtModal, kind: e.target.value as StatementKind })}
              >
                {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setStmtModal(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!stmtModal.name.trim()} onClick={handleSaveStatement}>
                {stmtModal.id ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

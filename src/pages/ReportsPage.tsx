import { useEffect, useState } from "react";
import {
  listStatements,
  resolveStatement,
  seedDefaultStatements,
} from "@/lib/tauri";
import { formatAccounting } from "@/lib/format";
import type { ResolvedLine, ResolvedStatement, Statement } from "@/types";
import StatementEditor from "@/components/ui/StatementEditor";

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
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" onClick={loadStatements}>
          Refresh
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setEditing(true)}
          disabled={selectedId === null}
          title="Edit this statement's lines and formulas"
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
            // Re-resolve live as lines are saved so the preview updates.
            setLoading(true);
            resolveStatement(selectedId)
              .then(setResolved)
              .catch((e) => setError(String(e)))
              .finally(() => setLoading(false));
          }}
        />
      )}
    </div>
  );
}

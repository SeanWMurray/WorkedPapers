import { useState } from "react";
import { renderReportData } from "@/lib/tauri";
import { formatAccounting } from "@/lib/format";
import type { ReportData } from "@/types";

// Financial statement data is assembled by a Web Worker so the UI stays responsive
const reportWorker = new Worker(
  new URL("@/workers/reportRenderer.worker.ts", import.meta.url),
  { type: "module" }
);

export default function ReportsPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const reportData = await renderReportData();
      setData(reportData);

      // Off-thread HTML generation
      reportWorker.postMessage({ type: "RENDER", data: reportData });
      reportWorker.onmessage = (e) => {
        if (e.data.type === "RENDERED") {
          setHtml(e.data.html);
          setLoading(false);
        }
      };
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <span className="page-header__title">Reports</span>
        <button className="btn btn-sm btn-primary" onClick={handleGenerate} disabled={loading}>
          {loading ? "Generating…" : "Generate Financial Statements"}
        </button>
        {html && (
          <button
            className="btn btn-sm"
            onClick={() => {
              const w = window.open("", "_blank");
              w?.document.write(html);
            }}
          >
            Preview
          </button>
        )}
      </div>

      {error && <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12 }}>{error}</div>}

      {data && (
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          <div style={{ marginBottom: 16, fontSize: 13, fontWeight: 700 }}>
            {data.engagement.entity_name} — Map Number Totals (YE {data.engagement.year_end})
          </div>
          <table className="data-grid" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 80 }}>Map #</th>
                <th>Label</th>
                <th style={{ width: 140, textAlign: "right" }}>Current (unadj)</th>
                <th style={{ width: 140, textAlign: "right" }}>Current (adj)</th>
                <th style={{ width: 140, textAlign: "right" }}>Prior Year</th>
              </tr>
            </thead>
            <tbody>
              {data.map_totals.map((m) => (
                <tr key={m.map_number}>
                  <td className="mono bold">{m.map_number}</td>
                  <td>{m.label}</td>
                  <td className="numeric" style={{ color: m.current_total < 0 ? "var(--color-danger)" : undefined }}>
                    {formatAccounting(m.current_total, data.engagement.currency)}
                  </td>
                  <td className="numeric bold" style={{ color: m.adjusted_current < 0 ? "var(--color-danger)" : undefined }}>
                    {formatAccounting(m.adjusted_current, data.engagement.currency)}
                  </td>
                  <td className="numeric text-muted">
                    {formatAccounting(m.prior_total, data.engagement.currency)}
                  </td>
                </tr>
              ))}
              {data.map_totals.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                    No map numbers assigned — set them up in Mapping first
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!data && !loading && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--color-text-muted)", fontSize: 12 }}>
          Click Generate to produce financial statement data
        </div>
      )}
    </div>
  );
}

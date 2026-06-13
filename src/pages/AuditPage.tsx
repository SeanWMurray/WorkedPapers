import { useEffect, useState } from "react";
import { getAuditTrail } from "@/lib/tauri";
import { formatDate } from "@/lib/format";
import type { AuditEntry } from "@/types";

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    getAuditTrail(500).then(setEntries).catch(() => {});
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <span className="page-header__title">Audit Trail</span>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          Immutable — {entries.length} entries
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <table className="data-grid" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 60 }}>ID</th>
              <th style={{ width: 160 }}>Action</th>
              <th style={{ width: 110 }}>Entity</th>
              <th style={{ width: 120 }}>Entity ID</th>
              <th style={{ width: 140 }}>Performed By</th>
              <th style={{ width: 130 }}>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="mono text-muted">{e.id}</td>
                <td className="mono bold">{e.action}</td>
                <td className="text-muted">{e.entity}</td>
                <td className="mono text-muted">{e.entity_id}</td>
                <td>{e.performed_by}</td>
                <td className="mono text-muted" style={{ fontSize: 10 }}>
                  {formatDate(e.performed_at)}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                  No audit entries yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

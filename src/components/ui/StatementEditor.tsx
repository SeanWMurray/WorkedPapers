import { useEffect, useState } from "react";
import {
  listStatements,
  upsertStatementLine,
  deleteStatementLine,
  reorderStatementLines,
} from "@/lib/tauri";
import type { LineType, StatementLine } from "@/types";
import DataPicker from "./DataPicker";

// Edit a single statement's lines: add / edit / delete / reorder, and author
// formula expressions with help from the DataPicker. Pure CRUD over the engine's
// backend commands — no formula evaluation happens here.

const LINE_TYPES: LineType[] = ["HEADER", "MAP", "FORMULA", "SUBTOTAL", "VAR", "SPACER"];

const HAS_EXPR = (t: LineType) => t === "MAP" || t === "FORMULA" || t === "SUBTOTAL" || t === "VAR";

interface Props {
  statementId: number;
  onClose: () => void;
  onChanged: () => void; // notify parent to re-resolve after edits
}

export default function StatementEditor({ statementId, onClose, onChanged }: Props) {
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pickerForId, setPickerForId] = useState<number | null>(null);

  // Local draft for the row currently being edited.
  const [draft, setDraft] = useState<Partial<StatementLine>>({});

  const load = async () => {
    setError(null);
    try {
      const all = await listStatements();
      const s = all.find((x) => x.id === statementId);
      setLines(s?.lines ?? []);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statementId]);

  const beginEdit = (l: StatementLine) => {
    setEditingId(l.id);
    setDraft({ ...l });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft({});
  };

  const persist = async (payloadOverride?: Partial<StatementLine>) => {
    const d = { ...draft, ...payloadOverride };
    try {
      await upsertStatementLine({
        id: d.id ?? null,
        statement_id: statementId,
        parent_id: d.parent_id ?? null,
        line_type: (d.line_type as LineType) ?? "MAP",
        label: d.label ?? "",
        expression: d.expression ?? null,
        bold: !!d.bold,
        underline: !!d.underline,
        show_prior: d.show_prior ?? true,
        invert_sign: !!d.invert_sign,
      });
      cancelEdit();
      await load();
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  const addLine = async () => {
    await persist({
      id: undefined,
      line_type: "MAP",
      label: "New line",
      expression: "",
      bold: false,
      underline: false,
      show_prior: true,
      invert_sign: false,
    } as Partial<StatementLine>);
  };

  const remove = async (id: number) => {
    try {
      await deleteStatementLine(id);
      await load();
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...lines];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setLines(next); // optimistic
    try {
      await reorderStatementLines(next.map((l) => l.id));
      onChanged();
    } catch (e) {
      setError(String(e));
      await load();
    }
  };

  const insertToken = (token: string) => {
    setDraft((d) => ({
      ...d,
      expression: ((d.expression ?? "") + (d.expression ? " " : "") + token).trim(),
    }));
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 250, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          width: 760,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Edit statement lines</span>
          <button className="btn btn-sm btn-primary" onClick={addLine}>+ Add line</button>
          <button className="btn btn-sm" onClick={onClose}>Done</button>
        </div>

        {error && <div style={{ padding: "8px 16px", color: "var(--color-danger)", fontSize: 12 }}>{error}</div>}

        <div style={{ overflow: "auto", flex: 1, padding: 8 }}>
          <table className="data-grid" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ width: 64 }}>Order</th>
                <th style={{ width: 96 }}>Type</th>
                <th>Label</th>
                <th>Expression</th>
                <th style={{ width: 130 }}>Flags</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const editing = editingId === l.id;
                const d = editing ? draft : l;
                const showExpr = HAS_EXPR((d.line_type as LineType) ?? "MAP");
                return (
                  <tr key={l.id}>
                    <td>
                      <button className="btn btn-xs" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                      <button className="btn btn-xs" onClick={() => move(i, 1)} disabled={i === lines.length - 1}>↓</button>
                    </td>
                    <td>
                      {editing ? (
                        <select
                          className="select"
                          value={d.line_type ?? "MAP"}
                          onChange={(e) => setDraft({ ...draft, line_type: e.target.value as LineType })}
                        >
                          {LINE_TYPES.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="mono">{l.line_type}</span>
                      )}
                    </td>
                    <td>
                      {editing ? (
                        <input
                          className="input input-sm"
                          value={d.label ?? ""}
                          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                          style={{ width: "100%" }}
                        />
                      ) : (
                        l.label
                      )}
                    </td>
                    <td>
                      {editing && showExpr ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          <input
                            className="input input-sm mono"
                            value={d.expression ?? ""}
                            placeholder={d.line_type === "VAR" ? "V:key" : "e.g. SUM(1000..1099) or M:1000 + G:3"}
                            onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
                            style={{ width: "100%" }}
                          />
                          <button className="btn btn-xs" title="Pick data source" onClick={() => setPickerForId(l.id)}>＋ data</button>
                        </div>
                      ) : (
                        <span className="mono" style={{ color: "var(--color-text-muted)" }}>{l.expression ?? ""}</span>
                      )}
                    </td>
                    <td>
                      {editing ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11 }}>
                          <label><input type="checkbox" checked={!!d.bold} onChange={(e) => setDraft({ ...draft, bold: e.target.checked })} /> B</label>
                          <label><input type="checkbox" checked={!!d.underline} onChange={(e) => setDraft({ ...draft, underline: e.target.checked })} /> U</label>
                          <label><input type="checkbox" checked={d.show_prior ?? true} onChange={(e) => setDraft({ ...draft, show_prior: e.target.checked })} /> Prior</label>
                          <label><input type="checkbox" checked={!!d.invert_sign} onChange={(e) => setDraft({ ...draft, invert_sign: e.target.checked })} /> ±</label>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                          {[l.bold && "B", l.underline && "U", l.invert_sign && "±", !l.show_prior && "no-prior"].filter(Boolean).join(" ")}
                        </span>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {editing ? (
                        <>
                          <button className="btn btn-xs btn-primary" onClick={() => persist()}>Save</button>
                          <button className="btn btn-xs" onClick={cancelEdit}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-xs" onClick={() => beginEdit(l)}>Edit</button>
                          <button className="btn btn-xs" onClick={() => remove(l.id)}>✕</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                    No lines yet — click “Add line”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pickerForId !== null && (
        <DataPicker
          onPick={(token) => {
            // Only the row being edited owns the picker result.
            if (editingId === pickerForId) insertToken(token);
          }}
          onClose={() => setPickerForId(null)}
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  listStatements,
  upsertStatementLine,
  deleteStatementLine,
  reorderStatementLines,
  listAllNoteKeys,
} from "@/lib/tauri";
import type { LineType, NoteInfo, StatementLine } from "@/types";
import DataPicker from "./DataPicker";

const LINE_TYPES: LineType[] = ["HEADER", "MAP", "FORMULA", "SUBTOTAL", "VAR", "SPACER"];
const HAS_EXPR = (t: LineType) => t === "MAP" || t === "FORMULA" || t === "SUBTOTAL" || t === "VAR";

interface Props {
  statementId: number;
  onClose: () => void;
  onChanged: () => void;
}

export default function StatementEditor({ statementId, onClose, onChanged }: Props) {
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [noteKeys, setNoteKeys] = useState<NoteInfo[]>([]);
  const [draft, setDraft] = useState<Partial<StatementLine>>({});
  const labelInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => { load(); }, [statementId]); // eslint-disable-line react-hooks/exhaustive-deps

  const beginEdit = (l: StatementLine) => { setEditingId(l.id); setDraft({ ...l }); };
  const cancelEdit = () => { setEditingId(null); setDraft({}); };

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
    setLines(next);
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

  const openNotePicker = async () => {
    try {
      const keys = await listAllNoteKeys();
      setNoteKeys(keys);
    } catch {
      setNoteKeys([]);
    }
    setNotePickerOpen(true);
  };

  const insertNoteRef = (key: string) => {
    const tag = ` {{note_ref:${key}}}`;
    const input = labelInputRef.current;
    if (input) {
      const start = input.selectionStart ?? (draft.label ?? "").length;
      const end = input.selectionEnd ?? start;
      const label = draft.label ?? "";
      const next = label.slice(0, start) + tag + label.slice(end);
      setDraft((d) => ({ ...d, label: next }));
      requestAnimationFrame(() => {
        input.selectionStart = input.selectionEnd = start + tag.length;
        input.focus();
      });
    } else {
      setDraft((d) => ({ ...d, label: (d.label ?? "") + tag }));
    }
    setNotePickerOpen(false);
  };

  const lineTypeColor: Record<LineType, string> = {
    HEADER:   "var(--color-primary)",
    MAP:      "var(--color-text)",
    FORMULA:  "#a78bfa",
    SUBTOTAL: "#34d399",
    VAR:      "#f59e0b",
    SPACER:   "var(--color-text-muted)",
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
          width: 860,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        }}
      >
        {/* Header */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Edit statement lines</span>
          <button className="btn btn-sm btn-primary" onClick={addLine}>+ Add line</button>
          <button className="btn btn-sm" onClick={onClose}>Done</button>
        </div>

        {error && <div style={{ padding: "8px 16px", color: "var(--color-danger)", fontSize: 12, flexShrink: 0 }}>{error}</div>}

        {/* Line list */}
        <div style={{ overflow: "auto", flex: 1 }}>
          {lines.length === 0 && (
            <div style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "40px 0", fontSize: 13 }}>
              No lines yet — click "Add line".
            </div>
          )}

          {lines.map((l, i) => {
            const editing = editingId === l.id;
            const d = editing ? draft : l;
            const typ = (d.line_type ?? "MAP") as LineType;
            const showExpr = HAS_EXPR(typ);

            return (
              <div
                key={l.id}
                style={{
                  borderBottom: "1px solid var(--color-border)",
                  background: editing ? "var(--color-bg-subtle, rgba(255,255,255,0.03))" : undefined,
                }}
              >
                {/* Summary row — always visible */}
                <div style={{ display: "flex", alignItems: "center", padding: "0 8px", height: 36, gap: 8, fontSize: 12 }}>
                  {/* Reorder */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, flexShrink: 0 }}>
                    <button className="btn btn-xs" onClick={() => move(i, -1)} disabled={i === 0} style={{ lineHeight: 1, padding: "0 4px" }}>▲</button>
                    <button className="btn btn-xs" onClick={() => move(i, 1)} disabled={i === lines.length - 1} style={{ lineHeight: 1, padding: "0 4px" }}>▼</button>
                  </div>

                  {/* Type badge */}
                  <span style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 700,
                    color: lineTypeColor[typ],
                    minWidth: 64,
                    flexShrink: 0,
                  }}>
                    {typ}
                  </span>

                  {/* Label preview */}
                  <span style={{
                    flex: 1,
                    fontWeight: l.bold ? 700 : undefined,
                    textDecoration: l.underline ? "underline" : undefined,
                    color: typ === "HEADER" ? undefined : typ === "SPACER" ? "var(--color-text-muted)" : undefined,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                    {l.label || <span style={{ color: "var(--color-text-muted)" }}>(no label)</span>}
                  </span>

                  {/* Expression preview */}
                  {l.expression && !editing && (
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--color-text-muted)",
                      maxWidth: 260,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}>
                      {l.expression}
                    </span>
                  )}

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
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
                  </div>
                </div>

                {/* Expanded edit panel */}
                {editing && (
                  <div style={{ padding: "12px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>

                    {/* Row 1: type + label */}
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                        <label style={{ fontSize: 10, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase" }}>Type</label>
                        <select
                          className="select"
                          value={d.line_type ?? "MAP"}
                          onChange={(e) => setDraft({ ...draft, line_type: e.target.value as LineType })}
                          style={{ width: 120 }}
                        >
                          {LINE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <label style={{ fontSize: 10, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", flex: 1 }}>Label</label>
                          <button className="btn btn-xs" onClick={openNotePicker} title="Insert a note cross-reference into the label">
                            + note ref
                          </button>
                        </div>
                        <input
                          ref={labelInputRef}
                          className="input"
                          value={d.label ?? ""}
                          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                          placeholder='e.g. "Cash and cash equivalents" — use + note ref to append (Note 1)'
                          style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12 }}
                        />
                      </div>
                    </div>

                    {/* Row 2: expression */}
                    {showExpr && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <label style={{ fontSize: 10, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", flex: 1 }}>
                            Expression
                          </label>
                          <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                            M:code · SUM(lo..hi) · G:id · A:acct# · L:lineno · V:key · arithmetic
                          </span>
                          <button
                            className="btn btn-xs"
                            onClick={() => setPickerOpen(true)}
                            style={{ flexShrink: 0 }}
                          >
                            + data
                          </button>
                        </div>
                        <textarea
                          className="input mono"
                          value={d.expression ?? ""}
                          placeholder={typ === "VAR" ? "V:key" : "e.g.  SUM(1000..1999)  or  M:4000 + M:4100 - L:12"}
                          onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
                          rows={3}
                          style={{
                            width: "100%",
                            fontFamily: "var(--font-mono)",
                            fontSize: 13,
                            resize: "vertical",
                            lineHeight: 1.5,
                          }}
                        />
                      </div>
                    )}

                    {/* Row 3: flags */}
                    <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
                      <label style={{ fontSize: 10, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase" }}>Flags</label>
                      {[
                        { key: "bold" as const,        label: "Bold" },
                        { key: "underline" as const,   label: "Underline" },
                        { key: "show_prior" as const,  label: "Show prior year" },
                        { key: "invert_sign" as const, label: "Invert sign (±)" },
                      ].map(({ key, label }) => (
                        <label key={key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={key === "show_prior" ? (d.show_prior ?? true) : !!(d[key])}
                            onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {pickerOpen && (
        <DataPicker
          onPick={(token) => { insertToken(token); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {notePickerOpen && (
        <NoteRefPicker
          knownKeys={noteKeys}
          onPick={insertNoteRef}
          onClose={() => setNotePickerOpen(false)}
        />
      )}
    </div>
  );
}

// ── Note ref picker ───────────────────────────────────────────────────────────

function NoteRefPicker({
  knownKeys, onPick, onClose,
}: {
  knownKeys: NoteInfo[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--color-bg)", border: "1px solid var(--color-border)",
          borderRadius: 6, width: 360, boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--color-border)", fontWeight: 600, fontSize: 13 }}>
          Insert note reference
        </div>

        {/* Existing keys */}
        {knownKeys.length > 0 && (
          <div style={{ borderBottom: "1px solid var(--color-border)", maxHeight: 220, overflowY: "auto" }}>
            <div style={{ padding: "6px 14px 4px", fontSize: 10, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase" }}>
              Known note keys
            </div>
            {knownKeys.map((n) => (
              <div
                key={n.note_key}
                onClick={() => onPick(n.note_key)}
                style={{
                  padding: "7px 14px", cursor: "pointer", display: "flex",
                  alignItems: "center", gap: 10, fontSize: 13,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-hover-bg)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "")}
              >
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700,
                  color: "var(--color-accent)", minWidth: 52,
                }}>
                  Note {n.note_number}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {n.title ?? n.note_key}
                </span>
                <span style={{ fontSize: 10, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                  {n.note_key}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Freeform key entry */}
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          {knownKeys.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--color-text-muted)", margin: 0 }}>
              No notes defined yet. Define notes in a package template using{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{"{{note_def:key|title=...}}"}</code>,
              then render the package once to register them.
            </p>
          )}
          <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            Or enter a key manually:
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input input-sm"
              placeholder="e.g. cash"
              value={input}
              onChange={(e) => setInput(e.target.value.toLowerCase().replace(/\s+/g, "_"))}
              onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) onPick(input.trim()); }}
              autoFocus={knownKeys.length === 0}
              style={{ flex: 1, fontFamily: "var(--font-mono)" }}
            />
            <button
              className="btn btn-sm btn-primary"
              disabled={!input.trim()}
              onClick={() => onPick(input.trim())}
            >
              Insert
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: 0 }}>
            The key must match a{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>{"{{note_def:key}}"}</code>{" "}
            tag in your document package. Note numbers are assigned automatically by document order.
          </p>
        </div>
      </div>
    </div>
  );
}

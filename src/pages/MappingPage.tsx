import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { mapNumbersAtom, groupingsAtom, engagementAtom } from "@/store/atoms";
import {
  listMapNumbers, listGroupings,
  upsertMapNumber, deleteMapNumber,
  upsertGrouping, deleteGrouping,
} from "@/lib/tauri";
import type { MapNumber, Grouping } from "@/types";

export default function MappingPage() {
  const [mapNumbers, setMapNumbers] = useAtom(mapNumbersAtom);
  const [groupings, setGroupings] = useAtom(groupingsAtom);
  const [engagement] = useAtom(engagementAtom);
  const [tab, setTab] = useState<"map" | "group">("map");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const [maps, groups] = await Promise.all([listMapNumbers(), listGroupings()]);
    setMapNumbers(maps);
    setGroupings(groups);
  };

  useEffect(() => { refresh().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !!engagement?.is_locked;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <span className="page-header__title">Mapping & Groupings</span>
        <div style={{ display: "flex", gap: 0 }}>
          <button className={`btn btn-sm${tab === "map" ? " btn-primary" : ""}`} onClick={() => setTab("map")}>Map Numbers</button>
          <button className={`btn btn-sm${tab === "group" ? " btn-primary" : ""}`} onClick={() => setTab("group")}>Groupings</button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12 }}>
          {error}
          <button style={{ marginLeft: 8, fontSize: 11 }} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {tab === "map" && (
          <MapNumbersTab
            mapNumbers={mapNumbers}
            groupings={groupings}
            locked={locked}
            onRefresh={refresh}
            onError={setError}
          />
        )}
        {tab === "group" && (
          <GroupingsTab
            groupings={groupings}
            locked={locked}
            onRefresh={refresh}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

// ── Map Numbers tab ───────────────────────────────────────────────────────────

const BLANK_MAP: Omit<MapNumber, "code"> = {
  label: "", parent_code: null, sort_order: 0,
  fs_line: null, default_grouping_id: null, flip_map_code: null,
};

function MapNumbersTab({
  mapNumbers, groupings, locked, onRefresh, onError,
}: {
  mapNumbers: MapNumber[];
  groupings: Grouping[];
  locked: boolean;
  onRefresh: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const [editingCode, setEditingCode] = useState<string | null>(null); // null = none, "__new__" = add row
  const [draft, setDraft] = useState<MapNumber>({ code: "", ...BLANK_MAP });

  const beginEdit = (m: MapNumber) => { setDraft({ ...m }); setEditingCode(m.code); };
  const beginAdd  = () => { setDraft({ code: "", ...BLANK_MAP }); setEditingCode("__new__"); };
  const cancel    = () => setEditingCode(null);

  const save = async () => {
    if (!draft.code.trim() || !draft.label.trim()) { onError("Code and label are required"); return; }
    try {
      await upsertMapNumber({
        code: draft.code.trim(),
        label: draft.label.trim(),
        parent_code: draft.parent_code || null,
        sort_order: draft.sort_order,
        fs_line: draft.fs_line || null,
        default_grouping_id: draft.default_grouping_id ?? null,
        flip_map_code: draft.flip_map_code || null,
      });
      setEditingCode(null);
      await onRefresh();
    } catch (e) { onError(String(e)); }
  };

  const remove = async (code: string) => {
    if (!confirm(`Delete map number ${code}? This will unmap all accounts assigned to it.`)) return;
    try {
      await deleteMapNumber(code);
      await onRefresh();
    } catch (e) { onError(String(e)); }
  };

  const field = (key: keyof MapNumber, placeholder: string, width?: number | string, type = "text") => (
    <input
      className="input input-sm"
      type={type}
      placeholder={placeholder}
      value={(draft[key] as string | number) ?? ""}
      onChange={(e) => setDraft((d) => ({ ...d, [key]: type === "number" ? Number(e.target.value) : e.target.value || null }))}
      style={{ width: width ?? "100%" }}
    />
  );

  const groupSelect = (
    <select
      className="select"
      value={draft.default_grouping_id ?? ""}
      onChange={(e) => setDraft((d) => ({ ...d, default_grouping_id: e.target.value ? Number(e.target.value) : null }))}
      style={{ width: "100%" }}
    >
      <option value="">— none —</option>
      {groupings.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );

  const parentSelect = (
    <select
      className="select"
      value={draft.parent_code ?? ""}
      onChange={(e) => setDraft((d) => ({ ...d, parent_code: e.target.value || null }))}
      style={{ width: "100%" }}
    >
      <option value="">— none —</option>
      {mapNumbers.filter((m) => m.code !== draft.code).map((m) => (
        <option key={m.code} value={m.code}>{m.code} — {m.label}</option>
      ))}
    </select>
  );

  const flipSelect = (
    <select
      className="select"
      value={draft.flip_map_code ?? ""}
      onChange={(e) => setDraft((d) => ({ ...d, flip_map_code: e.target.value || null }))}
      style={{ width: "100%" }}
    >
      <option value="">— none —</option>
      {mapNumbers.filter((m) => m.code !== draft.code).map((m) => (
        <option key={m.code} value={m.code}>{m.code} — {m.label}</option>
      ))}
    </select>
  );

  return (
    <>
      {!locked && (
        <div style={{ marginBottom: 10 }}>
          <button className="btn btn-sm btn-primary" onClick={beginAdd} disabled={editingCode === "__new__"}>
            + Add map number
          </button>
        </div>
      )}

      <table className="data-grid" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th style={{ width: 72 }}>Code</th>
            <th>Label</th>
            <th style={{ width: 90 }}>Parent</th>
            <th style={{ width: 52 }}>Order</th>
            <th style={{ width: 110 }}>Default Group</th>
            <th style={{ width: 110 }}>Flip (negative)</th>
            <th style={{ width: 60 }}></th>
          </tr>
        </thead>
        <tbody>
          {/* Add row */}
          {editingCode === "__new__" && (
            <EditRow
              draft={draft}
              parentSelect={parentSelect} groupSelect={groupSelect} flipSelect={flipSelect}
              field={field} onSave={save} onCancel={cancel} isNew
            />
          )}

          {mapNumbers.map((m) => {
            const grp = groupings.find((g) => g.id === m.default_grouping_id);
            const flip = mapNumbers.find((x) => x.code === m.flip_map_code);

            if (editingCode === m.code) {
              return (
                <EditRow
                  key={m.code}
                  draft={draft}
                  parentSelect={parentSelect} groupSelect={groupSelect} flipSelect={flipSelect}
                  field={field} onSave={save} onCancel={cancel}
                />
              );
            }

            return (
              <tr key={m.code}>
                <td className="mono bold">{m.code}</td>
                <td>{m.label}</td>
                <td className="mono text-muted" style={{ fontSize: 11 }}>{m.parent_code ?? "—"}</td>
                <td className="numeric">{m.sort_order}</td>
                <td>
                  {grp ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      {grp.color && <span style={{ width: 8, height: 8, borderRadius: "50%", background: grp.color, flexShrink: 0 }} />}
                      <span style={{ fontSize: 11 }}>{grp.name}</span>
                    </span>
                  ) : <span className="text-muted">—</span>}
                </td>
                <td>
                  {flip ? (
                    <span style={{ fontSize: 11 }}>
                      <span className="mono" style={{ color: "var(--color-accent)" }}>{flip.code}</span>
                      {" "}{flip.label}
                    </span>
                  ) : <span className="text-muted">—</span>}
                </td>
                <td>
                  {!locked && (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn btn-xs" onClick={() => beginEdit(m)}>Edit</button>
                      <button className="btn btn-xs" style={{ color: "var(--color-danger)" }} onClick={() => remove(m.code)}>✕</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}

          {mapNumbers.length === 0 && editingCode !== "__new__" && (
            <tr>
              <td colSpan={7} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                No map numbers defined
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 12, fontSize: 11, color: "var(--color-text-muted)", lineHeight: 1.6 }}>
        <strong>Flip (negative):</strong> if an account mapped here has a negative balance, it will be
        reported under the flip map code instead. Use this for Cash / Bank Overdraft — map the account
        to Cash (1010), set Flip to Bank Overdraft (2010), and the split happens automatically at report time.
      </div>
    </>
  );
}

function EditRow({
  draft, parentSelect, groupSelect, flipSelect, field, onSave, onCancel, isNew,
}: {
  draft: MapNumber;
  parentSelect: React.ReactNode;
  groupSelect: React.ReactNode;
  flipSelect: React.ReactNode;
  field: (key: keyof MapNumber, placeholder: string, width?: number | string, type?: string) => React.ReactNode;
  onSave: () => void;
  onCancel: () => void;
  isNew?: boolean;
}) {
  return (
    <tr style={{ background: "var(--color-bg-subtle, rgba(255,255,255,0.03))" }}>
      <td>{isNew ? field("code", "1000", 64) : <span className="mono bold">{draft.code}</span>}</td>
      <td>{field("label", "Label")}</td>
      <td>{parentSelect}</td>
      <td>{field("sort_order", "0", 52, "number")}</td>
      <td>{groupSelect}</td>
      <td>{flipSelect}</td>
      <td>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn btn-xs btn-primary" onClick={onSave}>Save</button>
          <button className="btn btn-xs" onClick={onCancel}>✕</button>
        </div>
      </td>
    </tr>
  );
}

// ── Groupings tab ─────────────────────────────────────────────────────────────

function GroupingsTab({
  groupings, locked, onRefresh, onError,
}: {
  groupings: Grouping[];
  locked: boolean;
  onRefresh: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Partial<Grouping>>({});

  const beginEdit = (g: Grouping) => { setDraft({ ...g }); setEditingId(g.id); setAdding(false); };
  const beginAdd  = () => { setDraft({ name: "", description: "", color: "" }); setAdding(true); setEditingId(null); };
  const cancel    = () => { setEditingId(null); setAdding(false); };

  const save = async () => {
    if (!draft.name?.trim()) { onError("Name is required"); return; }
    try {
      await upsertGrouping({
        id: adding ? null : editingId,
        name: draft.name.trim(),
        description: draft.description?.trim() || null,
        color: draft.color?.trim() || null,
      });
      cancel();
      await onRefresh();
    } catch (e) { onError(String(e)); }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this grouping? Accounts will remain but lose this grouping assignment.")) return;
    try {
      await deleteGrouping(id);
      await onRefresh();
    } catch (e) { onError(String(e)); }
  };

  const inlineField = (key: keyof Grouping, placeholder: string, width?: number | string) => (
    <input
      className="input input-sm"
      placeholder={placeholder}
      value={(draft[key] as string) ?? ""}
      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      style={{ width: width ?? "100%" }}
    />
  );

  const editRow = (
    <tr style={{ background: "var(--color-bg-subtle, rgba(255,255,255,0.03))" }}>
      <td className="mono text-muted">{adding ? "new" : editingId}</td>
      <td>{inlineField("name", "Group name")}</td>
      <td>{inlineField("description", "Optional description")}</td>
      <td>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="color"
            value={draft.color || "#888888"}
            onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
            style={{ width: 28, height: 24, padding: 1, border: "1px solid var(--color-border)", cursor: "pointer" }}
          />
          <input
            className="input input-sm"
            placeholder="#hex"
            value={draft.color ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
            style={{ width: 76, fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
        </div>
      </td>
      <td>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn btn-xs btn-primary" onClick={save}>Save</button>
          <button className="btn btn-xs" onClick={cancel}>✕</button>
        </div>
      </td>
    </tr>
  );

  return (
    <>
      {!locked && (
        <div style={{ marginBottom: 10 }}>
          <button className="btn btn-sm btn-primary" onClick={beginAdd} disabled={adding}>
            + Add grouping
          </button>
        </div>
      )}

      <table className="data-grid" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th style={{ width: 44 }}>ID</th>
            <th>Name</th>
            <th>Description</th>
            <th style={{ width: 130 }}>Color</th>
            <th style={{ width: 70 }}></th>
          </tr>
        </thead>
        <tbody>
          {adding && editRow}

          {groupings.map((g) => {
            if (editingId === g.id) return editRow;
            return (
              <tr key={g.id}>
                <td className="mono text-muted">{g.id}</td>
                <td>{g.name}</td>
                <td className="text-muted" style={{ fontSize: 11 }}>{g.description ?? "—"}</td>
                <td>
                  {g.color ? (
                    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                      <span style={{ width: 14, height: 14, background: g.color, border: "1px solid var(--color-border)", borderRadius: 2 }} />
                      <span className="mono" style={{ fontSize: 10 }}>{g.color}</span>
                    </span>
                  ) : <span className="text-muted">—</span>}
                </td>
                <td>
                  {!locked && (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn btn-xs" onClick={() => beginEdit(g)}>Edit</button>
                      <button className="btn btn-xs" style={{ color: "var(--color-danger)" }} onClick={() => remove(g.id)}>✕</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}

          {groupings.length === 0 && !adding && (
            <tr>
              <td colSpan={5} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                No groupings defined
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

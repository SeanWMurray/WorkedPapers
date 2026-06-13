import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { mapNumbersAtom, groupingsAtom, engagementAtom } from "@/store/atoms";
import { listMapNumbers, listGroupings, upsertMapNumber, upsertGrouping } from "@/lib/tauri";
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

  useEffect(() => { refresh().catch(() => {}); }, []);

  // Add map number
  const [newMap, setNewMap] = useState<Partial<MapNumber>>({ code: "", label: "", sort_order: 0 });
  const handleAddMap = async () => {
    if (!newMap.code || !newMap.label) { setError("Code and label required"); return; }
    await upsertMapNumber({ code: newMap.code, label: newMap.label, sort_order: newMap.sort_order ?? 0, parent_code: null, fs_line: null });
    setNewMap({ code: "", label: "", sort_order: 0 });
    await refresh();
  };

  // Add grouping
  const [newGroup, setNewGroup] = useState<Partial<Grouping>>({ name: "", color: "" });
  const handleAddGroup = async () => {
    if (!newGroup.name) { setError("Name required"); return; }
    await upsertGrouping({ name: newGroup.name, color: newGroup.color || null });
    setNewGroup({ name: "", color: "" });
    await refresh();
  };

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

      {error && <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12 }}>{error}</div>}

      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {tab === "map" && (
          <>
            {!locked && (
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input className="input" style={{ width: 80 }} placeholder="Code" value={newMap.code} onChange={(e) => setNewMap(m => ({ ...m, code: e.target.value }))} />
                <input className="input flex-1" placeholder="Label" value={newMap.label} onChange={(e) => setNewMap(m => ({ ...m, label: e.target.value }))} />
                <input className="input" style={{ width: 60 }} type="number" placeholder="Order" value={newMap.sort_order} onChange={(e) => setNewMap(m => ({ ...m, sort_order: Number(e.target.value) }))} />
                <button className="btn btn-primary btn-sm" onClick={handleAddMap}>Add</button>
              </div>
            )}
            <table className="data-grid" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Code</th>
                  <th>Label</th>
                  <th style={{ width: 80 }}>Parent</th>
                  <th style={{ width: 60 }}>Order</th>
                  <th>FS Line</th>
                </tr>
              </thead>
              <tbody>
                {mapNumbers.map((m) => (
                  <tr key={m.code}>
                    <td className="mono bold">{m.code}</td>
                    <td>{m.label}</td>
                    <td className="mono text-muted">{m.parent_code ?? "—"}</td>
                    <td className="numeric">{m.sort_order}</td>
                    <td className="text-muted">{m.fs_line ?? "—"}</td>
                  </tr>
                ))}
                {mapNumbers.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>No map numbers defined</td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}

        {tab === "group" && (
          <>
            {!locked && (
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input className="input flex-1" placeholder="Group Name" value={newGroup.name} onChange={(e) => setNewGroup(g => ({ ...g, name: e.target.value }))} />
                <input className="input" style={{ width: 100 }} placeholder="#hex color" value={newGroup.color ?? ""} onChange={(e) => setNewGroup(g => ({ ...g, color: e.target.value }))} />
                <button className="btn btn-primary btn-sm" onClick={handleAddGroup}>Add</button>
              </div>
            )}
            <table className="data-grid" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ width: 50 }}>ID</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th style={{ width: 80 }}>Color</th>
                </tr>
              </thead>
              <tbody>
                {groupings.map((g) => (
                  <tr key={g.id}>
                    <td className="mono text-muted">{g.id}</td>
                    <td>{g.name}</td>
                    <td className="text-muted">{g.description ?? "—"}</td>
                    <td>
                      {g.color && (
                        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                          <span style={{ width: 12, height: 12, background: g.color, border: "1px solid var(--color-border)" }} />
                          <span className="mono" style={{ fontSize: 10 }}>{g.color}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {groupings.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>No groupings defined</td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

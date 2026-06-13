import { useEffect, useMemo, useState } from "react";
import { listMapNumbers, listGroupings, getTbAccounts } from "@/lib/tauri";
import type { Grouping, MapNumber, TbAccount } from "@/types";

// A modal that lets the user choose *where* a statement line pulls its number
// from, and hands back the corresponding engine token:
//   Map #     -> "M:1000"   (single map) or "SUM(1000..1099)" (range)
//   Grouping  -> "G:3"
//   Account # -> "A:1010-100"
// The caller inserts the returned token into a line's formula expression.

type Tab = "map" | "group" | "account";

interface Props {
  onPick: (token: string) => void;
  onClose: () => void;
}

export default function DataPicker({ onPick, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("map");
  const [maps, setMaps] = useState<MapNumber[]>([]);
  const [groups, setGroups] = useState<Grouping[]>([]);
  const [accounts, setAccounts] = useState<TbAccount[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Map-range mode: when a "from" code is chosen, optionally pick a "to" code.
  const [rangeFrom, setRangeFrom] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listMapNumbers(), listGroupings(), getTbAccounts()])
      .then(([m, g, a]) => {
        setMaps(m);
        setGroups(g);
        setAccounts(a);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Reset transient state when switching tabs.
  useEffect(() => {
    setFilter("");
    setRangeFrom(null);
  }, [tab]);

  const q = filter.trim().toLowerCase();

  const filteredMaps = useMemo(
    () =>
      maps.filter(
        (m) => !q || m.code.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
      ),
    [maps, q]
  );
  const filteredGroups = useMemo(
    () => groups.filter((g) => !q || g.name.toLowerCase().includes(q)),
    [groups, q]
  );
  const filteredAccounts = useMemo(
    () =>
      accounts.filter(
        (a) =>
          !q ||
          a.account_number.toLowerCase().includes(q) ||
          a.account_name.toLowerCase().includes(q)
      ),
    [accounts, q]
  );

  const pick = (token: string) => {
    onPick(token);
    onClose();
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "6px 10px",
    borderBottom: "1px solid var(--color-border)",
    cursor: "pointer",
    fontSize: 13,
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      className={`btn btn-sm${tab === t ? " btn-primary" : ""}`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          width: 520,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Pick data source</span>
          {tabBtn("map", "Map #")}
          {tabBtn("group", "Grouping")}
          {tabBtn("account", "Account #")}
        </div>

        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--color-border)" }}>
          <input
            className="input input-sm"
            autoFocus
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: "100%" }}
          />
          {tab === "map" && (
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6 }}>
              {rangeFrom
                ? `Range from ${rangeFrom} — click a second code for SUM(${rangeFrom}..code), or pick the same to insert M:${rangeFrom}`
                : "Click a code to insert M:code, or use “Start range” to build SUM(a..b)."}
            </div>
          )}
        </div>

        {error && <div style={{ padding: "8px 16px", color: "var(--color-danger)", fontSize: 12 }}>{error}</div>}

        <div style={{ overflow: "auto", flex: 1 }}>
          {tab === "map" &&
            filteredMaps.map((m) => (
              <div key={m.code} style={rowStyle} className="picker-row">
                <span
                  style={{ flex: 1 }}
                  onClick={() => {
                    if (rangeFrom) {
                      pick(
                        rangeFrom === m.code
                          ? `M:${m.code}`
                          : `SUM(${rangeFrom}..${m.code})`
                      );
                    } else {
                      pick(`M:${m.code}`);
                    }
                  }}
                >
                  <span className="mono bold">{m.code}</span>{" "}
                  <span style={{ color: "var(--color-text-muted)" }}>{m.label}</span>
                </span>
                <button
                  className="btn btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRangeFrom(m.code);
                  }}
                >
                  {rangeFrom === m.code ? "From ✓" : "Start range"}
                </button>
              </div>
            ))}

          {tab === "group" &&
            filteredGroups.map((g) => (
              <div key={g.id} style={rowStyle} onClick={() => pick(`G:${g.id}`)}>
                <span>
                  {g.color && (
                    <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: g.color, marginRight: 8 }} />
                  )}
                  {g.name}
                </span>
                <span className="mono" style={{ color: "var(--color-text-muted)" }}>G:{g.id}</span>
              </div>
            ))}

          {tab === "account" &&
            filteredAccounts.map((a) => (
              <div key={a.id} style={rowStyle} onClick={() => pick(`A:${a.account_number}`)}>
                <span>
                  <span className="mono bold">{a.account_number}</span>{" "}
                  <span style={{ color: "var(--color-text-muted)" }}>{a.account_name}</span>
                </span>
                <span className="mono" style={{ color: "var(--color-text-muted)" }}>A:{a.account_number}</span>
              </div>
            ))}

          {tab === "map" && filteredMaps.length === 0 && <Empty />}
          {tab === "group" && filteredGroups.length === 0 && <Empty />}
          {tab === "account" && filteredAccounts.length === 0 && <Empty />}
        </div>

        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)", textAlign: "right" }}>
          <button className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div style={{ padding: "24px 0", textAlign: "center", color: "var(--color-text-muted)", fontSize: 12 }}>
      Nothing here — set this up in Mapping / Trial Balance first
    </div>
  );
}

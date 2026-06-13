import { useState, useCallback, useEffect } from "react";
import { useAtom } from "jotai";
import { mapNumbersAtom, groupingsAtom, settingsAtom, engagementAtom, activeLeadsheetAtom } from "@/store/atoms";
import { getLeadsheet, listMapNumbers, listGroupings, saveLeadsheetNote, signOff, removeSignoff, getSignoffs } from "@/lib/tauri";
import { formatAccounting } from "@/lib/format";
import type { Leadsheet, Signoff, SignoffRole } from "@/types";

const ROLES: SignoffRole[] = ["PREPARER", "REVIEWER", "PARTNER"];
const ROLE_LABEL: Record<SignoffRole, string> = {
  PREPARER: "Prep",
  REVIEWER: "Rev",
  PARTNER: "Ptr",
};

// ── Sign-off chip strip ────────────────────────────────────────────────────────

function SignoffStrip({
  scope,
  signoffs,
  currentUser,
  currentInitials,
  locked,
  onChanged,
}: {
  scope: string;
  signoffs: Signoff[];
  currentUser: string;
  currentInitials: string;
  locked: boolean;
  onChanged: () => void;
}) {
  const byRole = (role: SignoffRole) => signoffs.filter((s) => s.role === role);

  const handleSign = async (role: SignoffRole) => {
    await signOff(scope, role, currentUser, currentInitials);
    onChanged();
  };

  const handleRemove = async (s: Signoff) => {
    await removeSignoff(s.id, currentUser);
    onChanged();
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {ROLES.map((role) => {
        const entries = byRole(role);
        const myEntry = entries.find((s) => s.signed_by === currentUser);
        return (
          <div key={role} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.05em", color: "var(--color-text-muted)",
              marginRight: 2,
            }}>
              {ROLE_LABEL[role]}
            </span>

            {/* Existing signoff chips */}
            {entries.map((s) => {
              const isMe = s.signed_by === currentUser;
              const initials = s.signed_initials || s.signed_by.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase().slice(0, 3);
              return (
                <div
                  key={s.id}
                  title={`${s.signed_by} — ${new Date(s.signed_at).toLocaleDateString()}\n${isMe && !locked ? "Click to remove" : ""}`}
                  onClick={() => { if (isMe && !locked) handleRemove(s); }}
                  style={{
                    width: 26, height: 22,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: isMe ? "var(--color-primary)" : "var(--color-surface)",
                    border: `1px solid ${isMe ? "var(--color-primary)" : "var(--color-border-strong)"}`,
                    borderRadius: 3,
                    fontSize: 10, fontWeight: 700,
                    color: isMe ? "#fff" : "var(--color-text)",
                    cursor: isMe && !locked ? "pointer" : "default",
                    fontFamily: "var(--font-mono)",
                    userSelect: "none",
                  }}
                >
                  {initials || "?"}
                </div>
              );
            })}

            {/* Add chip — only if not locked and current user hasn't signed this role yet */}
            {!locked && !myEntry && (
              <div
                title={`Sign off as ${role}`}
                onClick={() => handleSign(role)}
                style={{
                  width: 26, height: 22,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: "1px dashed var(--color-border-strong)",
                  borderRadius: 3,
                  fontSize: 14, lineHeight: 1,
                  color: "var(--color-text-muted)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                +
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function LeadsheetPage() {
  const [mapNumbers, setMapNumbers] = useAtom(mapNumbersAtom);
  const [groupings, setGroupings] = useAtom(groupingsAtom);
  const [settings] = useAtom(settingsAtom);
  const [engagement] = useAtom(engagementAtom);
  const [activeLeadsheet, setActiveLeadsheet] = useAtom(activeLeadsheetAtom);

  const [query, setQuery] = useState<{ type: "map" | "group"; key: string } | null>(null);
  const [sheet, setSheet] = useState<Leadsheet | null>(null);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ensure map numbers and groupings are loaded regardless of whether MappingPage has been visited
  useEffect(() => {
    if (mapNumbers.length === 0 || groupings.length === 0) {
      Promise.all([listMapNumbers(), listGroupings()])
        .then(([maps, grps]) => {
          if (mapNumbers.length === 0) setMapNumbers(maps);
          if (groupings.length === 0) setGroupings(grps);
        })
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Consume a pending navigation request from the file cabinet
  useEffect(() => {
    if (!activeLeadsheet) return;
    const { type, key } = activeLeadsheet;
    setActiveLeadsheet(null);
    openSheet(type, String(key));
  }, []); // intentionally runs once on mount only

  const scopeFor = (type: "map" | "group", key: string) =>
    type === "map" ? `leadsheet:${key}` : `leadsheet-group:${key}`;

  const loadSignoffs = useCallback(async (type: "map" | "group", key: string) => {
    const scope = scopeFor(type, key);
    const data = await getSignoffs(scope);
    setSignoffs(data);
  }, []);

  const openSheet = useCallback(async (type: "map" | "group", key: string) => {
    setLoading(true);
    setError(null);
    try {
      const ls = await getLeadsheet(
        type === "map" ? { map_number: key } : { grouping_id: Number(key) }
      );
      setSheet(ls);
      setNotes(ls.notes ?? "");
      setQuery({ type, key });
      await loadSignoffs(type, key);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [loadSignoffs]);

  const handleSaveNotes = async () => {
    if (!query || !sheet) return;
    const scope = query.type === "map" ? `map:${query.key}` : `group:${query.key}`;
    await saveLeadsheetNote(scope, notes, settings.user_name);
  };

  const currency = engagement?.currency ?? "USD";

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* Left: map/group selector */}
      <div style={{ width: 200, borderRight: "1px solid var(--color-border)", overflow: "auto" }}>
        {mapNumbers.length === 0 && groupings.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--color-text-muted)" }}>
            No map numbers or groupings. Set them up in Mapping.
          </div>
        )}

        {mapNumbers.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section__label">Map Numbers</div>
            {mapNumbers.map((m) => (
              <button
                key={m.code}
                className={`sidebar-nav-item${query?.type === "map" && query.key === m.code ? " active" : ""}`}
                onClick={() => openSheet("map", m.code)}
              >
                <span className="mono" style={{ fontSize: 11 }}>{m.code}</span>
                <span style={{ fontSize: 11, color: "inherit" }}>{m.label}</span>
              </button>
            ))}
          </div>
        )}

        {groupings.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section__label">Groupings</div>
            {groupings.map((g) => (
              <button
                key={g.id}
                className={`sidebar-nav-item${query?.type === "group" && query.key === String(g.id) ? " active" : ""}`}
                onClick={() => openSheet("group", String(g.id))}
              >
                {g.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: leadsheet content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {loading && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--color-text-muted)" }}>Loading…</div>
        )}
        {error && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--color-danger)" }}>{error}</div>
        )}

        {sheet && !loading && (
          <>
            <div className="page-header" style={{ gap: 12 }}>
              <span className="page-header__title">{sheet.title}</span>
              <div style={{ flex: 1 }} />
              {query && (
                <SignoffStrip
                  scope={scopeFor(query.type, query.key)}
                  signoffs={signoffs}
                  currentUser={settings.user_name}
                  currentInitials={settings.user_initials}
                  locked={!!engagement?.is_locked}
                  onChanged={() => loadSignoffs(query.type, query.key)}
                />
              )}
            </div>

            <div style={{ flex: 1, overflow: "auto" }}>
              <table className="data-grid">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Account #</th>
                    <th>Name</th>
                    <th style={{ width: 130, textAlign: "right" }}>Current (adj)</th>
                    <th style={{ width: 130, textAlign: "right" }}>Prior Year</th>
                    <th style={{ width: 80 }}>Map</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.accounts.map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.account_number}</td>
                      <td>{a.account_name}</td>
                      <td className="numeric" style={{ color: a.current_balance < 0 ? "var(--color-danger)" : undefined }}>
                        {formatAccounting(a.current_balance, currency)}
                      </td>
                      <td className="numeric text-muted">
                        {formatAccounting(a.prior_balance, currency)}
                      </td>
                      <td className="mono text-muted">{a.map_number ?? "—"}</td>
                    </tr>
                  ))}
                  {sheet.accounts.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                        No accounts in this leadsheet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Notes panel */}
            <div style={{ borderTop: "1px solid var(--color-border)", padding: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)", marginBottom: 4 }}>
                Notes
              </div>
              <textarea
                style={{
                  width: "100%",
                  height: 72,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  border: "1px solid var(--color-border)",
                  padding: "4px 8px",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  resize: "vertical",
                }}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={!!engagement?.is_locked}
              />
              {!engagement?.is_locked && (
                <button className="btn btn-sm" style={{ marginTop: 4 }} onClick={handleSaveNotes}>
                  Save Notes
                </button>
              )}
            </div>
          </>
        )}

        {!sheet && !loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--color-text-muted)", fontSize: 12 }}>
            Select a map number or grouping to open a leadsheet
          </div>
        )}
      </div>
    </div>
  );
}

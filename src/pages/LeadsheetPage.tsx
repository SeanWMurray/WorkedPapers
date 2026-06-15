import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAtom, useSetAtom } from "jotai";
import { mapNumbersAtom, groupingsAtom, settingsAtom, engagementAtom, activeLeadsheetAtom, activeDocTemplateAtom } from "@/store/atoms";
import { getLeadsheet, listMapNumbers, listGroupings, saveLeadsheetNote, signOff, removeSignoff, getSignoffs, getAnnotations, upsertAnnotation, getCabinet, openAttachment } from "@/lib/tauri";
import { formatAccounting } from "@/lib/format";
import type { Leadsheet, Signoff, SignoffRole, LeadsheetAnnotation, CabinetItem, CabinetFolder, CabinetTree } from "@/types";

const ROLES: SignoffRole[] = ["PREPARER", "REVIEWER", "PARTNER"];
const ROLE_SHORT: Record<SignoffRole, string> = { PREPARER: "Prep", REVIEWER: "Rev", PARTNER: "Ptr" };

// ── Note cell — hover to read, double-click to edit ───────────────────────────

function NoteCell({
  note, locked, onSave,
}: {
  note: string | null;
  locked: boolean;
  onSave: (note: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [hovered, setHovered] = useState(false);
  const hasNote = !!note?.trim();

  const openEdit = () => {
    setDraft(note ?? "");
    setOpen(true);
  };

  const commit = () => {
    setOpen(false);
    onSave(draft.trim() || null);
  };

  return (
    <td style={{ width: 32, padding: "0 4px", textAlign: "center", position: "relative" }}>
      {hasNote ? (
        <span
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onDoubleClick={locked ? undefined : openEdit}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 18, height: 18, borderRadius: "50%",
            background: "#2563eb", color: "#fff",
            border: "2px solid #1d4ed8",
            fontSize: 10, fontWeight: 700,
            cursor: locked ? "default" : "pointer",
            userSelect: "none",
          }}
        >
          i
          {hovered && (
            <div style={{
              position: "fixed", zIndex: 200,
              background: "var(--color-surface)", border: "1px solid var(--color-border-strong)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
              padding: "6px 10px", minWidth: 160, maxWidth: 280,
              fontSize: 11, fontFamily: "var(--font-mono)",
              color: "var(--color-text)", textAlign: "left",
              whiteSpace: "pre-wrap", lineHeight: 1.5,
              pointerEvents: "none",
              transform: "translate(-100%, -100%)",
            }}>
              {note}
            </div>
          )}
        </span>
      ) : !locked ? (
        <span
          onDoubleClick={openEdit}
          title="Double-click to add note"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 18, height: 18, borderRadius: "50%",
            background: "transparent", color: "#6b7280",
            border: "2px solid #6b7280",
            fontSize: 10, fontWeight: 700,
            cursor: "pointer", userSelect: "none",
          }}
        >
          i
        </span>
      ) : null}

      {open && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 500,
            background: "rgba(0,0,0,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => setOpen(false)}
        >
          <div
            style={{
              background: "var(--color-bg)", border: "1px solid var(--color-border-strong)",
              padding: 16, width: 320, display: "flex", flexDirection: "column", gap: 10,
              boxShadow: "0 6px 24px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 12, fontWeight: 700 }}>Note</div>
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
              }}
              style={{
                width: "100%", fontFamily: "var(--font-mono)", fontSize: 12,
                border: "1px solid var(--color-border)", padding: "4px 8px",
                background: "var(--color-bg)", color: "var(--color-text)", resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-sm" onClick={() => setOpen(false)}>Cancel</button>
              {draft.trim() && <button className="btn btn-sm" style={{ color: "var(--color-danger)" }} onClick={() => { setOpen(false); onSave(null); }}>Clear</button>}
              <button className="btn btn-sm btn-primary" onClick={commit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </td>
  );
}

// ── File ref icon — single click opens, double-click to change ───────────────

function FileRefIcon({
  ann, locked, onOpen, onChangePicker, onRemove,
}: {
  ann: LeadsheetAnnotation;
  locked: boolean;
  onOpen: () => void;
  onChangePicker: () => void;
  onRemove: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  return (
    <>
      <span
        title={ann.cabinet_item_name ?? "File reference"}
        onClick={onOpen}
        onContextMenu={(e) => {
        e.preventDefault();
        const menuWidth = 160;
        const menuHeight = 100;
        const x = e.clientX + menuWidth > window.innerWidth ? e.clientX - menuWidth : e.clientX;
        const y = e.clientY + menuHeight > window.innerHeight ? e.clientY - menuHeight : e.clientY;
        setMenu({ x, y });
      }}
        style={{ cursor: "pointer", fontSize: 13 }}
      >
        📎
      </span>
      {menu && (
        <div
          style={{
            position: "fixed", zIndex: 500, left: menu.x, top: menu.y,
            background: "var(--color-bg)", border: "1px solid var(--color-border-strong)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)", minWidth: 160, padding: "2px 0", fontSize: 12,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            onClick={() => { setMenu(null); onOpen(); }}
            style={{ padding: "5px 14px", cursor: "pointer" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
          >
            Open
          </div>
          {!locked && <>
            <div
              onClick={() => { setMenu(null); onChangePicker(); }}
              style={{ padding: "5px 14px", cursor: "pointer" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
            >
              Change…
            </div>
            <div style={{ borderTop: "1px solid var(--color-border)", margin: "2px 0" }} />
            <div
              onClick={() => { setMenu(null); onRemove(); }}
              style={{ padding: "5px 14px", cursor: "pointer", color: "var(--color-danger)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
            >
              Remove
            </div>
          </>}
        </div>
      )}
    </>

  );
}

// ── Mini file cabinet picker ──────────────────────────────────────────────────

type CabinetTreeNode =
  | { kind: "folder"; folder: CabinetFolder; depth: number }
  | { kind: "item"; item: CabinetItem; depth: number };

function buildCabinetTree(
  folders: CabinetFolder[],
  items: CabinetItem[],
  parentId: number | null,
  depth: number,
  collapsed: Set<number>,
): CabinetTreeNode[] {
  const childFolders = folders
    .filter((f) => f.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const childItems = items
    .filter((i) => i.folder_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name));
  const nodes: CabinetTreeNode[] = [];
  for (const folder of childFolders) {
    nodes.push({ kind: "folder", folder, depth });
    if (!collapsed.has(folder.id)) {
      nodes.push(...buildCabinetTree(folders, items, folder.id, depth + 1, collapsed));
    }
  }
  for (const item of childItems) {
    nodes.push({ kind: "item", item, depth });
  }
  return nodes;
}

function FilePicker({
  tree,
  currentItemId,
  dbPath,
  onSelect,
  onClear,
  onClose,
}: {
  tree: CabinetTree;
  currentItemId: number | null;
  dbPath: string | undefined;
  onSelect: (item: CabinetItem) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const nodes = buildCabinetTree(tree.folders, tree.items, null, 0, collapsed);

  const handleOpen = async (item: CabinetItem) => {
    if (item.kind === "file" && item.file_path && dbPath) {
      const dir = dbPath.replace(/[/\\][^/\\]+$/, "");
      const sep = dbPath.includes("\\") ? "\\" : "/";
      await openAttachment(`${dir}${sep}${item.file_path}`).catch(() => {});
    }
  };

  const toggleFolder = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--color-bg)", border: "1px solid var(--color-border-strong)",
          width: 380, maxHeight: 520, display: "flex", flexDirection: "column",
          boxShadow: "0 6px 24px rgba(0,0,0,0.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: "8px 12px", borderBottom: "1px solid var(--color-border)",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Select File Reference</span>
          <button className="btn btn-sm" onClick={onClear} style={{ color: "var(--color-danger)" }}>Clear</button>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
        </div>

        {/* Tree */}
        <div style={{ flex: 1, overflow: "auto", userSelect: "none" }}>
          {nodes.length === 0 && (
            <div style={{ padding: 16, fontSize: 12, color: "var(--color-text-muted)", textAlign: "center" }}>
              No items in cabinet
            </div>
          )}
          {nodes.map((node) => {
            if (node.kind === "folder") {
              const isCollapsed = collapsed.has(node.folder.id);
              return (
                <div
                  key={`f-${node.folder.id}`}
                  style={{
                    display: "flex", alignItems: "center",
                    paddingLeft: 8 + node.depth * 14, paddingRight: 8,
                    height: 24, fontSize: 12, cursor: "default",
                    borderBottom: "1px solid transparent",
                  }}
                  onClick={() => toggleFolder(node.folder.id)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
                >
                  <span style={{ fontSize: 9, color: "var(--color-text-muted)", width: 12, flexShrink: 0, textAlign: "center" }}>
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <span style={{ marginRight: 5, fontSize: 12 }}>{isCollapsed ? "📁" : "📂"}</span>
                  <span style={{ fontWeight: 600 }}>{node.folder.name}</span>
                </div>
              );
            }

            const { item } = node;
            const isSelected = item.id === currentItemId;
            return (
              <div
                key={`i-${item.id}`}
                style={{
                  display: "flex", alignItems: "center",
                  paddingLeft: 8 + node.depth * 14 + 12, paddingRight: 8,
                  height: 24, fontSize: 12, cursor: "pointer",
                  background: isSelected ? "var(--color-primary-subtle, rgba(var(--color-primary-rgb,0,0,0),0.08))" : undefined,
                  borderLeft: isSelected ? "2px solid var(--color-primary)" : "2px solid transparent",
                }}
                onClick={() => onSelect(item)}
                onDoubleClick={() => handleOpen(item)}
                onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
                onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = ""; }}
                title={`Click to select · Double-click to open`}
              >
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700,
                  padding: "0 3px", border: "1px solid var(--color-border)",
                  marginRight: 7, flexShrink: 0, minWidth: 24, textAlign: "center",
                  color: (item.kind === "leadsheet" || item.kind === "document") ? "var(--color-primary)" : undefined,
                }}>
                  {item.kind === "leadsheet" ? "LS" : item.kind === "document" ? "DOC" : "FILE"}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.display_name}
                </span>
                {isSelected && (
                  <span style={{ fontSize: 10, color: "var(--color-primary)", marginLeft: 4 }}>✓</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SignoffRow({
  scope, signoffs, currentUser, currentInitials, locked, onChanged,
}: {
  scope: string; signoffs: Signoff[]; currentUser: string;
  currentInitials: string; locked: boolean; onChanged: () => void;
}) {
  const handleClick = async (role: SignoffRole) => {
    if (locked) return;
    const myEntry = signoffs.find((s) => s.role === role && s.signed_by === currentUser);
    if (myEntry) {
      await removeSignoff(myEntry.id, currentUser);
    } else {
      await signOff(scope, role, currentUser, currentInitials);
    }
    onChanged();
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {ROLES.map((role) => {
        const signers = signoffs.filter((s) => s.role === role);
        return (
          <div key={role} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)" }}>
              {ROLE_SHORT[role]}
            </span>
            {signers.length > 0 ? (
              <span
                title={signers.map((s) => s.signed_by).join(", ")}
                onClick={() => handleClick(role)}
                style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--color-primary)", cursor: locked ? "default" : "pointer" }}
              >
                {signers.map((s) => s.signed_initials || s.signed_by.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase()).join("/")}
              </span>
            ) : !locked ? (
              <span
                onClick={() => handleClick(role)}
                style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-text-muted)", cursor: "pointer" }}
              >
                —
              </span>
            ) : null}
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
  const setActiveDocTemplate = useSetAtom(activeDocTemplateAtom);
  const navigate = useNavigate();

  const [query, setQuery] = useState<{ type: "map" | "group"; key: string } | null>(null);
  const [sheet, setSheet] = useState<Leadsheet | null>(null);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [annotations, setAnnotations] = useState<LeadsheetAnnotation[]>([]);
  const [cabinetTree, setCabinetTree] = useState<CabinetTree | null>(null);
  const [filePickerAccount, setFilePickerAccount] = useState<string | null>(null);
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
    const data = await getSignoffs(scopeFor(type, key));
    setSignoffs(data);
  }, []);

  const loadAnnotations = useCallback(async (type: "map" | "group", key: string) => {
    const scope = type === "map" ? `map:${key}` : `group:${key}`;
    const data = await getAnnotations(scope);
    setAnnotations(data);
  }, []);

  const openSheet = useCallback(async (type: "map" | "group", key: string) => {
    setLoading(true);
    setError(null);
    try {
      const [ls, cabinet] = await Promise.all([
        getLeadsheet(type === "map" ? { map_number: key } : { grouping_id: Number(key) }),
        getCabinet(),
      ]);
      setSheet(ls);
      setNotes(ls.notes ?? "");
      setQuery({ type, key });
      setCabinetTree(cabinet);
      await Promise.all([loadSignoffs(type, key), loadAnnotations(type, key)]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [loadSignoffs, loadAnnotations]);

  const annotationScope = query
    ? (query.type === "map" ? `map:${query.key}` : `group:${query.key}`)
    : "";

  const handleSaveNotes = async () => {
    if (!query || !sheet) return;
    await saveLeadsheetNote(annotationScope, notes, settings.user_name);
  };

  const handleSaveNote = async (accountNumber: string, note: string | null) => {
    if (!query) return;
    const existing = annotations.find(x => x.account_number === accountNumber);
    await upsertAnnotation({
      account_number: accountNumber,
      scope: annotationScope,
      note,
      cabinet_item_id: existing?.cabinet_item_id ?? null,
    }, settings.user_name);
    await loadAnnotations(query.type, query.key);
  };

  const handleSaveFileRef = async (accountNumber: string, cabinetItemId: number | null) => {
    if (!query) return;
    const existing = annotations.find(x => x.account_number === accountNumber);
    await upsertAnnotation({
      account_number: accountNumber,
      scope: annotationScope,
      note: existing?.note ?? null,
      cabinet_item_id: cabinetItemId,
    }, settings.user_name);
    await loadAnnotations(query.type, query.key);
    setFilePickerAccount(null);
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
                <SignoffRow
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
                    <th style={{ width: 120, textAlign: "right" }}>Prelim</th>
                    <th style={{ width: 110, textAlign: "right" }}>AJEs</th>
                    <th style={{ width: 110, textAlign: "right" }}>Reclass</th>
                    <th style={{ width: 120, textAlign: "right" }}>Final</th>
                    <th style={{ width: 120, textAlign: "right" }}>Prior Year</th>
                    <th style={{ width: 32 }}></th>
                    <th style={{ width: 32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.accounts.map((a) => {
                    const ann = annotations.find(x => x.account_number === a.account_number);
                    const locked = !!engagement?.is_locked;
                    return (
                      <tr key={a.id} style={{ position: "relative" }}>
                        <td className="mono">{a.account_number}</td>
                        <td>{a.account_name}</td>
                        <td className="numeric text-muted">
                          {formatAccounting(a.prelim_balance, currency)}
                        </td>
                        <td className="numeric" style={{ color: a.adjustment_net !== 0 ? "var(--color-primary)" : "var(--color-text-muted)" }}>
                          {a.adjustment_net !== 0 ? formatAccounting(a.adjustment_net, currency) : "—"}
                        </td>
                        <td className="numeric" style={{ color: a.reclass_net !== 0 ? "var(--color-primary)" : "var(--color-text-muted)" }}>
                          {a.reclass_net !== 0 ? formatAccounting(a.reclass_net, currency) : "—"}
                        </td>
                        <td className="numeric" style={{ fontWeight: 600, color: a.current_balance < 0 ? "var(--color-danger)" : undefined }}>
                          {formatAccounting(a.current_balance, currency)}
                        </td>
                        <td className="numeric text-muted">
                          {formatAccounting(a.prior_balance, currency)}
                        </td>
                        <NoteCell
                          note={ann?.note ?? null}
                          locked={locked}
                          onSave={(note) => handleSaveNote(a.account_number, note)}
                        />
                                        <td style={{ padding: "0 4px", textAlign: "center" }}>
                          {ann?.cabinet_item_id ? (
                            <FileRefIcon
                              ann={ann}
                              locked={locked}
                              onOpen={() => {
                                const item = cabinetTree?.items.find(i => i.id === ann.cabinet_item_id);
                                if (!item) return;
                                if (item.kind === "leadsheet" && item.leadsheet_scope) {
                                  const scope = item.leadsheet_scope;
                                  if (scope.startsWith("map:")) setActiveLeadsheet({ type: "map", key: scope.slice(4) });
                                  else if (scope.startsWith("group:")) setActiveLeadsheet({ type: "group", key: scope.slice(6) });
                                  navigate("/leadsheet");
                                } else if (item.kind === "document" && item.doc_template_id != null) {
                                  setActiveDocTemplate(item.doc_template_id);
                                  navigate("/documents");
                                } else if (item.kind === "file" && item.file_path && engagement?.db_path) {
                                  const dir = engagement.db_path.replace(/[/\\][^/\\]+$/, "");
                                  const sep = engagement.db_path.includes("\\") ? "\\" : "/";
                                  openAttachment(`${dir}${sep}${item.file_path}`).catch((e) => setError(String(e)));
                                }
                              }}
                              onChangePicker={() => setFilePickerAccount(a.account_number)}
                              onRemove={() => handleSaveFileRef(a.account_number, null)}
                            />
                          ) : !locked ? (
                            <span
                              onClick={() => setFilePickerAccount(a.account_number)}
                              title="Click to attach file reference"
                              style={{ cursor: "pointer", opacity: 0.25, fontSize: 12, userSelect: "none" }}
                            >
                              📎
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  {sheet.accounts.length === 0 && (
                    <tr>
                      <td colSpan={9} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                        No accounts in this leadsheet
                      </td>
                    </tr>
                  )}
                </tbody>
                {sheet.accounts.length > 0 && (() => {
                  const totPrelim = sheet.accounts.reduce((s, a) => s + a.prelim_balance, 0);
                  const totAdj    = sheet.accounts.reduce((s, a) => s + a.adjustment_net, 0);
                  const totRcl    = sheet.accounts.reduce((s, a) => s + a.reclass_net, 0);
                  const totFinal  = sheet.accounts.reduce((s, a) => s + a.current_balance, 0);
                  const totPrior  = sheet.accounts.reduce((s, a) => s + a.prior_balance, 0);
                  return (
                    <tfoot>
                      <tr style={{ borderTop: "2px solid var(--color-border-strong)", fontWeight: 700 }}>
                        <td colSpan={2} style={{ paddingLeft: 8 }}>Total</td>
                        <td className="numeric">{formatAccounting(totPrelim, currency)}</td>
                        <td className="numeric">{totAdj !== 0 ? formatAccounting(totAdj, currency) : "—"}</td>
                        <td className="numeric">{totRcl !== 0 ? formatAccounting(totRcl, currency) : "—"}</td>
                        <td className="numeric">{formatAccounting(totFinal, currency)}</td>
                        <td className="numeric">{formatAccounting(totPrior, currency)}</td>
                        <td /><td />
                      </tr>
                    </tfoot>
                  );
                })()}
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

      {filePickerAccount && cabinetTree && (
        <FilePicker
          tree={cabinetTree}
          currentItemId={annotations.find(x => x.account_number === filePickerAccount)?.cabinet_item_id ?? null}
          dbPath={engagement?.db_path}
          onSelect={(item) => handleSaveFileRef(filePickerAccount, item.id)}
          onClear={() => handleSaveFileRef(filePickerAccount, null)}
          onClose={() => setFilePickerAccount(null)}
        />
      )}
    </div>
  );
}

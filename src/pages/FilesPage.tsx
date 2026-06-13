import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAtom, useSetAtom } from "jotai";
import { engagementAtom, activeLeadsheetAtom, mapNumbersAtom, groupingsAtom } from "@/store/atoms";
import {
  getCabinet,
  createFolder,
  renameFolder,
  deleteFolder,
  upsertCabinetItem,
  deleteCabinetItem,
  moveCabinetItem,
  moveCabinetFolder,
  attachFile,
  removeAttachment,
  openAttachment,
  open,
  listMapNumbers,
  listGroupings,
} from "@/lib/tauri";
import { appWindow } from "@tauri-apps/api/window";
import type { CabinetFolder, CabinetItem, CabinetTree, AttachedFile, MapNumber, Grouping } from "@/types";

// ── Constants & utils ─────────────────────────────────────────────────────────

const FILE_ICON: Record<string, string> = {
  pdf: "PDF", xlsx: "XLS", xls: "XLS", csv: "CSV",
  docx: "DOC", doc: "DOC", png: "IMG", jpg: "IMG", jpeg: "IMG", txt: "TXT",
};

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function scopeLabel(scope: string) {
  if (scope.startsWith("map:")) return `Map ${scope.slice(4)}`;
  if (scope.startsWith("group:")) return `Group ${scope.slice(6)}`;
  return scope;
}

// ── Flat tree node type (built from DB data for rendering) ────────────────────

type TreeNode =
  | { kind: "folder"; folder: CabinetFolder; depth: number }
  | { kind: "item"; item: CabinetItem; depth: number; diskMeta: AttachedFile | null };

function buildTree(
  folders: CabinetFolder[],
  items: CabinetItem[],
  diskMap: Map<string, AttachedFile>,
  parentId: number | null,
  depth: number,
  collapsed: Set<number>,
): TreeNode[] {
  const childFolders = folders
    .filter((f) => f.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  const childItems = items
    .filter((i) => i.folder_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name));

  const nodes: TreeNode[] = [];

  for (const folder of childFolders) {
    nodes.push({ kind: "folder", folder, depth });
    if (!collapsed.has(folder.id)) {
      nodes.push(...buildTree(folders, items, diskMap, folder.id, depth + 1, collapsed));
    }
  }

  for (const item of childItems) {
    nodes.push({
      kind: "item",
      item,
      depth,
      // Match case-insensitively — Windows filenames are case-insensitive, so a
      // stored "Report.pdf" must still match an on-disk "report.pdf".
      diskMeta: item.file_path ? (diskMap.get(item.file_path.toLowerCase()) ?? null) : null,
    });
  }

  return nodes;
}

// ── Drag state ────────────────────────────────────────────────────────────────

type DragPayload =
  | { kind: "item"; id: number }
  | { kind: "folder"; id: number };

// ── Drop indicator ────────────────────────────────────────────────────────────

type DropTarget =
  | { type: "before-folder"; folderId: number }
  | { type: "into-folder"; folderId: number }
  | { type: "after-item"; itemId: number; folderId: number | null }
  | { type: "root" };

// ── Main component ────────────────────────────────────────────────────────────

export default function FilesPage() {
  const [engagement] = useAtom(engagementAtom);
  const [mapNumbers, setMapNumbers] = useAtom(mapNumbersAtom);
  const [groupings, setGroupings] = useAtom(groupingsAtom);
  const setActiveLeadsheet = useSetAtom(activeLeadsheetAtom);
  const navigate = useNavigate();

  const [tree, setTree] = useState<CabinetTree | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [osDragging, setOsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline editing
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renamingValue, setRenamingValue] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<number | null | "none">("none"); // "none" = not creating
  const [newFolderName, setNewFolderName] = useState("");

  // Leadsheet link modal
  const [linkModal, setLinkModal] = useState<{ folderId: number | null } | null>(null);
  const [linkScope, setLinkScope] = useState("");
  const [linkName, setLinkName] = useState("");

  // Drag-and-drop
  const dragPayload = useRef<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // True while an *in-app* HTML5 drag is in progress. External Explorer drags
  // never fire dragstart, so this stays false for them — letting us tell the two
  // apart and suppress the Tauri OS-drop overlay during internal reorganizing.
  const isInternalDrag = useRef(false);
  // State mirror of the ref, used to toggle pointer-events on row children so the
  // row itself stays the drop target (otherwise hovering a child span shows the
  // "no-drop" cursor because the child never calls preventDefault).
  const [draggingActive, setDraggingActive] = useState(false);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const t = await getCabinet();
      setTree(t);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    if (mapNumbers.length === 0) listMapNumbers().then(setMapNumbers).catch(() => {});
    if (groupings.length === 0) listGroupings().then(setGroupings).catch(() => {});
  }, [refresh]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [ctxMenu]);

  // OS file drop (external files dragged from Explorer). We ignore these events
  // entirely while an in-app drag is happening so the overlay never hijacks
  // internal reorganizing.
  useEffect(() => {
    const unlisten = appWindow.onFileDropEvent((event) => {
      if (isInternalDrag.current) {
        setOsDragging(false);
        return;
      }
      if (event.payload.type === "hover") {
        setOsDragging(true);
      } else if (event.payload.type === "drop") {
        setOsDragging(false);
        const paths = event.payload.paths;
        if (!paths.length) return;
        // External files land at root; the user can then drag them into a folder.
        // (Tauri 1.x drop events don't carry cursor coordinates, so we can't tell
        // which folder the drop landed on.)
        (async () => {
          for (const p of paths) {
            const attached = await attachFile(p);
            await upsertCabinetItem({
              folder_id: null,
              kind: "file",
              display_name: attached.name,
              file_path: attached.name,
            });
          }
          await refresh();
        })().catch((e) => setError(String(e)));
      } else {
        setOsDragging(false);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [refresh]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleAttachFiles = async () => {
    const selected = await open({ title: "Attach Files", multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const p of paths) {
      const attached = await attachFile(p);
      await upsertCabinetItem({
        folder_id: null,
        kind: "file",
        display_name: attached.name,
        file_path: attached.name,
      });
    }
    await refresh();
  };

  const handleOpenItem = async (item: CabinetItem) => {
    if (item.kind === "leadsheet" && item.leadsheet_scope) {
      const scope = item.leadsheet_scope;
      if (scope.startsWith("map:")) {
        setActiveLeadsheet({ type: "map", key: scope.slice(4) });
      } else if (scope.startsWith("group:")) {
        setActiveLeadsheet({ type: "group", key: scope.slice(6) });
      }
      navigate("/leadsheet");
      return;
    }
    if (item.kind === "file" && item.file_path && engagement?.db_path) {
      const dir = engagement.db_path.replace(/[/\\][^/\\]+$/, "");
      const sep = engagement.db_path.includes("\\") ? "\\" : "/";
      const fullPath = `${dir}${sep}${item.file_path}`;
      await openAttachment(fullPath).catch((e) => setError(String(e)));
    }
  };

  const handleDeleteItem = async (item: CabinetItem) => {
    await deleteCabinetItem(item.id);
    await refresh();
  };

  const handleDeletePhysical = async (item: CabinetItem) => {
    if (!confirm(`Permanently delete "${item.display_name}" from disk?`)) return;
    if (item.file_path && engagement?.db_path) {
      const dir = engagement.db_path.replace(/[/\\][^/\\]+$/, "");
      const sep = engagement.db_path.includes("\\") ? "\\" : "/";
      const fullPath = `${dir}${sep}${item.file_path}`;
      await removeAttachment(fullPath).catch((e) => setError(String(e)));
    }
    await deleteCabinetItem(item.id);
    await refresh();
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || newFolderParent === "none") return;
    await createFolder(newFolderName.trim(), newFolderParent);
    setNewFolderParent("none");
    setNewFolderName("");
    await refresh();
  };

  const handleRenameFolder = async (id: number) => {
    if (renamingValue.trim()) await renameFolder(id, renamingValue.trim());
    setRenamingFolderId(null);
    await refresh();
  };

  const handleDeleteFolder = async (id: number, name: string) => {
    if (!confirm(`Delete folder "${name}"? Items inside move to root.`)) return;
    await deleteFolder(id);
    await refresh();
  };

  const handleAddLeadsheetLink = async () => {
    if (!linkScope) return;
    const name = linkName.trim() || scopeLabel(linkScope);
    await upsertCabinetItem({
      folder_id: linkModal?.folderId ?? null,
      kind: "leadsheet",
      display_name: name,
      leadsheet_scope: linkScope,
    });
    setLinkModal(null);
    setLinkScope("");
    setLinkName("");
    await refresh();
  };

  const handleRegisterDiskFile = async (f: AttachedFile) => {
    await upsertCabinetItem({
      folder_id: null,
      kind: "file",
      display_name: f.name,
      file_path: f.name,
    });
    await refresh();
  };

  // ── Drag handlers ──────────────────────────────────────────────────────────

  function onDragStart(e: React.DragEvent, payload: DragPayload) {
    dragPayload.current = payload;
    isInternalDrag.current = true;
    setOsDragging(false); // make sure no stale OS overlay is showing
    setDraggingActive(true);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(payload.id)); // some webviews need a payload
    // Prevent ghost text selection during drag
    e.dataTransfer.setDragImage(e.currentTarget as Element, 12, 12);
  }

  function onDragEnd() {
    // Fires whether the drop succeeded or was cancelled — always clean up.
    isInternalDrag.current = false;
    dragPayload.current = null;
    setDropTarget(null);
    setDraggingActive(false);
  }

  function onDragOver(e: React.DragEvent, target: DropTarget) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  }

  async function onDrop(e: React.DragEvent, target: DropTarget) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDraggingActive(false);
    const payload = dragPayload.current;
    isInternalDrag.current = false;
    if (!payload) return;

    if (payload.kind === "item") {
      if (target.type === "into-folder") {
        await moveCabinetItem(payload.id, target.folderId, null);
      } else if (target.type === "after-item") {
        await moveCabinetItem(payload.id, target.folderId, target.itemId);
      } else if (target.type === "root") {
        await moveCabinetItem(payload.id, null, null);
      }
    } else if (payload.kind === "folder") {
      if (target.type === "into-folder" && payload.id !== target.folderId) {
        await moveCabinetFolder(payload.id, target.folderId, null);
      } else if (target.type === "root") {
        await moveCabinetFolder(payload.id, null, null);
      }
    }

    dragPayload.current = null;
    await refresh();
  }

  // ── Derived flat node list ─────────────────────────────────────────────────

  const folders = tree?.folders ?? [];
  const items = tree?.items ?? [];
  const diskFiles = tree?.disk_files ?? [];
  const diskMap = new Map(diskFiles.map((f) => [f.name.toLowerCase(), f]));
  const nodes = buildTree(folders, items, diskMap, null, 0, collapsed);

  const registeredPaths = new Set(
    items.filter((i) => i.file_path).map((i) => i.file_path!.toLowerCase())
  );
  const unregisteredDiskFiles = diskFiles.filter((f) => !registeredPaths.has(f.name.toLowerCase()));

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}
      onClick={() => setCtxMenu(null)}
    >
      {/* OS drag-drop overlay */}
      {osDragging && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 50,
          background: "rgba(0,0,0,0.06)",
          border: "2px dashed var(--color-border-strong)",
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Drop to attach</span>
        </div>
      )}

      {/* Leadsheet link modal */}
      {linkModal && (
        <LeadsheetLinkModal
          mapNumbers={mapNumbers}
          groupings={groupings}
          scope={linkScope}
          name={linkName}
          onScopeChange={setLinkScope}
          onNameChange={setLinkName}
          onConfirm={handleAddLeadsheetLink}
          onCancel={() => { setLinkModal(null); setLinkScope(""); setLinkName(""); }}
        />
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          node={ctxMenu.node}
          isLocked={!!engagement?.is_locked}
          onOpen={() => {
            if (ctxMenu.node.kind === "item") handleOpenItem(ctxMenu.node.item);
            setCtxMenu(null);
          }}
          onRename={() => {
            if (ctxMenu.node.kind === "folder") {
              setRenamingFolderId(ctxMenu.node.folder.id);
              setRenamingValue(ctxMenu.node.folder.name);
            }
            setCtxMenu(null);
          }}
          onNewFolder={() => {
            const parentId = ctxMenu.node.kind === "folder" ? ctxMenu.node.folder.id : null;
            setNewFolderParent(parentId);
            setNewFolderName("");
            setCtxMenu(null);
          }}
          onAddLeadsheetLink={() => {
            const folderId = ctxMenu.node.kind === "folder" ? ctxMenu.node.folder.id : null;
            setLinkModal({ folderId });
            setCtxMenu(null);
          }}
          onRemoveFromCabinet={() => {
            if (ctxMenu.node.kind === "item") handleDeleteItem(ctxMenu.node.item);
            setCtxMenu(null);
          }}
          onDeleteFromDisk={() => {
            if (ctxMenu.node.kind === "item") handleDeletePhysical(ctxMenu.node.item);
            setCtxMenu(null);
          }}
          onDeleteFolder={() => {
            if (ctxMenu.node.kind === "folder") {
              handleDeleteFolder(ctxMenu.node.folder.id, ctxMenu.node.folder.name);
            }
            setCtxMenu(null);
          }}
        />
      )}

      {/* Header */}
      <div className="page-header">
        <span className="page-header__title">Document Manager</span>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)", flex: 1 }}>
          {engagement?.db_path ? engagement.db_path.replace(/[^/\\]+$/, "") : ""}
        </span>
        <button className="btn btn-sm" onClick={() => { setNewFolderParent(null); setNewFolderName(""); }}>
          + Folder
        </button>
        <button className="btn btn-sm" onClick={() => setLinkModal({ folderId: null })}>
          + Leadsheet Link
        </button>
        <button className="btn btn-sm btn-primary" onClick={handleAttachFiles}>
          + Attach Files
        </button>
      </div>

      {error && (
        <div style={{ padding: "4px 16px", color: "var(--color-danger)", fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
          {error}
          <button className="btn btn-sm" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Tree. The container is the catch-all "drop to root" zone; row-level
          handlers stopPropagation so they win when the cursor is over a row. */}
      <div
        className={draggingActive ? "cabinet-tree dragging" : "cabinet-tree"}
        style={{ flex: 1, overflow: "auto", userSelect: "none" }}
        onDragOver={(e) => {
          if (!isInternalDrag.current) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTarget({ type: "root" });
        }}
        onDrop={(e) => { if (isInternalDrag.current) onDrop(e, { type: "root" }); }}
      >
        {/* While a row is being dragged, let pointer/drag events pass through the
            children straight to the draggable row, so the drop target is always
            the row and the "no-drop" cursor never appears. The dragged row keeps
            pointer-events so its own dragend still fires. */}
        <style>{`
          .cabinet-tree.dragging [data-cabinet-row] * { pointer-events: none; }
        `}</style>

        {/* Column header */}
        <div style={{
          display: "flex", alignItems: "center",
          padding: "0 12px",
          height: 26,
          borderBottom: "1px solid var(--color-border)",
          fontSize: 10, fontWeight: 700, textTransform: "uppercase",
          letterSpacing: "0.06em", color: "var(--color-text-muted)",
          background: "var(--color-surface)",
          position: "sticky", top: 0, zIndex: 1,
        }}>
          <span style={{ flex: 1 }}>Name</span>
          <span style={{ width: 80, textAlign: "right" }}>Size</span>
          <span style={{ width: 130, marginLeft: 16 }}>Modified</span>
        </div>

        {/* Inline new-root-folder input */}
        {newFolderParent === null && (
          <NewFolderRow
            depth={0}
            value={newFolderName}
            onChange={setNewFolderName}
            onConfirm={handleCreateFolder}
            onCancel={() => setNewFolderParent("none")}
          />
        )}

        {nodes.map((node) => {
          if (node.kind === "folder") {
            const isCollapsed = collapsed.has(node.folder.id);
            const isRenaming = renamingFolderId === node.folder.id;
            const isDropTarget = dropTarget?.type === "into-folder" && dropTarget.folderId === node.folder.id;

            return (
              <div key={`f-${node.folder.id}`}>
                <div
                  data-cabinet-row
                  draggable={!isRenaming}
                  onDragStart={(e) => onDragStart(e, { kind: "folder", id: node.folder.id })}
                  onDragEnd={onDragEnd}
                  onDragOver={(e) => onDragOver(e, { type: "into-folder", folderId: node.folder.id })}
                  onDrop={(e) => onDrop(e, { type: "into-folder", folderId: node.folder.id })}
                  onDoubleClick={() => {
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(node.folder.id)) next.delete(node.folder.id);
                      else next.add(node.folder.id);
                      return next;
                    });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, node });
                  }}
                  style={{
                    display: "flex", alignItems: "center",
                    paddingLeft: 12 + node.depth * 16,
                    paddingRight: 12,
                    height: 24,
                    fontSize: 12,
                    cursor: "default",
                    background: isDropTarget ? "var(--color-hover-bg)" : undefined,
                    outline: isDropTarget ? "1px solid var(--color-border-strong)" : undefined,
                    outlineOffset: -1,
                    borderBottom: "1px solid transparent",
                  }}
                  onMouseEnter={(e) => { if (!isDropTarget) (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
                  onMouseLeave={(e) => { if (!isDropTarget) (e.currentTarget as HTMLDivElement).style.background = ""; }}
                >
                  {/* Expand toggle */}
                  <span
                    onClick={() => setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(node.folder.id)) next.delete(node.folder.id);
                      else next.add(node.folder.id);
                      return next;
                    })}
                    style={{
                      width: 14, fontSize: 9, color: "var(--color-text-muted)",
                      cursor: "pointer", flexShrink: 0, textAlign: "center",
                    }}
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </span>

                  {/* Folder icon */}
                  <span style={{ marginRight: 5, fontSize: 12 }}>
                    {isCollapsed ? "📁" : "📂"}
                  </span>

                  {isRenaming ? (
                    <input
                      autoFocus
                      className="input"
                      style={{ height: 18, fontSize: 12, padding: "0 4px", flex: 1 }}
                      value={renamingValue}
                      onChange={(e) => setRenamingValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameFolder(node.folder.id);
                        if (e.key === "Escape") setRenamingFolderId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span style={{ fontWeight: 600, flex: 1 }}>{node.folder.name}</span>
                  )}
                </div>

                {/* Inline subfolder creation when triggered from context menu */}
                {newFolderParent === node.folder.id && (
                  <NewFolderRow
                    depth={node.depth + 1}
                    value={newFolderName}
                    onChange={setNewFolderName}
                    onConfirm={handleCreateFolder}
                    onCancel={() => setNewFolderParent("none")}
                  />
                )}
              </div>
            );
          }

          // Item row
          const { item, depth, diskMeta } = node;
          const missingFile = item.kind === "file" && !diskMeta;
          const isDropTarget = dropTarget?.type === "after-item" && dropTarget.itemId === item.id;

          return (
            <div
              key={`i-${item.id}`}
              data-cabinet-row
              draggable
              onDragStart={(e) => onDragStart(e, { kind: "item", id: item.id })}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onDragOver(e, { type: "after-item", itemId: item.id, folderId: item.folder_id })}
              onDrop={(e) => onDrop(e, { type: "after-item", itemId: item.id, folderId: item.folder_id })}
              onDoubleClick={() => handleOpenItem(item)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, node });
              }}
              style={{
                display: "flex", alignItems: "center",
                paddingLeft: 12 + depth * 16 + 14, // +14 accounts for the toggle chevron space
                paddingRight: 12,
                height: 24,
                fontSize: 12,
                cursor: "default",
                opacity: missingFile ? 0.45 : 1,
                borderTop: isDropTarget ? "2px solid var(--color-border-strong)" : "1px solid transparent",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
            >
              {/* Type badge */}
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700,
                padding: "0 3px", border: "1px solid var(--color-border)",
                letterSpacing: "0.04em", marginRight: 7, flexShrink: 0,
                color: item.kind === "leadsheet" ? "var(--color-text-muted)" : undefined,
                minWidth: 26, textAlign: "center",
              }}>
                {item.kind === "leadsheet"
                  ? "LS"
                  : FILE_ICON[diskMeta?.ext ?? ""] ?? ((diskMeta?.ext ?? "").toUpperCase().slice(0, 4) || "—")}
              </span>

              {/* Name */}
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.display_name}
                {item.kind === "leadsheet" && item.leadsheet_scope && (
                  <span style={{ marginLeft: 8, fontSize: 10, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                    → {scopeLabel(item.leadsheet_scope)}
                  </span>
                )}
                {missingFile && (
                  <span style={{ marginLeft: 6, fontSize: 10, color: "var(--color-danger)" }}>missing</span>
                )}
              </span>

              {/* Size */}
              <span style={{ width: 80, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-muted)", flexShrink: 0 }}>
                {diskMeta ? formatBytes(diskMeta.size_bytes) : ""}
              </span>

              {/* Modified */}
              <span style={{ width: 130, marginLeft: 16, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-muted)", flexShrink: 0 }}>
                {diskMeta?.modified ?? ""}
              </span>
            </div>
          );
        })}

        {/* Unregistered disk files section */}
        {unregisteredDiskFiles.length > 0 && (
          <>
            <div style={{
              padding: "3px 12px",
              fontSize: 10, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.06em", color: "var(--color-text-muted)",
              background: "var(--color-surface)",
              borderTop: "1px solid var(--color-border)",
              marginTop: 4,
            }}>
              On disk — not in cabinet
            </div>
            {unregisteredDiskFiles.map((f) => (
              <div
                key={f.path}
                style={{
                  display: "flex", alignItems: "center",
                  paddingLeft: 26, paddingRight: 12,
                  height: 24, fontSize: 12, opacity: 0.55,
                }}
              >
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700,
                  padding: "0 3px", border: "1px solid var(--color-border)",
                  letterSpacing: "0.04em", marginRight: 7,
                  minWidth: 26, textAlign: "center",
                }}>
                  {FILE_ICON[f.ext] ?? (f.ext.toUpperCase().slice(0, 4) || "—")}
                </span>
                <span style={{ flex: 1 }}>{f.name}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-muted)", width: 80, textAlign: "right" }}>
                  {formatBytes(f.size_bytes)}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-muted)", width: 130, marginLeft: 16 }}>
                  {f.modified}
                </span>
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 8, fontSize: 10 }}
                  onClick={() => handleRegisterDiskFile(f)}
                >
                  + Add
                </button>
              </div>
            ))}
          </>
        )}

        {nodes.length === 0 && unregisteredDiskFiles.length === 0 && (
          <div style={{
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            height: 200, gap: 10, color: "var(--color-text-muted)",
          }}>
            <span style={{ fontSize: 12 }}>Empty — drag files here or click Attach Files</span>
            <button className="btn btn-sm" onClick={handleAttachFiles}>Attach Files</button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        borderTop: "1px solid var(--color-border)",
        padding: "3px 12px",
        fontSize: 11, color: "var(--color-text-muted)",
        display: "flex", gap: 16,
      }}>
        <span>{items.length} document{items.length !== 1 ? "s" : ""}</span>
        <span>{folders.length} folder{folders.length !== 1 ? "s" : ""}</span>
        <span>{diskFiles.length} file{diskFiles.length !== 1 ? "s" : ""} on disk</span>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NewFolderRow({
  depth, value, onChange, onConfirm, onCancel,
}: {
  depth: number; value: string;
  onChange: (v: string) => void; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 4,
      paddingLeft: 12 + depth * 16, paddingRight: 12,
      height: 26, borderBottom: "1px solid var(--color-border)",
    }}>
      <span style={{ fontSize: 12, marginRight: 4 }}>📁</span>
      <input
        autoFocus
        className="input"
        style={{ height: 20, fontSize: 12, padding: "0 4px", flex: 1 }}
        placeholder="Folder name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
          if (e.key === "Escape") onCancel();
        }}
      />
      <button className="btn btn-sm" onClick={onConfirm}>OK</button>
      <button className="btn btn-sm" onClick={onCancel}>×</button>
    </div>
  );
}

function ContextMenu({
  x, y, node, isLocked,
  onOpen, onRename, onNewFolder, onAddLeadsheetLink,
  onRemoveFromCabinet, onDeleteFromDisk, onDeleteFolder,
}: {
  x: number; y: number; node: TreeNode; isLocked: boolean;
  onOpen: () => void;
  onRename: () => void;
  onNewFolder: () => void;
  onAddLeadsheetLink: () => void;
  onRemoveFromCabinet: () => void;
  onDeleteFromDisk: () => void;
  onDeleteFolder: () => void;
}) {
  const isFolder = node.kind === "folder";
  const isFile = node.kind === "item" && node.item.kind === "file";
  const isLink = node.kind === "item" && node.item.kind === "leadsheet";

  const items: { label: string; action: () => void; danger?: boolean; sep?: boolean }[] = [];

  if (!isFolder) items.push({ label: "Open", action: onOpen });
  if (isFolder) items.push({ label: "New Subfolder", action: onNewFolder });
  if (isFolder) items.push({ label: "Add Leadsheet Link Here", action: onAddLeadsheetLink });
  items.push({ label: "Rename", action: onRename, sep: !isFolder });

  if (!isLocked) {
    if (isFile) items.push({ label: "Remove from Cabinet", action: onRemoveFromCabinet, sep: true });
    if (isFile) items.push({ label: "Delete from Disk", action: onDeleteFromDisk, danger: true });
    if (isLink) items.push({ label: "Delete Link", action: onRemoveFromCabinet, sep: true, danger: true });
    if (isFolder) items.push({ label: "Delete Folder", action: onDeleteFolder, sep: true, danger: true });
  }

  return (
    <div
      style={{
        position: "fixed", zIndex: 200,
        left: x, top: y,
        background: "var(--color-bg)",
        border: "1px solid var(--color-border-strong)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        minWidth: 180, padding: "2px 0",
        fontSize: 12,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.sep && i > 0 && <div style={{ borderTop: "1px solid var(--color-border)", margin: "2px 0" }} />}
          <div
            onClick={item.action}
            style={{
              padding: "4px 16px",
              cursor: "pointer",
              color: item.danger ? "var(--color-danger)" : undefined,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-hover-bg)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "")}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function LeadsheetLinkModal({
  mapNumbers, groupings, scope, name,
  onScopeChange, onNameChange, onConfirm, onCancel,
}: {
  mapNumbers: MapNumber[];
  groupings: Grouping[];
  scope: string; name: string;
  onScopeChange: (s: string) => void;
  onNameChange: (n: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "rgba(0,0,0,0.3)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--color-bg)",
        border: "1px solid var(--color-border-strong)",
        padding: 20, width: 340,
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Add Leadsheet Link</div>
        <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Leadsheet</label>
        <select
          className="select"
          value={scope}
          onChange={(e) => onScopeChange(e.target.value)}
        >
          <option value="">— Select —</option>
          {mapNumbers.length > 0 && (
            <optgroup label="Map Numbers">
              {mapNumbers.map((m) => (
                <option key={m.code} value={`map:${m.code}`}>
                  {m.code} — {m.label}
                </option>
              ))}
            </optgroup>
          )}
          {groupings.length > 0 && (
            <optgroup label="Groupings">
              {groupings.map((g) => (
                <option key={g.id} value={`group:${g.id}`}>
                  {g.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          Display name (optional)
        </label>
        <input
          className="input"
          placeholder={scope ? scopeLabel(scope) : "e.g. Cash & Equivalents"}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary flex-1" disabled={!scope} onClick={onConfirm}>
            Add Link
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAtom, useSetAtom } from "jotai";
import { engagementAtom, activeLeadsheetAtom, activeDocTemplateAtom, mapNumbersAtom, groupingsAtom, settingsAtom } from "@/store/atoms";
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
  listDocTemplates,
  signOff,
  removeSignoff,
  getSignoffs,
} from "@/lib/tauri";
import { appWindow } from "@tauri-apps/api/window";
import type { CabinetFolder, CabinetItem, CabinetTree, AttachedFile, MapNumber, Grouping, Signoff, SignoffRole, DocTemplate } from "@/types";

const ROLES: SignoffRole[] = ["PREPARER", "REVIEWER", "PARTNER"];
const ROLE_SHORT: Record<SignoffRole, string> = { PREPARER: "Prep", REVIEWER: "Rev", PARTNER: "Ptr" };

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
// We use a pointer-event based drag (NOT HTML5 drag-and-drop) because Tauri 1.x
// on Windows WebView2 registers a native OLE drop target when fileDropEnabled is
// true, which suppresses the webview's HTML5 DnD entirely. Pointer events
// sidestep that conflict — see FILES_PAGE_DRAG_DEBUG.md.

type DropTarget =
  | { type: "into-folder"; folderId: number }
  | { type: "before"; kind: "folder" | "item"; id: number; folderId: number | null }
  | { type: "after"; kind: "folder" | "item"; id: number; folderId: number | null }
  | { type: "root" };

// ── Pointer-based drag hook ───────────────────────────────────────────────────

function useCabinetDrag(
  onDropComplete: (payload: DragPayload, target: DropTarget) => Promise<void>,
) {
  const dragData = useRef<{
    payload: DragPayload | null;
    startX: number;
    startY: number;
    clone: HTMLElement | null;
    isDragging: boolean;
  }>({ payload: null, startX: 0, startY: 0, clone: null, isDragging: false });

  const dropTargetRef = useRef<DropTarget | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const updateDropTarget = useCallback((target: DropTarget | null) => {
    if (JSON.stringify(dropTargetRef.current) !== JSON.stringify(target)) {
      dropTargetRef.current = target;
      setDropTarget(target);
    }
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, payload: DragPayload) => {
    if (e.button !== 0) return; // left button only
    // Don't start a drag from interactive children (chevron, buttons, inputs).
    if ((e.target as HTMLElement).closest("button, input, .no-drag")) return;

    const row = e.currentTarget;
    dragData.current = { payload, startX: e.clientX, startY: e.clientY, clone: null, isDragging: false };

    const handlePointerMove = (moveEv: PointerEvent) => {
      const d = dragData.current;
      if (!d.payload) return;

      // Click-vs-drag threshold
      if (!d.isDragging) {
        const dx = Math.abs(moveEv.clientX - d.startX);
        const dy = Math.abs(moveEv.clientY - d.startY);
        if (dx < 5 && dy < 5) return;

        d.isDragging = true;
        setIsDragging(true);

        const rect = row.getBoundingClientRect();
        const clone = row.cloneNode(true) as HTMLElement;
        clone.style.position = "fixed";
        clone.style.top = "0px";
        clone.style.left = "0px";
        clone.style.width = `${rect.width}px`;
        clone.style.opacity = "0.75";
        clone.style.pointerEvents = "none"; // let elementFromPoint pierce through
        clone.style.zIndex = "9999";
        clone.style.background = "var(--color-bg)";
        clone.style.boxShadow = "0 4px 12px rgba(0,0,0,0.18)";
        document.body.appendChild(clone);
        d.clone = clone;
        document.body.style.userSelect = "none";
      }

      if (d.clone) {
        d.clone.style.transform = `translate(${moveEv.clientX + 12}px, ${moveEv.clientY + 8}px)`;
      }

      // Hit-test the row under the cursor
      const el = document.elementFromPoint(moveEv.clientX, moveEv.clientY);
      const targetRow = el?.closest("[data-cabinet-row]") as HTMLElement | null;

      if (targetRow) {
        const tKind = targetRow.dataset.kind as "folder" | "item";
        const tId = Number(targetRow.dataset.id);
        const tFolderId = targetRow.dataset.folderId ? Number(targetRow.dataset.folderId) : null;

        // Can't drop onto itself
        if (tKind === d.payload.kind && tId === d.payload.id) {
          updateDropTarget(null);
          return;
        }

        const rect = targetRow.getBoundingClientRect();
        const yFrac = (moveEv.clientY - rect.top) / rect.height;

        if (tKind === "folder") {
          if (yFrac < 0.25) updateDropTarget({ type: "before", kind: "folder", id: tId, folderId: tFolderId });
          else if (yFrac > 0.75) updateDropTarget({ type: "after", kind: "folder", id: tId, folderId: tFolderId });
          else updateDropTarget({ type: "into-folder", folderId: tId });
        } else {
          if (yFrac < 0.5) updateDropTarget({ type: "before", kind: "item", id: tId, folderId: tFolderId });
          else updateDropTarget({ type: "after", kind: "item", id: tId, folderId: tFolderId });
        }
      } else if (el?.closest(".cabinet-tree")) {
        updateDropTarget({ type: "root" });
      } else {
        updateDropTarget(null);
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";

      const d = dragData.current;
      if (d.clone) d.clone.remove();

      if (d.isDragging) {
        const payloadFinal = d.payload;
        const target = dropTargetRef.current;
        setIsDragging(false);
        updateDropTarget(null);
        if (payloadFinal && target) void onDropComplete(payloadFinal, target);
      }
      dragData.current = { payload: null, startX: 0, startY: 0, clone: null, isDragging: false };
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  return { handlePointerDown, dropTarget, isDragging };
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FilesPage() {
  const [engagement] = useAtom(engagementAtom);
  const [settings] = useAtom(settingsAtom);
  const [mapNumbers, setMapNumbers] = useAtom(mapNumbersAtom);
  const [groupings, setGroupings] = useAtom(groupingsAtom);
  const setActiveLeadsheet = useSetAtom(activeLeadsheetAtom);
  const setActiveDocTemplate = useSetAtom(activeDocTemplateAtom);
  const navigate = useNavigate();

  const [tree, setTree] = useState<CabinetTree | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [osDragging, setOsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSignoffs, setFileSignoffs] = useState<Record<string, Signoff[]>>({});

  // Inline editing
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renamingValue, setRenamingValue] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<number | null | "none">("none"); // "none" = not creating
  const [newFolderName, setNewFolderName] = useState("");

  // Leadsheet link modal
  const [linkModal, setLinkModal] = useState<{ folderId: number | null } | null>(null);
  const [linkScope, setLinkScope] = useState("");
  const [linkName, setLinkName] = useState("");

  // Document link modal
  const [docLinkModal, setDocLinkModal] = useState<{ folderId: number | null } | null>(null);
  const [docLinkTemplateId, setDocLinkTemplateId] = useState<number | "">("");
  const [docLinkName, setDocLinkName] = useState("");
  const [docTemplates, setDocTemplates] = useState<DocTemplate[]>([]);

  // Drag-and-drop is pointer-based (see useCabinetDrag); wired up after the
  // derived node list below so executeDrop can resolve sibling ordering.

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const t = await getCabinet();
      setTree(t);
      const all = await getSignoffs();
      const byScope: Record<string, Signoff[]> = {};
      for (const s of all) {
        if (!s.scope.startsWith("file:")) continue;
        if (!byScope[s.scope]) byScope[s.scope] = [];
        byScope[s.scope].push(s);
      }
      setFileSignoffs(byScope);
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

  // OS file drop (external files dragged from Explorer). Decoupled from internal
  // dragging now that internal reorg uses pointer events, not HTML5 DnD.
  useEffect(() => {
    const unlisten = appWindow.onFileDropEvent((event) => {
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
    if (item.kind === "document" && item.doc_template_id != null) {
      setActiveDocTemplate(item.doc_template_id);
      navigate("/documents");
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

  const handleAddDocLink = async () => {
    if (!docLinkTemplateId) return;
    const tmpl = docTemplates.find((t) => t.id === docLinkTemplateId);
    const name = docLinkName.trim() || tmpl?.name || "Document";
    await upsertCabinetItem({
      folder_id: docLinkModal?.folderId ?? null,
      kind: "document",
      display_name: name,
      doc_template_id: Number(docLinkTemplateId),
    });
    setDocLinkModal(null);
    setDocLinkTemplateId("");
    setDocLinkName("");
    await refresh();
  };

  const handleFileSignOff = async (item: CabinetItem, role: SignoffRole) => {
    const scope = `file:${item.id}`;
    const existing = fileSignoffs[scope] ?? [];
    const myEntry = existing.find((s) => s.role === role && s.signed_by === settings.user_name);
    if (myEntry) {
      await removeSignoff(myEntry.id, settings.user_name);
    } else {
      await signOff(scope, role, settings.user_name, settings.user_initials);
    }
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

  // ── Drag handling (pointer-based) ──────────────────────────────────────────

  // The backend orders by `afterId` (the sibling to land after; null = first).
  // For a "before X" drop we need the item id immediately preceding X among its
  // own item-siblings (folders order independently from items at each level).
  const prevItemSiblingId = useCallback((itemId: number, folderId: number | null): number | null => {
    const siblings = items
      .filter((i) => i.folder_id === folderId)
      .sort((a, b) => a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name));
    const idx = siblings.findIndex((s) => s.id === itemId);
    return idx > 0 ? siblings[idx - 1].id : null;
  }, [items]);

  const prevFolderSiblingId = useCallback((folderId: number, parentId: number | null): number | null => {
    const siblings = folders
      .filter((f) => f.parent_id === parentId)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const idx = siblings.findIndex((s) => s.id === folderId);
    return idx > 0 ? siblings[idx - 1].id : null;
  }, [folders]);

  const executeDrop = useCallback(async (payload: DragPayload, target: DropTarget) => {
    if (payload.kind === "item") {
      let folderId: number | null = null;
      let afterId: number | null = null;
      if (target.type === "into-folder") {
        folderId = target.folderId;
      } else if (target.type === "root") {
        folderId = null;
      } else if (target.kind === "item") {
        // Reordering relative to another item in the same folder.
        folderId = target.folderId;
        afterId = target.type === "after" ? target.id : prevItemSiblingId(target.id, target.folderId);
      } else {
        // Dropped before/after a folder row → land in that folder's parent level.
        folderId = target.folderId;
        afterId = null;
      }
      await moveCabinetItem(payload.id, folderId, afterId);
    } else {
      // Folder being moved.
      let parentId: number | null = null;
      let afterId: number | null = null;
      if (target.type === "into-folder") {
        if (payload.id === target.folderId) return; // no-op onto self
        parentId = target.folderId;
      } else if (target.type === "root") {
        parentId = null;
      } else if (target.kind === "folder") {
        parentId = target.folderId; // the dragged-over folder's parent
        afterId = target.type === "after" ? target.id : prevFolderSiblingId(target.id, target.folderId);
      } else {
        // before/after an item row → move folder to that item's folder level
        parentId = target.folderId;
        afterId = null;
      }
      await moveCabinetFolder(payload.id, parentId, afterId);
    }
    await refresh();
  }, [prevItemSiblingId, prevFolderSiblingId, refresh]);

  const { handlePointerDown, dropTarget } = useCabinetDrag(executeDrop);

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

      {/* Document link modal */}
      {docLinkModal && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(0,0,0,0.3)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={() => setDocLinkModal(null)}>
          <div style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-border-strong)",
            padding: 20, width: 340,
            display: "flex", flexDirection: "column", gap: 10,
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Add Document Link</div>
            <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Template</label>
            <select
              className="select"
              value={docLinkTemplateId}
              onChange={(e) => {
                const id = Number(e.target.value);
                setDocLinkTemplateId(id || "");
                const tmpl = docTemplates.find((t) => t.id === id);
                if (tmpl && !docLinkName) setDocLinkName(tmpl.name);
              }}
            >
              <option value="">— Select —</option>
              {docTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <label style={{ fontSize: 11, color: "var(--color-text-muted)" }}>Display name (optional)</label>
            <input
              className="input"
              placeholder="Leave blank to use template name"
              value={docLinkName}
              onChange={(e) => setDocLinkName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddDocLink(); if (e.key === "Escape") setDocLinkModal(null); }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setDocLinkModal(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!docLinkTemplateId} onClick={handleAddDocLink}>Add</button>
            </div>
          </div>
        </div>
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
          onAddDocLink={async () => {
            const folderId = ctxMenu.node.kind === "folder" ? ctxMenu.node.folder.id : null;
            const tmpls = await listDocTemplates();
            setDocTemplates(tmpls);
            setDocLinkTemplateId("");
            setDocLinkName("");
            setDocLinkModal({ folderId });
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
          onSignOff={(role) => {
            if (ctxMenu.node.kind === "item") {
              handleFileSignOff(ctxMenu.node.item, role);
            }
            setCtxMenu(null);
          }}
          fileSignoffs={ctxMenu.node.kind === "item" ? (fileSignoffs[`file:${ctxMenu.node.item.id}`] ?? []) : []}
          currentUser={settings.user_name}
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
        <button className="btn btn-sm" onClick={async () => {
          const tmpls = await listDocTemplates();
          setDocTemplates(tmpls);
          setDocLinkTemplateId("");
          setDocLinkName("");
          setDocLinkModal({ folderId: null });
        }}>
          + Doc Link
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

      {/* Tree. The .cabinet-tree class is the catch-all "drop to root" hit zone
          for the pointer-drag hit-testing. */}
      <div
        className="cabinet-tree"
        style={{ flex: 1, overflow: "auto", userSelect: "none" }}
      >
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
          {ROLES.map((r) => (
            <span key={r} style={{ width: 36, textAlign: "center", marginLeft: 4 }}>{ROLE_SHORT[r]}</span>
          ))}
          <span style={{ width: 80, textAlign: "right", marginLeft: 12 }}>Size</span>
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
            const dropInto = dropTarget?.type === "into-folder" && dropTarget.folderId === node.folder.id;
            const dropBefore = (dropTarget?.type === "before") && dropTarget.kind === "folder" && dropTarget.id === node.folder.id;
            const dropAfter = (dropTarget?.type === "after") && dropTarget.kind === "folder" && dropTarget.id === node.folder.id;

            return (
              <div key={`f-${node.folder.id}`}>
                <div
                  data-cabinet-row
                  data-kind="folder"
                  data-id={node.folder.id}
                  data-folder-id={node.folder.parent_id ?? ""}
                  onPointerDown={(e) => { if (!isRenaming) handlePointerDown(e, { kind: "folder", id: node.folder.id }); }}
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
                    background: dropInto ? "var(--color-hover-bg)" : undefined,
                    outline: dropInto ? "1px solid var(--color-border-strong)" : undefined,
                    outlineOffset: -1,
                    borderTop: dropBefore ? "2px solid var(--color-border-strong)" : "1px solid transparent",
                    borderBottom: dropAfter ? "2px solid var(--color-border-strong)" : "1px solid transparent",
                  }}
                  onMouseEnter={(e) => { if (!dropInto) (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
                  onMouseLeave={(e) => { if (!dropInto) (e.currentTarget as HTMLDivElement).style.background = ""; }}
                >
                  {/* Expand toggle */}
                  <span
                    className="no-drag"
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
          const dropBefore = dropTarget?.type === "before" && dropTarget.kind === "item" && dropTarget.id === item.id;
          const dropAfter = dropTarget?.type === "after" && dropTarget.kind === "item" && dropTarget.id === item.id;

          return (
            <div
              key={`i-${item.id}`}
              data-cabinet-row
              data-kind="item"
              data-id={item.id}
              data-folder-id={item.folder_id ?? ""}
              onPointerDown={(e) => handlePointerDown(e, { kind: "item", id: item.id })}
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
                borderTop: dropBefore ? "2px solid var(--color-border-strong)" : "1px solid transparent",
                borderBottom: dropAfter ? "2px solid var(--color-border-strong)" : "1px solid transparent",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = ""; }}
            >
              {/* Type badge */}
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700,
                padding: "0 3px", border: "1px solid var(--color-border)",
                letterSpacing: "0.04em", marginRight: 7, flexShrink: 0,
                color: (item.kind === "leadsheet" || item.kind === "document") ? "var(--color-primary)" : undefined,
                minWidth: 26, textAlign: "center",
              }}>
                {item.kind === "leadsheet" ? "LS"
                  : item.kind === "document" ? "DOC"
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

              {/* Sign-off chips per role */}
              {ROLES.map((role) => {
                const signers = (fileSignoffs[`file:${item.id}`] ?? []).filter((s) => s.role === role);
                return (
                  <div key={role} style={{ width: 36, marginLeft: 4, flexShrink: 0, display: "flex", justifyContent: "center", alignItems: "center" }} className="no-drag">
                    {signers.length > 0 && (
                      <span
                        title={signers.map((s) => s.signed_by).join(", ")}
                        style={{
                          fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700,
                          color: "var(--color-primary)",
                        }}
                      >
                        {signers.map((s) => s.signed_initials || s.signed_by.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase()).join("/")}

                      </span>
                    )}
                  </div>
                );
              })}

              {/* Size */}
              <span style={{ width: 80, textAlign: "right", marginLeft: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-muted)", flexShrink: 0 }}>
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
  onOpen, onRename, onNewFolder, onAddLeadsheetLink, onAddDocLink,
  onRemoveFromCabinet, onDeleteFromDisk, onDeleteFolder,
  onSignOff, fileSignoffs, currentUser,
}: {
  x: number; y: number; node: TreeNode; isLocked: boolean;
  onOpen: () => void;
  onRename: () => void;
  onNewFolder: () => void;
  onAddLeadsheetLink: () => void;
  onAddDocLink: () => void;
  onRemoveFromCabinet: () => void;
  onDeleteFromDisk: () => void;
  onDeleteFolder: () => void;
  onSignOff: (role: SignoffRole) => void;
  fileSignoffs: Signoff[];
  currentUser: string;
}) {
  const isFolder = node.kind === "folder";
  const isFile = node.kind === "item" && node.item.kind === "file";
  const isLink = node.kind === "item" && (node.item.kind === "leadsheet" || node.item.kind === "document");

  const menuItems: { label: string; action: () => void; danger?: boolean; sep?: boolean }[] = [];

  if (!isFolder) menuItems.push({ label: "Open", action: onOpen });
  if (isFolder) menuItems.push({ label: "New Subfolder", action: onNewFolder });
  if (isFolder) menuItems.push({ label: "Add Leadsheet Link Here", action: onAddLeadsheetLink });
  if (isFolder) menuItems.push({ label: "Add Document Link Here", action: onAddDocLink });
  menuItems.push({ label: "Rename", action: onRename, sep: !isFolder });

  if (!isLocked && (isFile || isLink)) {
    // Sign-off entries for each role
    menuItems.push({ label: "— Sign off —", action: () => {}, sep: true });
    for (const role of ROLES) {
      const myEntry = fileSignoffs.find((s) => s.role === role && s.signed_by === currentUser);
      const existingEntries = fileSignoffs.filter((s) => s.role === role);
      const othersLabel = existingEntries.filter((s) => s.signed_by !== currentUser)
        .map((s) => s.signed_by.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase().slice(0, 3))
        .join(", ");
      const label = myEntry
        ? `✓ ${ROLE_SHORT[role]}${othersLabel ? ` (${othersLabel})` : ""} — Remove my sign-off`
        : `Sign off: ${ROLE_SHORT[role]}${othersLabel ? ` (${othersLabel} signed)` : ""}`;
      menuItems.push({ label, action: () => onSignOff(role) });
    }
  }

  if (!isLocked) {
    if (isFile) menuItems.push({ label: "Remove from Cabinet", action: onRemoveFromCabinet, sep: true });
    if (isFile) menuItems.push({ label: "Delete from Disk", action: onDeleteFromDisk, danger: true });
    if (isLink) menuItems.push({ label: "Remove Link", action: onRemoveFromCabinet, sep: true, danger: true });
    if (isFolder) menuItems.push({ label: "Delete Folder", action: onDeleteFolder, sep: true, danger: true });
  }

  return (
    <div
      style={{
        position: "fixed", zIndex: 200,
        left: x, top: y,
        background: "var(--color-bg)",
        border: "1px solid var(--color-border-strong)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        minWidth: 200, padding: "2px 0",
        fontSize: 12,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {menuItems.map((item, i) => {
        const isHeader = item.label.startsWith("—");
        return (
          <div key={i}>
            {item.sep && i > 0 && !isHeader && <div style={{ borderTop: "1px solid var(--color-border)", margin: "2px 0" }} />}
            <div
              onClick={isHeader ? undefined : item.action}
              style={{
                padding: isHeader ? "3px 16px 1px" : "4px 16px",
                cursor: isHeader ? "default" : "pointer",
                color: item.danger ? "var(--color-danger)" : isHeader ? "var(--color-text-muted)" : undefined,
                fontSize: isHeader ? 10 : 12,
                fontWeight: isHeader ? 700 : undefined,
                textTransform: isHeader ? "uppercase" : undefined,
                letterSpacing: isHeader ? "0.05em" : undefined,
              }}
              onMouseEnter={(e) => { if (!isHeader) (e.currentTarget as HTMLDivElement).style.background = "var(--color-hover-bg)"; }}
              onMouseLeave={(e) => { if (!isHeader) (e.currentTarget as HTMLDivElement).style.background = ""; }}
            >
              {item.label}
            </div>
          </div>
        );
      })}
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

# Debug Request: In-app drag-and-drop fails in Tauri file manager (red "no-drop" cursor)

## TL;DR of the bug

I'm building a Caseware-style "Document Manager" / file cabinet page in a **Tauri 1.x +
React 18 + TypeScript** desktop app, running on **Windows 11 (WebView2)**.

- **External file drag-and-drop WORKS**: dragging a file from Windows Explorer onto the
  window attaches it (via Tauri's native `onFileDropEvent`).
- **Internal drag-and-drop FAILS**: trying to drag a row (a folder or a file item) to
  reorganize it *within* the page shows the **red circle / slashed "no-drop" cursor** and
  the drop never fires. HTML5 `dragover`/`drop` handlers don't produce a valid drop target.

I need this page to support: reordering items within a folder, dragging items between
folders, and dragging folders into other folders (moving the whole subtree).

## My leading hypothesis (please confirm or refute)

On **Windows WebView2**, Tauri 1.x's `"fileDropEnabled": true` registers a native OLE
drop target on the WebView2 host window. I believe this **intercepts/suppresses the
webview's own HTML5 drag-and-drop**, so in-app `draggable` elements can't complete a drop —
hence the permanent "no-drop" cursor regardless of how correct my JS handlers are.

If that's right, the two features are mutually exclusive in Tauri 1.x **unless** there's a
known workaround. Candidate solutions I want evaluated:

1. **Set `"fileDropEnabled": false`** and re-implement external file drop some other way
   (but Tauri 1.x HTML5 drop does **not** expose real filesystem paths for security, so
   `attach_file(sourcePath)` — which copies by absolute path — can't get a path this way).
2. **Keep `fileDropEnabled: true`** but replace HTML5 drag-and-drop with a **pointer-events
   / mouse-based drag** implementation (mousedown → mousemove → mouseup, compute drop
   target by hit-testing coordinates) that doesn't rely on the native HTML5 DnD system at
   all. This sidesteps the OLE conflict entirely.
3. Some Tauri/WebView2 config or flag I'm unaware of that lets both coexist.
4. Upgrading to **Tauri 2.x** (which changed drag-drop handling — `dragDropEnabled`, and
   the `tauri://drag-drop` events). Is in-app HTML5 DnD reliable in Tauri 2 with native
   drop enabled?

**Please tell me the correct, robust approach for Windows WebView2 and give me the full
replacement implementation.** I'd prefer to keep external drop working AND get internal
drag working. If a mouse-based internal drag (option 2) is the most reliable, implement
that.

## Environment

- Tauri: `tauri = "1.8"` (Rust crate), `@tauri-apps/api ^1.6.0`, `@tauri-apps/cli ^1.6.0`
- Frontend: React `^18.3.1`, Vite `^5.3.4`, TypeScript (strict: `noUnusedLocals` +
  `noUnusedParameters` are ON — unused vars fail the build)
- Platform: Windows 11, WebView2 (Edge Chromium)
- State: Jotai. Routing: react-router-dom (HashRouter).
- `tsconfig` path alias: `@/*` → `src/*`

### `src-tauri/tauri.conf.json` (relevant window config)

```json
{
  "tauri": {
    "windows": [
      {
        "title": "Worked Papers",
        "width": 1440, "height": 900,
        "decorations": true, "transparent": false,
        "fileDropEnabled": true
      }
    ],
    "security": { "csp": null }
  }
}
```

## What the page does (data model)

A "file cabinet": a virtual folder tree stored in SQLite. Real files live **flat** on disk
in the engagement directory; folders + ordering + leadsheet-links are DB-only.

### DB schema (SQLite, migration 003)

```sql
CREATE TABLE file_cabinet_folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    parent_id   INTEGER REFERENCES file_cabinet_folders(id) ON DELETE CASCADE,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE file_cabinet_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id        INTEGER REFERENCES file_cabinet_folders(id) ON DELETE SET NULL,
    kind             TEXT    NOT NULL CHECK (kind IN ('file', 'leadsheet')),
    display_name     TEXT    NOT NULL,
    file_path        TEXT,            -- bare filename, relative to engagement dir (kind='file')
    leadsheet_scope  TEXT,            -- e.g. 'map:1000' or 'group:3'        (kind='leadsheet')
    sort_order       INTEGER NOT NULL DEFAULT 0
);
```

### TypeScript types

```ts
export interface CabinetFolder {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
}
export interface CabinetItem {
  id: number;
  folder_id: number | null;
  kind: "file" | "leadsheet";
  display_name: string;
  file_path: string | null;
  leadsheet_scope: string | null;
  sort_order: number;
}
export interface CabinetTree {
  folders: CabinetFolder[];
  items: CabinetItem[];
  disk_files: AttachedFile[]; // every non-DB file currently on disk
}
export interface AttachedFile {
  name: string; path: string; size_bytes: number; modified: string; ext: string;
}
```

### Rust commands available to the frontend (Tauri `invoke`)

```ts
// wrappers in src/lib/tauri.ts
getCabinet(): Promise<CabinetTree>
createFolder(name: string, parentId: number | null): Promise<CabinetFolder>
renameFolder(id: number, name: string): Promise<void>
deleteFolder(id: number): Promise<void>
upsertCabinetItem(payload: {
  id?: number | null; folder_id: number | null;
  kind: "file" | "leadsheet"; display_name: string;
  file_path?: string | null; leadsheet_scope?: string | null;
}): Promise<CabinetItem>
deleteCabinetItem(id: number): Promise<void>
moveCabinetItem(id: number, folderId: number | null, afterId: number | null): Promise<void>
moveCabinetFolder(id: number, parentId: number | null, afterId: number | null): Promise<void>
attachFile(sourcePath: string): Promise<AttachedFile>   // copies an ABSOLUTE path into engagement dir
removeAttachment(filePath: string): Promise<void>
openAttachment(filePath: string): Promise<void>         // opens with system default app
```

`moveCabinetItem` / `moveCabinetFolder` already work correctly (tested via other paths):
`afterId` = the sibling to appear after (null = first). The Rust side does gap-insert
sort_order math and a cycle-guard so a folder can't be moved into its own subtree.

## Current rendering approach

The tree is flattened into a list of nodes via a recursive `buildTree()` that respects a
`collapsed: Set<number>` of folder ids. Each node is rendered as a single flat `<div>` row
with `paddingLeft` proportional to depth (Caseware-style indented list — folders and items
interleaved, NOT a two-pane layout). Folders render before items at each level.

Each draggable row is a `<div>` with `draggable`, `data-cabinet-row`, and the DnD handlers.

## The drag handlers (current, NOT working for internal drag)

```tsx
// refs/state
const dragPayload = useRef<DragPayload | null>(null);     // { kind: "item"|"folder", id }
const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
const isInternalDrag = useRef(false); // true only during in-app HTML5 drag
const [draggingActive, setDraggingActive] = useState(false); // mirror, toggles pointer-events CSS

type DropTarget =
  | { type: "into-folder"; folderId: number }
  | { type: "after-item"; itemId: number; folderId: number | null }
  | { type: "root" };

function onDragStart(e: React.DragEvent, payload: DragPayload) {
  dragPayload.current = payload;
  isInternalDrag.current = true;
  setOsDragging(false);
  setDraggingActive(true);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(payload.id));
  e.dataTransfer.setDragImage(e.currentTarget as Element, 12, 12);
}

function onDragEnd() {
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
  // ...calls moveCabinetItem / moveCabinetFolder based on target.type...
  dragPayload.current = null;
  await refresh();
}
```

### The folder row (draggable)

```tsx
<div
  data-cabinet-row
  draggable={!isRenaming}
  onDragStart={(e) => onDragStart(e, { kind: "folder", id: node.folder.id })}
  onDragEnd={onDragEnd}
  onDragOver={(e) => onDragOver(e, { type: "into-folder", folderId: node.folder.id })}
  onDrop={(e) => onDrop(e, { type: "into-folder", folderId: node.folder.id })}
  onDoubleClick={/* toggle collapse */}
  onContextMenu={/* show context menu */}
  style={{ display: "flex", alignItems: "center", height: 24, /* indented paddingLeft */ }}
>
  <span /* chevron toggle */>▸/▾</span>
  <span>📁/📂</span>
  <span>{node.folder.name}</span>
</div>
```

### The item row (draggable)

```tsx
<div
  data-cabinet-row
  draggable
  onDragStart={(e) => onDragStart(e, { kind: "item", id: item.id })}
  onDragEnd={onDragEnd}
  onDragOver={(e) => onDragOver(e, { type: "after-item", itemId: item.id, folderId: item.folder_id })}
  onDrop={(e) => onDrop(e, { type: "after-item", itemId: item.id, folderId: item.folder_id })}
  onDoubleClick={() => handleOpenItem(item)}
  onContextMenu={/* ... */}
  style={{ display: "flex", alignItems: "center", height: 24, /* indented */ }}
>
  <span /* type badge: PDF/XLS/LS */ />
  <span>{item.display_name}</span>
  <span /* size */ /><span /* modified */ />
</div>
```

### The scroll container (root drop zone)

```tsx
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
  {/* injected to stop child spans from being the drop target */}
  <style>{`.cabinet-tree.dragging [data-cabinet-row] * { pointer-events: none; }`}</style>
  {/* ...rows... */}
</div>
```

### External-file Tauri listener (this part WORKS)

```tsx
useEffect(() => {
  const unlisten = appWindow.onFileDropEvent((event) => {
    if (isInternalDrag.current) { setOsDragging(false); return; } // ignore during in-app drag
    if (event.payload.type === "hover") setOsDragging(true);
    else if (event.payload.type === "drop") {
      setOsDragging(false);
      (async () => {
        for (const p of event.payload.paths) {
          const attached = await attachFile(p);             // copies absolute path into engagement dir
          await upsertCabinetItem({ folder_id: null, kind: "file",
            display_name: attached.name, file_path: attached.name });
        }
        await refresh();
      })();
    } else setOsDragging(false);
  });
  return () => { unlisten.then((f) => f()); };
}, [refresh]);
```

## Things I've already tried (none fixed the red "no-drop" cursor for internal drag)

1. `e.preventDefault()` on `dragover` AND `dragenter` on the row + container.
2. `e.dataTransfer.effectAllowed = "move"` on dragstart and `dropEffect = "move"` on dragover.
3. `e.dataTransfer.setData("text/plain", ...)` on dragstart (some webviews need a payload).
4. `e.dataTransfer.setDragImage(...)` to avoid ghost text selection.
5. `user-select: none` on the whole tree container.
6. A CSS rule `.cabinet-tree.dragging [data-cabinet-row] * { pointer-events: none; }` so the
   row (not a child span) is always the direct drop target during a drag.
7. An `isInternalDrag` ref so the Tauri native-drop listener ignores in-app drags and the
   "Drop to attach" overlay no longer gets stuck.

After all of this: external drop still works; **internal drag still shows the no-drop cursor
and never completes a drop.** This strongly suggests the conflict is at the WebView2/OLE
layer (native file drop suppressing HTML5 DnD), not in my JS.

## What I want from you

1. **Diagnose definitively** whether `fileDropEnabled: true` on Windows WebView2 (Tauri 1.x)
   is what's blocking HTML5 in-app drag-and-drop.
2. **Give me a working implementation** that supports BOTH:
   - External files dragged in from Explorer → attach (needs absolute paths → currently via
     Tauri `onFileDropEvent`).
   - Internal reorganizing: reorder within a folder, move items between folders, move a
     folder (with subtree) into another folder.
3. If the answer is "use a custom mouse-based drag for internal moves while keeping the
   Tauri native listener for external drops," **write that drag implementation in full**
   (pointer/mouse events, drop-target hit-testing against the rendered rows, the drop
   indicator line between rows, and the calls to `moveCabinetItem` / `moveCabinetFolder`).
   Keep it compatible with TypeScript strict mode (no unused vars/params).
4. If upgrading to Tauri 2.x is the clean fix, say so and outline the config + event changes
   (`dragDropEnabled`, `tauri://drag-drop`), and whether HTML5 DnD then works alongside it.

Assume I can change `tauri.conf.json`, the Rust commands, and the React page freely.
```

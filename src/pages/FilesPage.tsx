import { useEffect, useState, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { engagementAtom } from "@/store/atoms";
import {
  listAttachments,
  attachFile,
  removeAttachment,
  openAttachment,
  open,
} from "@/lib/tauri";
import { appWindow } from "@tauri-apps/api/window";
import type { AttachedFile } from "@/types";

const ICON: Record<string, string> = {
  pdf: "PDF",
  xlsx: "XLS",
  xls: "XLS",
  csv: "CSV",
  docx: "DOC",
  doc: "DOC",
  png: "IMG",
  jpg: "IMG",
  jpeg: "IMG",
  txt: "TXT",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesPage() {
  const [engagement] = useAtom(engagementAtom);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Track how many drag-enter events are nested so we don't flicker on child elements
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await listAttachments());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Tauri window-level file drop events
  useEffect(() => {
    let unlistenHover: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    let unlistenCancel: (() => void) | null = null;

    appWindow.onFileDropEvent((event) => {
      if (event.payload.type === "hover") {
        setDragging(true);
      } else if (event.payload.type === "drop") {
        setDragging(false);
        const paths = event.payload.paths;
        if (paths.length === 0) return;
        (async () => {
          for (const p of paths) {
            await attachFile(p);
          }
          await refresh();
        })().catch((e) => setError(String(e)));
      } else {
        // cancelled
        setDragging(false);
      }
    }).then((unlisten) => {
      unlistenHover = unlisten;
    });

    return () => {
      unlistenHover?.();
      unlistenDrop?.();
      unlistenCancel?.();
    };
  }, [refresh]);

  const handleAttach = async () => {
    const selected = await open({ title: "Attach File", multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const p of paths) {
      await attachFile(p);
    }
    await refresh();
  };

  const handleOpen = async (f: AttachedFile) => {
    try {
      await openAttachment(f.path);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRemove = async (f: AttachedFile) => {
    if (!confirm(`Delete "${f.name}" from the engagement folder?`)) return;
    try {
      await removeAttachment(f.path);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
      }}
    >
      {/* Drop overlay */}
      {dragging && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 50,
            background: "rgba(0,0,0,0.06)",
            border: "2px dashed var(--color-border-strong)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.04em" }}>
            Drop files to attach
          </span>
        </div>
      )}

      <div className="page-header">
        <span className="page-header__title">Files</span>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)", flex: 1 }}>
          {engagement?.db_path ? engagement.db_path.replace(/[^/\\]+$/, "") : ""}
        </span>
        <button className="btn btn-sm btn-primary" onClick={handleAttach}>
          + Attach Files
        </button>
      </div>

      {error && (
        <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12 }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ padding: 16, fontSize: 12, color: "var(--color-text-muted)" }}>
          Loading…
        </div>
      )}

      {!loading && files.length === 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            gap: 12,
            color: "var(--color-text-muted)",
          }}
        >
          <span style={{ fontSize: 12 }}>Drop files here or click Attach</span>
          <button className="btn btn-sm" onClick={handleAttach}>
            Attach a file
          </button>
        </div>
      )}

      {!loading && files.length > 0 && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <table className="data-grid" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 50 }}>Type</th>
                <th>File Name</th>
                <th style={{ width: 90, textAlign: "right" }}>Size</th>
                <th style={{ width: 130 }}>Modified</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr
                  key={f.path}
                  style={{ cursor: "pointer" }}
                  onDoubleClick={() => handleOpen(f)}
                >
                  <td>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "1px 4px",
                        border: "1px solid var(--color-border)",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {ICON[f.ext] ?? (f.ext.toUpperCase().slice(0, 4) || "—")}
                    </span>
                  </td>
                  <td onClick={() => handleOpen(f)}>{f.name}</td>
                  <td
                    className="numeric text-muted"
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
                  >
                    {formatBytes(f.size_bytes)}
                  </td>
                  <td
                    className="text-muted"
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
                  >
                    {f.modified}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn btn-sm" onClick={() => handleOpen(f)}>
                        Open
                      </button>
                      {!engagement?.is_locked && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleRemove(f)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        style={{
          borderTop: "1px solid var(--color-border)",
          padding: "6px 16px",
          fontSize: 11,
          color: "var(--color-text-muted)",
        }}
      >
        {files.length} file{files.length !== 1 ? "s" : ""} — double-click or drag &
        drop to attach • stored alongside the engagement database
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { readBinaryFile } from "@tauri-apps/api/fs";
import {
  deleteDocAsset,
  deleteDocPackage,
  deleteDocTemplate,
  deletePackageItem,
  getDocTemplate,
  listDocAssets,
  listDocPackages,
  listDocTemplates,
  listPackageItems,
  listStatements,
  renderPackage,
  renderTemplate,
  reorderPackageItems,
  seedDefaultTemplates,
  upsertDocAsset,
  upsertDocPackage,
  upsertDocTemplate,
  upsertPackageItem,
} from "@/lib/tauri";
import type {
  DocAsset,
  DocPackage,
  DocPackageItem,
  DocTemplate,
  Statement,
} from "@/types";

// ── Tag reference cheat sheet (for the picker) ───────────────────────────────
const TAG_GROUPS = [
  {
    label: "Engagement",
    tags: [
      { tag: "{{entity_name}}", desc: "Company name" },
      { tag: "{{year_end}}", desc: "Year end (formatted)" },
      { tag: "{{year_end|short}}", desc: "Year end (ISO)" },
      { tag: "{{fiscal_year}}", desc: "Fiscal year number" },
      { tag: "{{currency}}", desc: "Currency code" },
      { tag: "{{prepared_date}}", desc: "Today's date" },
      { tag: "{{preparer_name}}", desc: "Preparer name (from settings)" },
      { tag: "{{preparer_initials}}", desc: "Preparer initials" },
    ],
  },
  {
    label: "Financial",
    tags: [
      { tag: "{{M:1000}}", desc: "Map code total (current)" },
      { tag: "{{M:1000|prior}}", desc: "Map code total (prior year)" },
      { tag: "{{SUM(1000..1999)}}", desc: "Sum map range (current)" },
      { tag: "{{SUM(1000..1999)|prior}}", desc: "Sum map range (prior)" },
      { tag: "{{G:1}}", desc: "Grouping total by ID" },
      { tag: "{{A:10100}}", desc: "Single account balance" },
    ],
  },
  {
    label: "Custom Variables",
    tags: [
      { tag: "{{V:firm_name}}", desc: "Custom variable (text)" },
      { tag: "{{V:engagement_partner}}", desc: "Example: partner name" },
    ],
  },
  {
    label: "Notes",
    tags: [
      { tag: "{{note_ref:key}}", desc: "Insert 'Note N' — first use anchors the number" },
      { tag: "{{note_ref:key|inline}}", desc: "Insert superscript '(N)'" },
      { tag: "{{note_def:key|title=Title}}", desc: "Mark where the note is defined" },
    ],
  },
  {
    label: "Statements",
    tags: [
      { tag: "{{statement:balance_sheet}}", desc: "Embed Balance Sheet" },
      { tag: "{{statement:income_statement}}", desc: "Embed Income Statement" },
      { tag: "{{statement:cash_flow}}", desc: "Embed Cash Flow Statement" },
      { tag: "{{statement:equity}}", desc: "Embed Statement of Equity" },
      { tag: "{{statement:id:42}}", desc: "Embed custom statement by ID" },
    ],
  },
  {
    label: "Images",
    tags: [
      { tag: "{{image:firm_logo}}", desc: "Insert firm logo" },
      { tag: "{{image:firm_logo|width=200px}}", desc: "Insert logo with width" },
      { tag: "{{image:partner_sig|width=150px}}", desc: "Insert partner signature" },
    ],
  },
];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const [packages, setPackages] = useState<DocPackage[]>([]);
  const [templates, setTemplates] = useState<DocTemplate[]>([]);
  const [assets, setAssets] = useState<DocAsset[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const [selectedPkg, setSelectedPkg] = useState<DocPackage | null>(null);
  const [items, setItems] = useState<DocPackageItem[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<DocTemplate | null>(null);
  const [tab, setTab] = useState<"editor" | "assets">("editor");
  const [editorView, setEditorView] = useState<"code" | "preview">("code");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [newPkgName, setNewPkgName] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      await seedDefaultTemplates();
      const [pkgs, tmpls, asets, stmts] = await Promise.all([
        listDocPackages(),
        listDocTemplates(),
        listDocAssets(),
        listStatements(),
      ]);
      setPackages(pkgs);
      setTemplates(tmpls);
      setAssets(asets);
      setStatements(stmts);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh preview when the active template changes while in preview mode
  useEffect(() => {
    if (editorView === "preview" && activeTemplate) {
      switchToPreview(activeTemplate.body_html);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate?.id]);

  const selectPackage = async (pkg: DocPackage) => {
    setSelectedPkg(pkg);
    setActiveTemplate(null);
    try {
      const its = await listPackageItems(pkg.id);
      setItems(its);
    } catch (e) {
      setError(String(e));
    }
  };

  const createPackage = async () => {
    const name = newPkgName.trim() || "New Package";
    try {
      const id = await upsertDocPackage({ name });
      setNewPkgName("");
      await load();
      const pkgs = await listDocPackages();
      const created = pkgs.find((p) => p.id === id);
      if (created) await selectPackage(created);
    } catch (e) {
      setError(String(e));
    }
  };

  const removePackage = async (id: number) => {
    if (!confirm("Delete this package and all its items?")) return;
    try {
      await deleteDocPackage(id);
      if (selectedPkg?.id === id) { setSelectedPkg(null); setItems([]); setActiveTemplate(null); }
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const addItemToPackage = async (
    kind: "template" | "statement",
    refId: number
  ) => {
    if (!selectedPkg) return;
    try {
      await upsertPackageItem({
        package_id: selectedPkg.id,
        sort_order: items.length,
        item_kind: kind,
        doc_template_id: kind === "template" ? refId : null,
        statement_id: kind === "statement" ? refId : null,
      });
      const its = await listPackageItems(selectedPkg.id);
      setItems(its);
      setAddingItem(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const removeItem = async (id: number) => {
    try {
      await deletePackageItem(id);
      if (selectedPkg) {
        const its = await listPackageItems(selectedPkg.id);
        setItems(its);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const moveItem = async (index: number, dir: -1 | 1) => {
    const next = [...items];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setItems(next);
    try {
      await reorderPackageItems(next.map((i) => i.id));
    } catch (e) {
      setError(String(e));
      if (selectedPkg) setItems(await listPackageItems(selectedPkg.id));
    }
  };

  const openItemTemplate = async (item: DocPackageItem) => {
    if (item.item_kind !== "template" || !item.doc_template_id) return;
    try {
      const tmpl = await getDocTemplate(item.doc_template_id);
      setActiveTemplate(tmpl);
      setTab("editor");
    } catch (e) {
      setError(String(e));
    }
  };

  const saveTemplate = async () => {
    if (!activeTemplate) return;
    try {
      await upsertDocTemplate({
        id: activeTemplate.id,
        name: activeTemplate.name,
        kind: activeTemplate.kind,
        body_html: activeTemplate.body_html,
        description: activeTemplate.description,
      });
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const insertTag = (tag: string) => {
    const ta = textareaRef.current;
    if (!ta || !activeTemplate) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const body = activeTemplate.body_html;
    const newBody = body.slice(0, start) + tag + body.slice(end);
    setActiveTemplate({ ...activeTemplate, body_html: newBody });
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + tag.length;
      ta.focus();
    });
    setTagPickerOpen(false);
  };

  const switchToPreview = async (body: string) => {
    setPreviewLoading(true);
    setEditorView("preview");
    try {
      const rendered = await renderTemplate(body);
      setPreviewHtml(buildPreviewHtml([rendered], activeTemplate?.name ?? "Preview"));
    } catch (e) {
      setPreviewHtml(`<p style="color:red;padding:16px">${String(e)}</p>`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const previewPackageInline = async () => {
    if (!selectedPkg) return;
    setPreviewLoading(true);
    try {
      const result = await renderPackage(selectedPkg.id);
      setPreviewHtml(buildPreviewHtml(result.fragments, result.engagement.entity_name));
      setTab("editor");
      setEditorView("preview");
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const createNewTemplate = async () => {
    try {
      const id = await upsertDocTemplate({
        name: "New Template",
        kind: "CUSTOM",
        body_html: "<div style=\"font-family: Georgia, serif; margin: 40px;\">\n  <h1>{{entity_name}}</h1>\n  <p>For the year ended {{year_end}}</p>\n</div>",
      });
      await load();
      const tmpl = await getDocTemplate(id);
      setActiveTemplate(tmpl);
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteTemplate = async (id: number) => {
    if (!confirm("Delete this template?")) return;
    try {
      await deleteDocTemplate(id);
      if (activeTemplate?.id === id) setActiveTemplate(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Left panel: packages + template library ── */}
      <div style={{
        width: 240, flexShrink: 0, borderRight: "1px solid var(--color-border)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Packages */}
        <div style={{ padding: "10px 12px 6px", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: 6 }}>
            Packages
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <input
              className="input input-sm"
              placeholder="Package name…"
              value={newPkgName}
              onChange={(e) => setNewPkgName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createPackage()}
              style={{ flex: 1 }}
            />
            <button className="btn btn-sm btn-primary" onClick={createPackage}>+</button>
          </div>
          <div style={{ marginTop: 4 }}>
            {packages.map((p) => (
              <div
                key={p.id}
                onClick={() => selectPackage(p)}
                style={{
                  display: "flex", alignItems: "center", padding: "4px 6px",
                  borderRadius: 3, cursor: "pointer", fontSize: 12,
                  background: selectedPkg?.id === p.id ? "var(--color-primary)" : undefined,
                  color: selectedPkg?.id === p.id ? "#fff" : undefined,
                }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                <button
                  className="btn btn-xs"
                  onClick={(e) => { e.stopPropagation(); removePackage(p.id); }}
                  style={{ opacity: 0.6 }}
                >✕</button>
              </div>
            ))}
          </div>
        </div>

        {/* Template library */}
        <div style={{ padding: "10px 12px 6px", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", flex: 1 }}>
              Templates
            </span>
            <button className="btn btn-xs btn-primary" onClick={createNewTemplate}>+ New</button>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "4px 0" }}>
          {templates.map((t) => (
            <div
              key={t.id}
              onClick={() => setActiveTemplate(t)}
              style={{
                display: "flex", alignItems: "center", padding: "4px 12px",
                cursor: "pointer", fontSize: 12,
                background: activeTemplate?.id === t.id ? "var(--color-bg-subtle, rgba(255,255,255,0.04))" : undefined,
                borderLeft: activeTemplate?.id === t.id ? "2px solid var(--color-primary)" : "2px solid transparent",
              }}
            >
              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-muted)", minWidth: 36, fontFamily: "var(--font-mono)" }}>
                {t.kind.slice(0, 4)}
              </span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
              <button
                className="btn btn-xs"
                onClick={(e) => { e.stopPropagation(); deleteTemplate(t.id); }}
                style={{ opacity: 0.4, fontSize: 10 }}
              >✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Centre panel: package composer ── */}
      <div style={{
        width: 220, flexShrink: 0, borderRight: "1px solid var(--color-border)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: 6 }}>
            {selectedPkg ? selectedPkg.name : "Select a package"}
          </div>
          {selectedPkg && (
            <div style={{ display: "flex", gap: 4 }}>
              <button className="btn btn-sm btn-primary" onClick={previewPackageInline} style={{ flex: 1 }}>
                Preview All
              </button>
              <button className="btn btn-sm" onClick={() => setAddingItem(true)}>+ Add</button>
            </div>
          )}
        </div>

        <div style={{ overflow: "auto", flex: 1 }}>
          {!selectedPkg && (
            <div style={{ padding: 16, color: "var(--color-text-muted)", fontSize: 12 }}>
              Create or select a package to compose documents.
            </div>
          )}
          {selectedPkg && items.map((item, i) => {
            const tmpl = templates.find((t) => t.id === item.doc_template_id);
            const stmt = statements.find((s) => s.id === item.statement_id);
            const label = item.item_kind === "template" ? (tmpl?.name ?? "Template") : (stmt?.name ?? "Statement");
            const badge = item.item_kind === "template" ? "T" : "S";
            return (
              <div
                key={item.id}
                onClick={() => openItemTemplate(item)}
                style={{
                  display: "flex", alignItems: "center", padding: "5px 10px",
                  borderBottom: "1px solid var(--color-border)", cursor: "pointer",
                  fontSize: 12, gap: 6,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); moveItem(i, -1); }} disabled={i === 0} style={{ lineHeight: 1, padding: "0 3px" }}>▲</button>
                  <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); moveItem(i, 1); }} disabled={i === items.length - 1} style={{ lineHeight: 1, padding: "0 3px" }}>▼</button>
                </div>
                <span style={{
                  fontSize: 9, fontWeight: 700, color: item.item_kind === "template" ? "var(--color-primary)" : "#34d399",
                  fontFamily: "var(--font-mono)", minWidth: 12,
                }}>{badge}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); removeItem(item.id); }} style={{ opacity: 0.4 }}>✕</button>
              </div>
            );
          })}
        </div>

        {/* Add item picker */}
        {addingItem && selectedPkg && (
          <div style={{
            position: "absolute", zIndex: 300, background: "var(--color-bg)",
            border: "1px solid var(--color-border)", borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)", padding: 12,
            width: 220, left: 240, top: 60,
          }}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8 }}>Add item to package</div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>Templates</div>
            {templates.map((t) => (
              <div
                key={t.id}
                onClick={() => addItemToPackage("template", t.id)}
                className="sidebar-nav-item"
                style={{ fontSize: 12, padding: "3px 6px" }}
              >{t.name}</div>
            ))}
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", margin: "8px 0 4px" }}>Statements</div>
            {statements.map((s) => (
              <div
                key={s.id}
                onClick={() => addItemToPackage("statement", s.id)}
                className="sidebar-nav-item"
                style={{ fontSize: 12, padding: "3px 6px" }}
              >{s.name}</div>
            ))}
            <button className="btn btn-sm" style={{ marginTop: 8, width: "100%" }} onClick={() => setAddingItem(false)}>Cancel</button>
          </div>
        )}
      </div>

      {/* ── Right panel: template editor / assets ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top-level tabs: Editor / Assets */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
          {(["editor", "assets"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "8px 16px", fontSize: 12, background: "none", border: "none",
                borderBottom: tab === t ? "2px solid var(--color-primary)" : "2px solid transparent",
                color: tab === t ? "var(--color-text)" : "var(--color-text-muted)",
                cursor: "pointer", fontWeight: tab === t ? 600 : 400,
              }}
            >{t === "editor" ? "Template Editor" : "Assets"}</button>
          ))}
        </div>

        {error && (
          <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12, flexShrink: 0 }}>{error}</div>
        )}

        {tab === "editor" && (
          activeTemplate ? (
            <TemplateEditor
              template={activeTemplate}
              onChange={setActiveTemplate}
              onSave={saveTemplate}
              view={editorView}
              onViewChange={(v) => {
                if (v === "preview") {
                  switchToPreview(activeTemplate.body_html);
                } else {
                  setEditorView("code");
                }
              }}
              previewHtml={previewHtml}
              previewLoading={previewLoading}
              onTagPicker={() => setTagPickerOpen(true)}
              textareaRef={textareaRef}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-muted)", fontSize: 13 }}>
              Select a template from the list or add one to a package to edit it.
            </div>
          )
        )}

        {tab === "assets" && (
          <AssetsPanel assets={assets} onChanged={load} />
        )}
      </div>

      {tagPickerOpen && (
        <TagPicker onPick={insertTag} onClose={() => setTagPickerOpen(false)} />
      )}
    </div>
  );
}

// ── Template editor panel ─────────────────────────────────────────────────────

const KINDS = ["COVER", "LETTER", "NOTES", "FS_EMBED", "CUSTOM"];

function TemplateEditor({
  template,
  onChange,
  onSave,
  view,
  onViewChange,
  previewHtml,
  previewLoading,
  onTagPicker,
  textareaRef,
}: {
  template: DocTemplate;
  onChange: (t: DocTemplate) => void;
  onSave: () => void;
  view: "code" | "preview";
  onViewChange: (v: "code" | "preview") => void;
  previewHtml: string | null;
  previewLoading: boolean;
  onTagPicker: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
        borderBottom: "1px solid var(--color-border)", flexShrink: 0,
      }}>
        <input
          className="input input-sm"
          value={template.name}
          onChange={(e) => onChange({ ...template, name: e.target.value })}
          style={{ width: 200, fontWeight: 600 }}
        />
        <select
          className="select"
          value={template.kind}
          onChange={(e) => onChange({ ...template, kind: e.target.value })}
          style={{ width: 110 }}
        >
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>

        {/* Code / Preview toggle */}
        <button
          className={`btn btn-sm${view === "code" ? " btn-primary" : ""}`}
          onClick={() => onViewChange("code")}
        >Code</button>
        <button
          className={`btn btn-sm${view === "preview" ? " btn-primary" : ""}`}
          onClick={() => onViewChange("preview")}
        >Preview</button>

        <div style={{ flex: 1 }} />
        {view === "code" && (
          <button className="btn btn-sm" onClick={onTagPicker}>Insert tag…</button>
        )}
        <button className="btn btn-sm btn-primary" onClick={onSave}>Save</button>
      </div>

      {/* Code view */}
      {view === "code" && (
        <>
          <div style={{
            padding: "3px 12px", fontSize: 10, color: "var(--color-text-muted)",
            borderBottom: "1px solid var(--color-border)", flexShrink: 0,
            fontFamily: "var(--font-mono)",
          }}>
            {"{{entity_name}}  {{year_end}}  {{M:code}}  {{SUM(lo..hi)}}  {{note_ref:key}}  {{image:name}}  {{statement:balance_sheet}}"}
          </div>
          <textarea
            ref={textareaRef}
            value={template.body_html}
            onChange={(e) => onChange({ ...template, body_html: e.target.value })}
            spellCheck={false}
            style={{
              flex: 1, resize: "none", border: "none", outline: "none",
              padding: "12px 16px", fontFamily: "var(--font-mono)", fontSize: 13,
              lineHeight: 1.6, background: "var(--color-bg)", color: "var(--color-text)",
              overflowY: "auto",
            }}
          />
        </>
      )}

      {/* Preview view — rendered HTML in a sandboxed iframe */}
      {view === "preview" && (
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {previewLoading && (
            <div style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center",
              justifyContent: "center", background: "var(--color-bg)", zIndex: 10,
              fontSize: 13, color: "var(--color-text-muted)",
            }}>
              Rendering…
            </div>
          )}
          {previewHtml && !previewLoading && (
            <iframe
              srcDoc={previewHtml}
              style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
              title="Template preview"
              sandbox="allow-same-origin allow-scripts"
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Assets panel ──────────────────────────────────────────────────────────────

function AssetsPanel({ assets, onChanged }: { assets: DocAsset[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async () => {
    // Use Tauri file dialog
    const { open } = await import("@tauri-apps/api/dialog");
    const selected = await open({
      title: "Select Image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "svg", "gif", "webp"] }],
    });
    if (!selected || Array.isArray(selected)) return;

    setUploading(true);
    setError(null);
    try {
      const bytes = await readBinaryFile(selected as string);
      // Size check: 512 KB
      if (bytes.length > 512 * 1024) {
        setError(`Image is too large (${(bytes.length / 1024).toFixed(0)} KB). Maximum is 512 KB.`);
        return;
      }
      const b64 = btoa(String.fromCharCode(...bytes));
      const path = selected as string;
      const ext = path.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "asset";
      await upsertDocAsset({ name, mime_type: mime, data_base64: b64 });
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await deleteDocAsset(id);
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16, gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Image Assets</span>
        <button className="btn btn-sm btn-primary" onClick={handleUpload} disabled={uploading}>
          {uploading ? "Uploading…" : "Upload image"}
        </button>
      </div>

      {error && <div style={{ color: "var(--color-danger)", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 12 }}>
        Assets are stored in the engagement DB. Reference them in templates with{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>{"{{image:name}}"}</code>.
        Max 512 KB per image.
      </div>

      {assets.length === 0 && (
        <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
          No assets yet. Upload a logo or signature to get started.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {assets.map((a) => (
          <div key={a.id} style={{
            border: "1px solid var(--color-border)", borderRadius: 4,
            padding: 8, width: 160,
          }}>
            <img
              src={`data:${a.mime_type};base64,${a.data_base64}`}
              alt={a.name}
              style={{ width: "100%", height: 80, objectFit: "contain", display: "block" }}
            />
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                {a.name}
              </span>
              <button className="btn btn-xs" onClick={() => remove(a.id)}>✕</button>
            </div>
            <div style={{ fontSize: 10, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
              {`{{image:${a.name}}}`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tag picker modal ──────────────────────────────────────────────────────────

function TagPicker({ onPick, onClose }: { onPick: (tag: string) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const q = search.toLowerCase();

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 6,
          width: 520, maxHeight: "75vh", display: "flex", flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Insert tag</div>
          <input
            className="input"
            placeholder="Search tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: "8px 0" }}>
          {TAG_GROUPS.map((group) => {
            const filtered = group.tags.filter(
              (t) => !q || t.tag.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)
            );
            if (filtered.length === 0) return null;
            return (
              <div key={group.label}>
                <div style={{ padding: "6px 14px 2px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)" }}>
                  {group.label}
                </div>
                {filtered.map((t) => (
                  <div
                    key={t.tag}
                    onClick={() => onPick(t.tag)}
                    style={{
                      display: "flex", alignItems: "center", padding: "5px 14px",
                      cursor: "pointer", gap: 12, fontSize: 12,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-subtle, rgba(255,255,255,0.04))")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                  >
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-primary)", minWidth: 200 }}>
                      {t.tag}
                    </code>
                    <span style={{ color: "var(--color-text-muted)" }}>{t.desc}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Preview HTML builder ──────────────────────────────────────────────────────

function buildPreviewHtml(fragments: string[], title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, serif; font-size: 11pt; color: #000; background: #fff; }
  @media print { body { margin: 0; } }
  .fs-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  .fs-table td { padding: 2px 8px; vertical-align: top; }
  .fs-table .fs-amount { text-align: right; white-space: nowrap; }
  .fs-header td { font-weight: bold; padding-top: 10px; }
  .fs-subtotal td { border-top: 1px solid #000; }
  .fs-spacer td { height: 8px; }
  .note-heading { margin: 16px 0 6px; font-size: 11pt; }
  sup { font-size: 8pt; }
</style>
</head>
<body>
${fragments.join('\n<div style="page-break-before: always;"></div>\n')}
</body>
</html>`;
}

import { useState, useEffect } from "react";
import { useAtom, useSetAtom } from "jotai";
import { engagementAtom, settingsAtom } from "@/store/atoms";
import { openEngagement, createEngagement, importWwp, open, save, getSettings, saveSettings } from "@/lib/tauri";
import type { AppSettings } from "@/types";

type Mode = "home" | "create";

const MAX_RECENT = 8;

function addToRecent(settings: AppSettings, path: string): AppSettings {
  const filtered = settings.recent_files.filter((p) => p !== path);
  return {
    ...settings,
    recent_files: [path, ...filtered].slice(0, MAX_RECENT),
  };
}

export default function WelcomePage() {
  const setEngagement = useSetAtom(engagementAtom);
  const [settings, setSettings] = useAtom(settingsAtom);
  const [mode, setMode] = useState<Mode>("home");
  const [error, setError] = useState<string | null>(null);

  const [entityName, setEntityName] = useState("");
  const [yearEnd, setYearEnd] = useState("");
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [currency, setCurrency] = useState("USD");

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
  }, []);

  const openPath = async (path: string) => {
    try {
      const meta = await openEngagement(path);
      const updated = addToRecent(settings, path);
      await saveSettings(updated);
      setSettings(updated);
      setEngagement(meta);
    } catch (e) {
      setError(`Could not open "${path}": ${e}`);
    }
  };

  const handleOpen = async () => {
    const selected = await open({
      title: "Open Engagement",
      filters: [
        { name: "Engagement Database", extensions: ["db"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!selected || Array.isArray(selected)) return;
    await openPath(selected);
  };

  const handleCreate = async () => {
    if (!entityName || !yearEnd) {
      setError("Entity name and year-end date are required.");
      return;
    }
    try {
      const savePath = await save({
        title: "Save Engagement Database",
        defaultPath: `${entityName.replace(/\s+/g, "_")}_${fiscalYear}.db`,
        filters: [{ name: "Engagement Database", extensions: ["db"] }],
      });
      if (!savePath) return;
      const meta = await createEngagement({
        db_path: savePath,
        entity_name: entityName,
        year_end: yearEnd,
        fiscal_year: fiscalYear,
        currency,
      });
      const updated = addToRecent(settings, savePath);
      await saveSettings(updated);
      setSettings(updated);
      setEngagement(meta);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleImportWwp = async () => {
    const wwpPath = await open({
      title: "Open .wwp Archive",
      filters: [{ name: "Worked Papers Archive", extensions: ["wwp"] }],
    });
    if (!wwpPath || Array.isArray(wwpPath)) return;

    const targetDir = await open({
      title: "Choose folder to extract into",
      directory: true,
    });
    if (!targetDir || Array.isArray(targetDir)) return;

    const password = prompt("Enter archive password:");
    if (!password) return;

    try {
      const dbPath = await importWwp(wwpPath, targetDir, password);
      await openPath(dbPath);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRemoveRecent = async (path: string) => {
    const updated = {
      ...settings,
      recent_files: settings.recent_files.filter((p) => p !== path),
    };
    await saveSettings(updated);
    setSettings(updated);
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 32,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
          Worked Papers
        </h1>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
          Modern working papers for accounting firms
        </p>
      </div>

      {mode === "home" && (
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          {/* Actions */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 200 }}>
            <button className="btn btn-primary" style={{ height: 36 }} onClick={handleOpen}>
              Open Engagement…
            </button>
            <button className="btn" style={{ height: 36 }} onClick={() => { setMode("create"); setError(null); }}>
              New Engagement…
            </button>
            <button className="btn" style={{ height: 36 }} onClick={handleImportWwp}>
              Import .wwp Archive…
            </button>
          </div>

          {/* Recent files */}
          {settings.recent_files.length > 0 && (
            <div
              style={{
                width: 360,
                border: "1px solid var(--color-border-strong)",
              }}
            >
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--color-text-muted)",
                  borderBottom: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                }}
              >
                Recent
              </div>
              {settings.recent_files.map((path) => {
                const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
                const dir = path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
                return (
                  <div
                    key={path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "0 12px",
                      height: 40,
                      borderBottom: "1px solid var(--color-border)",
                      cursor: "pointer",
                      gap: 8,
                    }}
                    onClick={() => openPath(path)}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "var(--color-hover-bg)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "")
                    }
                  >
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {name}
                      </div>
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--color-text-muted)",
                          fontFamily: "var(--font-mono)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {dir}
                      </div>
                    </div>
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: 10, padding: "0 6px", height: 20 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveRecent(path);
                      }}
                      title="Remove from recent"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {mode === "create" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            width: 320,
            border: "1px solid var(--color-border-strong)",
            padding: 20,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            New Engagement
          </div>
          <input
            className="input"
            placeholder="Entity / Client Name"
            value={entityName}
            onChange={(e) => setEntityName(e.target.value)}
          />
          <input
            className="input"
            type="date"
            placeholder="Year-End Date"
            value={yearEnd}
            onChange={(e) => setYearEnd(e.target.value)}
          />
          <input
            className="input"
            type="number"
            placeholder="Fiscal Year"
            value={fiscalYear}
            onChange={(e) => setFiscalYear(Number(e.target.value))}
          />
          <select
            className="select"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="USD">USD — US Dollar</option>
            <option value="CAD">CAD — Canadian Dollar</option>
            <option value="EUR">EUR — Euro</option>
            <option value="GBP">GBP — British Pound</option>
          </select>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="btn" onClick={() => { setMode("home"); setError(null); }}>
              Back
            </button>
            <button className="btn btn-primary flex-1" onClick={handleCreate}>
              Create & Save
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ color: "var(--color-danger)", fontSize: 12, maxWidth: 400 }}>
          {error}
        </div>
      )}
    </div>
  );
}

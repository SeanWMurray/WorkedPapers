import { useState } from "react";
import { useAtom } from "jotai";
import { settingsAtom, engagementAtom } from "@/store/atoms";
import { saveSettings, lockEngagement, rollForward, exportWwp, save } from "@/lib/tauri";
import type { AppSettings } from "@/types";

export default function SettingsPage() {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [engagement, setEngagement] = useAtom(engagementAtom);
  const [local, setLocal] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    await saveSettings(local);
    setSettings(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleLock = async () => {
    if (!engagement) return;
    if (!confirm("Lock this engagement? This cannot be undone.")) return;
    const hash = await lockEngagement(local.user_name);
    setEngagement({ ...engagement, is_locked: true });
    alert(`Engagement locked.\nSeal hash: ${hash}`);
  };

  const handleExportWwp = async () => {
    const savePath = await save({
      title: "Export as .wwp",
      filters: [{ name: "Worked Papers Archive", extensions: ["wwp"] }],
    });
    if (!savePath) return;
    const password = prompt("Enter export password:");
    if (!password) return;
    await exportWwp(savePath, password);
    alert("Exported successfully.");
  };

  const handleRollForward = async () => {
    if (!engagement) return;
    const newYearEnd = prompt("New year-end date (YYYY-MM-DD):");
    if (!newYearEnd) return;
    const newFY = prompt("New fiscal year:", String(engagement.fiscal_year + 1));
    if (!newFY) return;
    const savePath = await save({
      title: "Save Roll-Forward Database",
      defaultPath: `${engagement.entity_name.replace(/\s+/g, "_")}_${newFY}.db`,
      filters: [{ name: "Engagement Database", extensions: ["db"] }],
    });
    if (!savePath) return;
    await rollForward({ new_db_path: savePath, new_year_end: newYearEnd, new_fiscal_year: Number(newFY) });
    alert(`Roll-forward complete. New file saved to:\n${savePath}`);
  };

  const field = (label: string, key: keyof AppSettings, type = "text") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)" }}>
        {label}
      </label>
      <input
        className="input"
        type={type}
        value={String(local[key])}
        onChange={(e) => setLocal((s) => ({ ...s, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <span className="page-header__title">Settings</span>
        <button className="btn btn-sm btn-primary" onClick={handleSave}>
          {saved ? "Saved!" : "Save"}
        </button>
      </div>

      <div style={{ overflow: "auto", flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 32, maxWidth: 480 }}>
        {/* User */}
        <section>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>User</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {field("Full Name", "user_name")}
            {field("Initials", "user_initials")}
          </div>
        </section>

        {/* Preferences */}
        <section>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Preferences</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)" }}>
                Theme
              </label>
              <select
                className="select"
                value={local.theme}
                onChange={(e) => setLocal((s) => ({ ...s, theme: e.target.value as "light" | "dark" }))}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            {field("Default Currency", "default_currency")}
          </div>
        </section>

        {/* Engagement actions */}
        {engagement && (
          <section>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>Engagement Actions</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button className="btn" onClick={handleExportWwp}>
                Export as .wwp Archive
              </button>
              {!engagement.is_locked && (
                <>
                  <button className="btn" onClick={handleRollForward}>
                    Year-End Roll-Forward…
                  </button>
                  <button className="btn btn-danger" onClick={handleLock}>
                    Lock Engagement (Seal)
                  </button>
                </>
              )}
            </div>
          </section>
        )}

      </div>
    </div>
  );
}

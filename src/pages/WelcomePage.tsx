import { useState } from "react";
import { useSetAtom } from "jotai";
import { engagementAtom, settingsAtom } from "@/store/atoms";
import { openEngagement, createEngagement, open, save } from "@/lib/tauri";

type Mode = "home" | "create";

export default function WelcomePage() {
  const setEngagement = useSetAtom(engagementAtom);
  const [mode, setMode] = useState<Mode>("home");
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [entityName, setEntityName] = useState("");
  const [yearEnd, setYearEnd] = useState("");
  const [fiscalYear, setFiscalYear] = useState(new Date().getFullYear());
  const [currency, setCurrency] = useState("USD");

  const handleOpen = async () => {
    try {
      const selected = await open({
        title: "Open Engagement",
        filters: [
          { name: "Engagement Database", extensions: ["db"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (!selected || Array.isArray(selected)) return;
      const meta = await openEngagement(selected);
      setEngagement(meta);
    } catch (e) {
      setError(String(e));
    }
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
      setEngagement(meta);
    } catch (e) {
      setError(String(e));
    }
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
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
          Worked Papers
        </h1>
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
          Modern working papers for accounting firms
        </p>
      </div>

      {mode === "home" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 280 }}>
          <button className="btn btn-primary" style={{ height: 36 }} onClick={handleOpen}>
            Open Engagement (.db)
          </button>
          <button className="btn" style={{ height: 36 }} onClick={() => setMode("create")}>
            New Engagement
          </button>
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
        <div style={{ color: "var(--color-danger)", fontSize: 12, maxWidth: 320 }}>
          {error}
        </div>
      )}
    </div>
  );
}

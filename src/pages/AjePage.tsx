import { useEffect, useState, useCallback } from "react";
import { useAtom } from "jotai";
import { ajesAtom, engagementAtom, settingsAtom } from "@/store/atoms";
import { listAjes, postAje, voidAje } from "@/lib/tauri";
import { formatAccounting, formatDate } from "@/lib/format";
import type { Aje, AjeType } from "@/types";

export default function AjePage() {
  const [ajes, setAjes] = useAtom(ajesAtom);
  const [engagement] = useAtom(engagementAtom);
  const [settings] = useAtom(settingsAtom);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setAjes(await listAjes());
  }, [setAjes]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const handleVoid = async (aje: Aje) => {
    const reason = prompt(`Void ${aje.aje_number}? Enter reason:`);
    if (!reason) return;
    await voidAje(aje.id, reason, settings.user_name);
    await refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <span className="page-header__title">Journal Entries</span>
        {!engagement?.is_locked && (
          <button className="btn btn-sm btn-primary" onClick={() => setShowForm(true)}>
            + New Entry
          </button>
        )}
      </div>

      {showForm && (
        <AjeForm
          onClose={() => setShowForm(false)}
          onPosted={refresh}
          preparedBy={settings.user_name}
          currency={engagement?.currency ?? "USD"}
        />
      )}

      {error && (
        <div style={{ padding: "6px 16px", color: "var(--color-danger)", fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto" }}>
        <table className="data-grid" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Number</th>
              <th style={{ width: 110 }}>Type</th>
              <th>Description</th>
              <th style={{ width: 130 }}>Prepared By</th>
              <th style={{ width: 110 }}>Posted</th>
              <th style={{ width: 80 }}>Status</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {ajes.map((aje) => (
              <tr key={aje.id} style={{ opacity: aje.is_voided ? 0.45 : 1 }}>
                <td className="mono">{aje.aje_number}</td>
                <td>
                  <span className="badge" style={{ borderColor: "var(--color-border)" }}>
                    {aje.entry_type}
                  </span>
                </td>
                <td>{aje.description}</td>
                <td className="text-muted">{aje.prepared_by}</td>
                <td className="text-muted mono">{formatDate(aje.posted_at)}</td>
                <td>
                  {aje.is_voided ? (
                    <span className="badge badge-voided">VOIDED</span>
                  ) : (
                    <span className="badge badge-open">POSTED</span>
                  )}
                </td>
                <td>
                  {!aje.is_voided && !engagement?.is_locked && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => handleVoid(aje)}
                    >
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {ajes.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                  No journal entries yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Post AJE Form ─────────────────────────────────────────────────────────────

interface AjeLineInput {
  account_number: string;
  debit: string;
  credit: string;
  description: string;
}

function AjeForm({
  onClose,
  onPosted,
  preparedBy,
  currency,
}: {
  onClose: () => void;
  onPosted: () => void;
  preparedBy: string;
  currency: string;
}) {
  const [entryType, setEntryType] = useState<AjeType>("ADJUSTING");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<AjeLineInput[]>([
    { account_number: "", debit: "", credit: "", description: "" },
    { account_number: "", debit: "", credit: "", description: "" },
  ]);
  const [error, setError] = useState<string | null>(null);

  const totalDebits = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCredits = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.005;

  const updateLine = (i: number, field: keyof AjeLineInput, value: string) => {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  };

  const handleSubmit = async () => {
    setError(null);
    if (!description.trim()) { setError("Description is required"); return; }
    if (!isBalanced) { setError("Entry is out of balance"); return; }

    const parsedLines = lines
      .filter((l) => l.account_number.trim())
      .map((l) => ({
        account_number: l.account_number.trim(),
        debit: parseFloat(l.debit) || 0,
        credit: parseFloat(l.credit) || 0,
        description: l.description || undefined,
      }));

    if (parsedLines.length < 2) { setError("At least 2 lines required"); return; }

    try {
      await postAje({ entry_type: entryType, description, prepared_by: preparedBy, lines: parsedLines });
      await onPosted();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={{ borderBottom: "2px solid var(--color-border-strong)", padding: 16 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
        <select className="select" value={entryType} onChange={(e) => setEntryType(e.target.value as AjeType)} style={{ width: 160 }}>
          <option value="ADJUSTING">AJE — Adjusting</option>
          <option value="RECLASSIFYING">RJE — Reclassifying</option>
          <option value="TAX">TJE — Tax</option>
        </select>
        <input className="input flex-1" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <table className="data-grid" style={{ marginBottom: 8 }}>
        <thead>
          <tr>
            <th>Account #</th>
            <th style={{ width: 130, textAlign: "right" }}>Debit</th>
            <th style={{ width: 130, textAlign: "right" }}>Credit</th>
            <th>Note</th>
            <th style={{ width: 32 }}></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td>
                <input className="input" style={{ border: "none" }} value={line.account_number} onChange={(e) => updateLine(i, "account_number", e.target.value)} placeholder="1000" />
              </td>
              <td>
                <input className="input" style={{ border: "none", textAlign: "right" }} value={line.debit} onChange={(e) => updateLine(i, "debit", e.target.value)} placeholder="0.00" />
              </td>
              <td>
                <input className="input" style={{ border: "none", textAlign: "right" }} value={line.credit} onChange={(e) => updateLine(i, "credit", e.target.value)} placeholder="0.00" />
              </td>
              <td>
                <input className="input" style={{ border: "none" }} value={line.description} onChange={(e) => updateLine(i, "description", e.target.value)} />
              </td>
              <td>
                {lines.length > 2 && (
                  <button className="btn btn-sm" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>×</button>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={5}>
              <button className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { account_number: "", debit: "", credit: "", description: "" }])}>
                + Add Line
              </button>
            </td>
          </tr>
          <tr style={{ borderTop: "2px solid var(--color-border-strong)" }}>
            <td style={{ fontWeight: 700 }}>Totals</td>
            <td style={{ textAlign: "right", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {formatAccounting(totalDebits, currency)}
            </td>
            <td style={{ textAlign: "right", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {formatAccounting(totalCredits, currency)}
            </td>
            <td colSpan={2}>
              {isBalanced ? (
                <span className="badge badge-open">BALANCED</span>
              ) : (
                <span className="badge badge-locked">OUT OF BALANCE</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {error && <div style={{ color: "var(--color-danger)", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSubmit}>Post Entry</button>
      </div>
    </div>
  );
}

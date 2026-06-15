import { useEffect, useState, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { ajesAtom, engagementAtom, settingsAtom, tbAccountsAtom } from "@/store/atoms";
import { listAjes, getTbAccounts, postAje, updateAje, voidAje, signOff, removeSignoff, getSignoffs } from "@/lib/tauri";
import { formatAccounting, formatDate } from "@/lib/format";
import type { Aje, AjeType, TbAccount, Signoff, SignoffRole } from "@/types";

const ROLES: SignoffRole[] = ["PREPARER", "REVIEWER", "PARTNER"];
const ROLE_SHORT: Record<SignoffRole, string> = { PREPARER: "Prep", REVIEWER: "Rev", PARTNER: "Ptr" };

export default function AjePage() {
  const [ajes, setAjes] = useAtom(ajesAtom);
  const [engagement] = useAtom(engagementAtom);
  const [settings] = useAtom(settingsAtom);
  const [accounts, setAccounts] = useAtom(tbAccountsAtom);
  const [showNewForm, setShowNewForm] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [signoffs, setSignoffs] = useState<Record<string, Signoff[]>>({});

  const refreshSignoffs = useCallback(async () => {
    const all = await getSignoffs();
    const byScope: Record<string, Signoff[]> = {};
    for (const s of all) {
      if (!byScope[s.scope]) byScope[s.scope] = [];
      byScope[s.scope].push(s);
    }
    setSignoffs(byScope);
  }, []);

  const refresh = useCallback(async () => {
    const [ajeList, accts] = await Promise.all([listAjes(), getTbAccounts()]);
    setAjes(ajeList);
    setAccounts(accts);
  }, [setAjes, setAccounts]);

  useEffect(() => {
    refresh().catch(() => {});
    refreshSignoffs().catch(() => {});
  }, [refresh, refreshSignoffs]);

  const handleVoid = async (aje: Aje) => {
    const reason = prompt(`Void ${aje.aje_number}? Enter reason:`);
    if (!reason) return;
    await voidAje(aje.id, reason, settings.user_name);
    setSelectedId(null);
    await refresh();
  };

  const handleRowClick = (aje: Aje) => {
    if (showNewForm) return;
    setSelectedId(aje.id === selectedId ? null : aje.id);
    setShowNewForm(false);
  };

  const selectedAje = ajes.find((a) => a.id === selectedId) ?? null;
  const activeAjes = ajes.filter((a) => !a.is_voided);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header">
        <span className="page-header__title">Journal Entries</span>
        {!engagement?.is_locked && (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => { setShowNewForm(true); setSelectedId(null); }}
          >
            + New Entry
          </button>
        )}
      </div>

      <div style={{ flex: selectedAje || showNewForm ? "0 0 50%" : "1 1 auto", overflow: "auto", minHeight: 0 }}>
        <table className="data-grid" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Number</th>
              <th style={{ width: 110 }}>Type</th>
              <th>Description</th>
              <th style={{ width: 130 }}>Prepared By</th>
              <th style={{ width: 110 }}>Posted</th>
              <th style={{ width: 80 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {ajes.map((aje) => (
              <tr
                key={aje.id}
                onClick={() => handleRowClick(aje)}
                style={{
                  opacity: aje.is_voided ? 0.45 : 1,
                  cursor: "pointer",
                  background: selectedId === aje.id ? "var(--color-bg-subtle, rgba(255,255,255,0.04))" : undefined,
                  borderLeft: selectedId === aje.id ? "2px solid var(--color-primary)" : "2px solid transparent",
                }}
              >
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
              </tr>
            ))}
            {ajes.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--color-text-muted)", padding: "24px 0" }}>
                  No journal entries yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showNewForm && (
        <AjeForm
          accounts={accounts}
          onClose={() => setShowNewForm(false)}
          onSaved={async () => { await refresh(); setShowNewForm(false); }}
          preparedBy={settings.user_name}
          currency={engagement?.currency ?? "USD"}
        />
      )}

      {selectedAje && !showNewForm && (
        <AjeForm
          accounts={accounts}
          existingAje={selectedAje}
          allAjes={activeAjes}
          onNavigate={(id) => setSelectedId(id)}
          onClose={() => setSelectedId(null)}
          onSaved={async () => { await refresh(); }}
          onVoid={selectedAje.is_voided || engagement?.is_locked ? undefined : () => handleVoid(selectedAje)}
          isLocked={!!engagement?.is_locked || selectedAje.is_voided}
          preparedBy={settings.user_name}
          currency={engagement?.currency ?? "USD"}
          signoffs={signoffs[`aje:${selectedAje.id}`] ?? []}
          onSignoffChanged={refreshSignoffs}
          currentUser={settings.user_name}
          currentInitials={settings.user_initials}
        />
      )}
    </div>
  );
}

// ── Account selector (combobox) ───────────────────────────────────────────────

function AccountSelector({
  value,
  accounts,
  disabled,
  onChange,
}: {
  value: string;
  accounts: TbAccount[];
  disabled?: boolean;
  onChange: (val: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  const filtered = query.trim() === ""
    ? accounts.slice(0, 50)
    : accounts.filter(
        (a) =>
          a.account_number.includes(query) ||
          a.account_name.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 50);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const select = (acct: TbAccount) => {
    onChange(acct.account_number);
    setQuery(acct.account_number);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: "relative", flex: 1 }}>
      <input
        className="input"
        style={{ border: "none", width: "100%" }}
        value={query}
        placeholder="Account #"
        disabled={disabled}
        onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && !disabled && filtered.length > 0 && (
        <div style={{
          position: "fixed",
          zIndex: 1000,
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          maxHeight: 200,
          overflowY: "auto",
          minWidth: 260,
        }}
          ref={(el) => {
            // Position below the input on mount
            if (!el || !ref.current) return;
            const input = ref.current.querySelector("input");
            if (!input) return;
            const rect = input.getBoundingClientRect();
            el.style.top = rect.bottom + 2 + "px";
            el.style.left = rect.left + "px";
            el.style.width = Math.max(rect.width, 260) + "px";
          }}
        >
          {filtered.map((a) => (
            <div
              key={a.account_number}
              onMouseDown={() => select(a)}
              style={{ padding: "5px 10px", cursor: "pointer", fontSize: 12, display: "flex", gap: 10 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-subtle, rgba(255,255,255,0.06))")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "")}
            >
              <span style={{ fontFamily: "var(--font-mono)", minWidth: 55 }}>{a.account_number}</span>
              <span style={{ color: "var(--color-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.account_name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── AJE Form (new + edit) ─────────────────────────────────────────────────────

interface AjeLineInput {
  account_number: string;
  debit: string;
  credit: string;
  description: string;
}

function toInputLines(aje: Aje): AjeLineInput[] {
  if (aje.lines.length < 2) return [
    { account_number: "", debit: "", credit: "", description: "" },
    { account_number: "", debit: "", credit: "", description: "" },
  ];
  return aje.lines.map((l) => ({
    account_number: l.account_number,
    debit: l.debit !== 0 ? String(l.debit) : "",
    credit: l.credit !== 0 ? String(l.credit) : "",
    description: l.description ?? "",
  }));
}

function AjeForm({
  accounts,
  existingAje,
  allAjes,
  onNavigate,
  onClose,
  onSaved,
  onVoid,
  isLocked,
  preparedBy,
  currency,
  signoffs,
  onSignoffChanged,
  currentUser,
  currentInitials,
}: {
  accounts: TbAccount[];
  existingAje?: Aje;
  allAjes?: Aje[];
  onNavigate?: (id: number) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onVoid?: () => void;
  isLocked?: boolean;
  preparedBy: string;
  currency: string;
  signoffs?: Signoff[];
  onSignoffChanged?: () => void;
  currentUser?: string;
  currentInitials?: string;
}) {
  const isEditing = !!existingAje;

  const [entryType, setEntryType] = useState<AjeType>(existingAje?.entry_type ?? "ADJUSTING");
  const [description, setDescription] = useState(existingAje?.description ?? "");
  const [lines, setLines] = useState<AjeLineInput[]>(
    existingAje ? toInputLines(existingAje) : [
      { account_number: "", debit: "", credit: "", description: "" },
      { account_number: "", debit: "", credit: "", description: "" },
    ]
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset form fields whenever we navigate to a different entry
  useEffect(() => {
    if (existingAje) {
      setEntryType(existingAje.entry_type);
      setDescription(existingAje.description);
      setLines(toInputLines(existingAje));
      setError(null);
    }
  }, [existingAje?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

    setSaving(true);
    try {
      const payload = { entry_type: entryType, description, prepared_by: preparedBy, lines: parsedLines };
      if (isEditing && existingAje) {
        await updateAje(existingAje.id, payload);
      } else {
        await postAje(payload);
      }
      await onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ borderTop: "2px solid var(--color-border-strong)", padding: 14, flex: "0 0 50%", overflow: "auto", background: "var(--color-bg)" }}>
      {/* Header row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "center" }}>
        {isEditing && allAjes && onNavigate && (
          <select
            className="select"
            style={{ width: 200, fontFamily: "var(--font-mono)", fontSize: 12 }}
            value={existingAje!.id}
            onChange={(e) => onNavigate(Number(e.target.value))}
          >
            {allAjes.map((a) => (
              <option key={a.id} value={a.id}>{a.aje_number} — {a.description.slice(0, 35)}</option>
            ))}
          </select>
        )}

        <select
          className="select"
          value={entryType}
          disabled={isLocked}
          onChange={(e) => setEntryType(e.target.value as AjeType)}
          style={{ width: 160 }}
        >
          <option value="ADJUSTING">AJE — Adjusting</option>
          <option value="RECLASSIFYING">RJE — Reclassifying</option>
          <option value="TAX">TJE — Tax</option>
        </select>

        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Description"
          value={description}
          disabled={isLocked}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {!isLocked && onVoid && (
            <button className="btn btn-sm btn-danger" onClick={onVoid}>Void</button>
          )}
          {!isLocked && (
            <button className="btn btn-sm btn-primary" onClick={handleSubmit} disabled={saving}>
              {saving ? "Saving…" : isEditing ? "Save" : "Post"}
            </button>
          )}
          <button className="btn btn-sm" onClick={onClose}>
            {isLocked ? "Close" : "Cancel"}
          </button>
        </div>
      </div>

      {/* Lines table */}
      <table className="data-grid" style={{ marginBottom: 6 }}>
        <thead>
          <tr>
            <th>Account</th>
            <th style={{ width: 130, textAlign: "right" }}>Debit</th>
            <th style={{ width: 130, textAlign: "right" }}>Credit</th>
            <th>Note</th>
            {!isLocked && <th style={{ width: 32 }}></th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td style={{ padding: 0 }}>
                <AccountSelector
                  value={line.account_number}
                  accounts={accounts}
                  disabled={isLocked}
                  onChange={(v) => updateLine(i, "account_number", v)}
                />
              </td>
              <td style={{ padding: 0 }}>
                <input
                  className="input"
                  style={{ border: "none", textAlign: "right" }}
                  value={line.debit}
                  disabled={isLocked}
                  onChange={(e) => updateLine(i, "debit", e.target.value)}
                  placeholder="0.00"
                />
              </td>
              <td style={{ padding: 0 }}>
                <input
                  className="input"
                  style={{ border: "none", textAlign: "right" }}
                  value={line.credit}
                  disabled={isLocked}
                  onChange={(e) => updateLine(i, "credit", e.target.value)}
                  placeholder="0.00"
                />
              </td>
              <td style={{ padding: 0 }}>
                <input
                  className="input"
                  style={{ border: "none" }}
                  value={line.description}
                  disabled={isLocked}
                  onChange={(e) => updateLine(i, "description", e.target.value)}
                />
              </td>
              {!isLocked && (
                <td>
                  {lines.length > 2 && (
                    <button className="btn btn-sm" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>×</button>
                  )}
                </td>
              )}
            </tr>
          ))}
          {!isLocked && (
            <tr>
              <td colSpan={5}>
                <button
                  className="btn btn-sm"
                  onClick={() => setLines((ls) => [...ls, { account_number: "", debit: "", credit: "", description: "" }])}
                >
                  + Add Line
                </button>
              </td>
            </tr>
          )}
          <tr style={{ borderTop: "2px solid var(--color-border-strong)" }}>
            <td style={{ fontWeight: 700 }}>Total</td>
            <td style={{ textAlign: "right", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {formatAccounting(totalDebits, currency)}
            </td>
            <td style={{ textAlign: "right", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {formatAccounting(totalCredits, currency)}
            </td>
            <td colSpan={isLocked ? 1 : 2}>
              {isBalanced
                ? <span className="badge badge-open">BALANCED</span>
                : <span className="badge badge-locked">OUT OF BALANCE</span>
              }
            </td>
          </tr>
        </tbody>
      </table>

      {existingAje?.is_voided && existingAje.voided_reason && (
        <div style={{ fontSize: 12, color: "var(--color-danger)", marginTop: 4 }}>
          Voided: {existingAje.voided_reason}
        </div>
      )}
      {error && <div style={{ color: "var(--color-danger)", fontSize: 12, marginTop: 4 }}>{error}</div>}

      {existingAje && signoffs !== undefined && currentUser && onSignoffChanged && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--color-border)", display: "flex", gap: 16, alignItems: "center" }}>
          {ROLES.map((role) => {
            const scope = `aje:${existingAje.id}`;
            const signers = signoffs.filter((s) => s.role === role);
            const myEntry = signers.find((s) => s.signed_by === currentUser);
            const handleClick = async () => {
              if (isLocked) return;
              if (myEntry) {
                await removeSignoff(myEntry.id, currentUser);
              } else {
                await signOff(scope, role, currentUser, currentInitials ?? "");
              }
              onSignoffChanged();
            };
            return (
              <div key={role} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)" }}>
                  {ROLE_SHORT[role]}
                </span>
                {signers.length > 0 ? (
                  <span
                    title={signers.map((s) => s.signed_by).join(", ")}
                    onClick={handleClick}
                    style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--color-primary)", cursor: isLocked ? "default" : "pointer" }}
                  >
                    {signers.map((s) => s.signed_initials || s.signed_by.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase()).join("/")}
                  </span>
                ) : !isLocked ? (
                  <span
                    onClick={handleClick}
                    style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-text-muted)", cursor: "pointer" }}
                  >
                    —
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useState, useMemo } from "react";

export type FieldMapping =
  | "account_number"
  | "account_name"
  | "debit"
  | "credit"
  | "balance"
  | "prior_balance"
  | "ignore";

const FIELD_OPTIONS: { value: FieldMapping; label: string }[] = [
  { value: "account_number", label: "Account Number" },
  { value: "account_name",   label: "Account Name" },
  { value: "debit",          label: "Debit (+)" },
  { value: "credit",         label: "Credit (−)" },
  { value: "balance",        label: "Balance (signed)" },
  { value: "prior_balance",  label: "Prior Year Balance" },
  { value: "ignore",         label: "— Ignore —" },
];

function guessMapping(header: string): FieldMapping {
  const h = header.toLowerCase().replace(/[\s_\-]+/g, "");
  if (/^(acct|account)(no|num|number|code|#)?$/.test(h) || h === "code") return "account_number";
  if (/account.*name|description|name/.test(h)) return "account_name";
  if (/^debit$|^dr$/.test(h)) return "debit";
  if (/^credit$|^cr$/.test(h)) return "credit";
  if (/^balance$|^amount$|currentbal/.test(h)) return "balance";
  if (/prior|prev|lastyear/.test(h)) return "prior_balance";
  return "ignore";
}

export interface ImportRow {
  account_number: string;
  account_name: string;
  current_balance: number;
  prior_balance: number;
}

interface Props {
  headers: string[];
  rows: string[][];
  onConfirm: (rows: ImportRow[]) => void;
  onCancel: () => void;
}

export default function TbImportWizard({ headers, rows, onConfirm, onCancel }: Props) {
  const [mappings, setMappings] = useState<FieldMapping[]>(
    () => headers.map(guessMapping)
  );
  const [excluded, setExcluded] = useState<Set<number>>(() => {
    const s = new Set<number>();
    rows.forEach((row, i) => {
      const first = row[0]?.trim() ?? "";
      if (!first || !/^\d/.test(first)) s.add(i);
    });
    return s;
  });

  const setMapping = (colIdx: number, value: FieldMapping) =>
    setMappings((m) => m.map((v, i) => (i === colIdx ? value : v)));

  const toggleRow = (rowIdx: number) =>
    setExcluded((s) => {
      const next = new Set(s);
      next.has(rowIdx) ? next.delete(rowIdx) : next.add(rowIdx);
      return next;
    });

  const preview = useMemo<ImportRow[]>(() => {
    return rows
      .filter((_, i) => !excluded.has(i))
      .map((row) => {
        const get = (field: FieldMapping) => {
          const idx = mappings.indexOf(field);
          return idx === -1 ? "" : (row[idx] ?? "").trim();
        };
        const getNum = (field: FieldMapping) => parseFloat(get(field)) || 0;

        let current_balance: number;
        if (mappings.includes("balance")) {
          current_balance = getNum("balance");
        } else {
          // Debits positive, credits negative — no type inference
          current_balance = getNum("debit") - getNum("credit");
        }

        return {
          account_number: get("account_number"),
          account_name:   get("account_name"),
          current_balance,
          prior_balance:  getNum("prior_balance"),
        };
      });
  }, [rows, mappings, excluded]);

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!mappings.includes("account_number")) errs.push("Account Number column is required.");
    if (!mappings.includes("account_name"))   errs.push("Account Name column is required.");
    if (
      !mappings.includes("balance") &&
      !mappings.includes("debit") &&
      !mappings.includes("credit")
    ) {
      errs.push("At least one of: Balance, Debit, or Credit column is required.");
    }
    return errs;
  }, [mappings]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "var(--color-bg)",
          border: "2px solid var(--color-border-strong)",
          width: "min(960px, 100%)",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--color-border-strong)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 14 }}>Import Trial Balance</span>
          <span style={{ fontSize: 12, color: "var(--color-text-muted)", flex: 1 }}>
            Map columns, then uncheck any rows to exclude
          </span>
          <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {preview.length} rows will be imported
          </span>
        </div>

        {/* Column mapping */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--color-border)",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          {headers.map((h, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 130 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--color-text-muted)",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 150,
                }}
                title={h}
              >
                {h}
              </span>
              <select
                className="select"
                value={mappings[i]}
                onChange={(e) => setMapping(i, e.target.value as FieldMapping)}
                style={{
                  fontSize: 11,
                  borderColor:
                    mappings[i] === "ignore"
                      ? "var(--color-border)"
                      : "var(--color-border-strong)",
                }}
              >
                {FIELD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Row preview */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <table className="data-grid" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: 32 }}></th>
                {headers.map((h, i) => (
                  <th
                    key={i}
                    style={{ color: mappings[i] === "ignore" ? "var(--color-text-muted)" : undefined }}
                  >
                    {h}
                  </th>
                ))}
                <th style={{ width: 110, textAlign: "right" }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => {
                const isExcluded = excluded.has(rowIdx);
                const accountNum = (row[mappings.indexOf("account_number")] ?? "").trim();
                const matched = preview.find((p) => p.account_number === accountNum);
                const balance = matched?.current_balance ?? 0;

                return (
                  <tr
                    key={rowIdx}
                    style={{ opacity: isExcluded ? 0.35 : 1, cursor: "pointer" }}
                    onClick={() => toggleRow(rowIdx)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={!isExcluded}
                        onChange={() => toggleRow(rowIdx)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: "pointer" }}
                      />
                    </td>
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        style={{
                          color: mappings[ci] === "ignore" ? "var(--color-text-muted)" : undefined,
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          textDecoration: isExcluded ? "line-through" : undefined,
                        }}
                      >
                        {cell}
                      </td>
                    ))}
                    <td
                      className="numeric"
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: balance < 0 ? "var(--color-danger)" : undefined,
                      }}
                    >
                      {isExcluded ? "" : balance.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--color-border-strong)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {errors.length > 0 ? (
            <span style={{ color: "var(--color-danger)", fontSize: 12, flex: 1 }}>
              {errors[0]}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: "var(--color-text-muted)", flex: 1 }}>
              Click a row to toggle inclusion • debits positive, credits negative
            </span>
          )}
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={errors.length > 0 || preview.length === 0}
            onClick={() => onConfirm(preview)}
          >
            Import {preview.length} Accounts
          </button>
        </div>
      </div>
    </div>
  );
}

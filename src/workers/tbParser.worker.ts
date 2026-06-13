import Papa from "papaparse";

// Infer account type from account code using standard ranges
function inferAccountType(code: string): string {
  const n = parseInt(code, 10);
  if (isNaN(n)) return "ASSET";
  if (n >= 1000 && n <= 1999) return "ASSET";
  if (n >= 2000 && n <= 2999) return "LIABILITY";
  if (n >= 3000 && n <= 3999) return "EQUITY";
  if (n >= 4000 && n <= 4999) return "REVENUE";
  if (n >= 5000 && n <= 5999) return "EXPENSE";
  if (n >= 6000 && n <= 6999) return "EXPENSE";
  if (n >= 7000 && n <= 7999) return "OTHER_INCOME";
  if (n >= 8000 && n <= 8999) return "OTHER_EXPENSE";
  return "ASSET";
}

// Convert separate debit/credit columns to a signed balance.
// Assets/Expenses: debit normal (positive debit, negative credit)
// Liabilities/Equity/Revenue: credit normal (positive credit, negative debit)
function toBalance(
  debit: number,
  credit: number,
  accountType: string
): number {
  const isDebitNormal = accountType === "ASSET" || accountType === "EXPENSE" || accountType === "OTHER_EXPENSE";
  if (isDebitNormal) {
    return debit - credit;
  } else {
    return credit - debit;
  }
}

// Normalize a header string to a simple key
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-]+/g, "_");
}

self.onmessage = async (e: MessageEvent) => {
  if (e.data.type !== "PARSE_CSV") return;

  try {
    const raw: string = e.data.raw;

    const result = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
      transformHeader: norm,
    });

    if (result.errors.length) {
      self.postMessage({ type: "ERROR", error: result.errors[0].message });
      return;
    }

    const rows: {
      account_number: string;
      account_name: string;
      account_type: string;
      current_balance: number;
      prior_balance: number;
    }[] = [];

    for (const row of result.data) {
      // Detect account number from various possible column names
      const accountNumber =
        row.account_number ??
        row.account_code ??
        row.acct_no ??
        row.acct_number ??
        row.account_no ??
        row.code ??
        "";

      // Skip totals/blank rows
      if (!accountNumber.trim() || !/^\d/.test(accountNumber.trim())) continue;

      const accountName =
        row.account_name ??
        row.description ??
        row.name ??
        "";

      const accountType =
        row.account_type ??
        row.type ??
        inferAccountType(accountNumber.trim());

      // Support both single balance column and debit/credit columns
      let currentBalance: number;
      if (row.current_balance !== undefined) {
        currentBalance = parseFloat(row.current_balance) || 0;
      } else if (row.balance !== undefined) {
        currentBalance = parseFloat(row.balance) || 0;
      } else {
        const debit = parseFloat(row.debit ?? row.dr ?? "0") || 0;
        const credit = parseFloat(row.credit ?? row.cr ?? "0") || 0;
        currentBalance = toBalance(debit, credit, inferAccountType(accountNumber.trim()));
      }

      const priorBalance =
        parseFloat(row.prior_balance ?? row.prior ?? row.prior_year ?? "0") || 0;

      rows.push({
        account_number: accountNumber.trim(),
        account_name: accountName.trim(),
        account_type: inferAccountType(accountNumber.trim()),
        current_balance: currentBalance,
        prior_balance: priorBalance,
      });
    }

    if (rows.length === 0) {
      self.postMessage({ type: "ERROR", error: "No valid account rows found. Check that the CSV has an account number column (e.g. 'Account Code', 'Account Number')." });
      return;
    }

    self.postMessage({ type: "PARSED", rows });
  } catch (err) {
    self.postMessage({ type: "ERROR", error: String(err) });
  }
};

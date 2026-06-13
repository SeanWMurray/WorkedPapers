import Papa from "papaparse";
import { readTextFile } from "@tauri-apps/api/fs";

self.onmessage = async (e: MessageEvent) => {
  if (e.data.type !== "PARSE_CSV") return;

  try {
    const raw = await readTextFile(e.data.path);

    const result = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
    });

    if (result.errors.length) {
      self.postMessage({ type: "ERROR", error: result.errors[0].message });
      return;
    }

    // Map CSV columns to expected shape.
    // Expected headers (case-insensitive, underscore-normalized):
    //   account_number, account_name, account_type, current_balance, prior_balance
    const rows = result.data.map((row) => ({
      account_number: row.account_number ?? row.acct_no ?? row.account_no ?? "",
      account_name: row.account_name ?? row.description ?? "",
      account_type: row.account_type ?? row.type ?? "ASSET",
      current_balance: parseFloat(row.current_balance ?? row.current ?? "0"),
      prior_balance: parseFloat(row.prior_balance ?? row.prior ?? "0"),
    }));

    self.postMessage({ type: "PARSED", rows });
  } catch (err) {
    self.postMessage({ type: "ERROR", error: String(err) });
  }
};

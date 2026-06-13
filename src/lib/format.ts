// Currency and number formatting utilities

export function formatCurrency(
  value: number,
  currency = "USD",
  decimals = 2
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatNumber(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

// Accounting convention: negatives shown in parentheses
export function formatAccounting(value: number, currency = "USD"): string {
  const abs = Math.abs(value);
  const formatted = formatCurrency(abs, currency);
  return value < 0 ? `(${formatted})` : formatted;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

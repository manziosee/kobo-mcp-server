function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "";

  const cols = columns ?? Array.from(rows.reduce((set, row) => {
    for (const key of Object.keys(row)) set.add(key);
    return set;
  }, new Set<string>()));

  const lines = [cols.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(cols.map((col) => escapeCell(row[col])).join(","));
  }
  return lines.join("\n");
}

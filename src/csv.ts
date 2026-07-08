// Leading =, +, -, @ (and tab/CR) make spreadsheet apps (Excel, Sheets) interpret a cell as a
// formula when the CSV is opened - a classic CSV injection vector for free-text survey answers.
// Only applied to genuine string values, not JSON.stringify'd numbers, so legitimate negative
// numeric fields (e.g. southern-hemisphere longitudes) aren't corrupted.
const RISKY_LEADING_CHAR = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const isString = typeof value === "string";
  let str = isString ? value : JSON.stringify(value);
  if (isString && RISKY_LEADING_CHAR.test(str)) {
    str = `'${str}`;
  }
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

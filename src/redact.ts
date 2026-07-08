const REDACTED_VALUE = "[REDACTED]";

export function buildRedactSet(fieldNames: string[] | undefined): Set<string> {
  return new Set((fieldNames ?? []).map((f) => f.trim()).filter(Boolean));
}

function leafKey(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? key : key.slice(idx + 1);
}

function shouldRedact(key: string, redactKeys: Set<string>): boolean {
  return redactKeys.has(key) || redactKeys.has(leafKey(key));
}

function redactValue(value: unknown, redactKeys: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactKeys));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shouldRedact(key, redactKeys) ? REDACTED_VALUE : redactValue(val, redactKeys);
    }
    return out;
  }
  return value;
}

/**
 * Replaces the value of any matching key with "[REDACTED]", recursively (covers
 * repeat-group instances). Matches by exact key (works for both bare field names and
 * full "group/field" paths) and by leaf name (so "phone" also catches "household/phone").
 * No-op if redactKeys is empty.
 */
export function redactRecord(record: Record<string, unknown>, redactKeys: Set<string>): Record<string, unknown> {
  if (redactKeys.size === 0) return record;
  return redactValue(record, redactKeys) as Record<string, unknown>;
}

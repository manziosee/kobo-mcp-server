import type { FormQuestion } from "./survey-schema.js";

export interface RawChoiceItem {
  list_name?: string;
  name?: string;
  label?: string[] | string;
}

export type ChoiceIndex = Map<string, Map<string, string[] | string>>;

export function buildChoiceIndex(choices: RawChoiceItem[]): ChoiceIndex {
  const index: ChoiceIndex = new Map();
  for (const choice of choices) {
    if (!choice.list_name || !choice.name) continue;
    let inner = index.get(choice.list_name);
    if (!inner) {
      inner = new Map();
      index.set(choice.list_name, inner);
    }
    inner.set(choice.name, choice.label ?? choice.name);
  }
  return index;
}

/** Resolves a language name (e.g. "French") to its index in the form's translations array, defaulting to 0 (the form's first/default language). */
export function resolveLanguageIndex(translations: (string | null)[], language?: string): number {
  if (!language) return 0;
  const idx = translations.findIndex((t) => t?.toLowerCase() === language.toLowerCase());
  return idx === -1 ? 0 : idx;
}

function labelFor(index: ChoiceIndex, listName: string, code: string, languageIndex: number): string {
  const raw = index.get(listName)?.get(code);
  if (raw === undefined) return code;
  if (Array.isArray(raw)) return raw[languageIndex] ?? raw[0] ?? code;
  return raw;
}

/** Resolves a single select_one/select_multiple option code to its label. Unknown codes are returned as-is. */
export function resolveChoiceLabel(index: ChoiceIndex, listName: string, code: string, languageIndex: number): string {
  return labelFor(index, listName, code, languageIndex);
}

/**
 * Replaces select_one/select_multiple submission values with their human-readable choice
 * labels (from the form's content.choices), including inside repeat-group instances.
 * Unknown codes (e.g. a choice removed from the form after this submission) are left as-is.
 * select_multiple values (space-separated codes) are resolved and joined with "; ".
 * Non-select fields, and select questions with no matching choice list, are untouched.
 */
export function resolveRecordLabels(
  record: Record<string, unknown>,
  questions: FormQuestion[],
  index: ChoiceIndex,
  languageIndex: number,
): Record<string, unknown> {
  const selectQuestions = questions.filter(
    (q) => q.selectFromListName && (q.type === "select_one" || q.type === "select_multiple"),
  );
  if (selectQuestions.length === 0) return record;

  const resolveValue = (q: FormQuestion, raw: unknown): unknown => {
    if (typeof raw !== "string" || raw === "") return raw;
    const list = q.selectFromListName as string;
    if (q.type === "select_one") {
      return labelFor(index, list, raw, languageIndex);
    }
    return raw
      .split(/\s+/)
      .map((code) => labelFor(index, list, code, languageIndex))
      .join("; ");
  };

  const out: Record<string, unknown> = { ...record };
  const topLevel = selectQuestions.filter((q) => q.repeatPath === null);
  const nested = selectQuestions.filter((q) => q.repeatPath !== null);

  for (const q of topLevel) {
    if (q.path in out) {
      out[q.path] = resolveValue(q, out[q.path]);
    }
  }

  const repeatPaths = Array.from(new Set(nested.map((q) => q.repeatPath as string)));
  for (const repeatPath of repeatPaths) {
    const instances = out[repeatPath];
    if (!Array.isArray(instances)) continue;
    const questionsInThisRepeat = nested.filter((q) => q.repeatPath === repeatPath);

    out[repeatPath] = instances.map((instance) => {
      if (typeof instance !== "object" || instance === null) return instance;
      const rec = { ...(instance as Record<string, unknown>) };
      for (const q of questionsInThisRepeat) {
        const key = q.path in rec ? q.path : q.name;
        if (key in rec) {
          rec[key] = resolveValue(q, rec[key]);
        }
      }
      return rec;
    });
  }

  return out;
}

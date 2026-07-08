export interface RawSurveyItem {
  type: string;
  name?: string;
  $autoname?: string;
  label?: string[] | string;
  required?: boolean;
  select_from_list_name?: string;
}

export interface FormQuestion {
  /** Leaf question name, e.g. "phone_number". */
  name: string;
  /** Full slash-joined path from root, e.g. "household/phone_number". Matches submission JSON field keys. */
  path: string;
  type: string;
  label: string | null;
  required: boolean;
  /** Path of the nearest enclosing repeat group, or null if this question isn't inside a repeat. */
  repeatPath: string | null;
  /** For select_one/select_multiple questions, the content.choices list_name to resolve values against; otherwise null. */
  selectFromListName: string | null;
}

const GROUP_BEGIN = new Set(["begin_group", "begin group"]);
const GROUP_END = new Set(["end_group", "end group"]);
const REPEAT_BEGIN = new Set(["begin_repeat", "begin repeat"]);
const REPEAT_END = new Set(["end_repeat", "end repeat"]);
const SKIP_TYPES = new Set(["start", "end", "note", "calculate", "deviceid", "audit", "today", "username", "simserial"]);

function normalizeLabel(label?: string[] | string): string | null {
  if (Array.isArray(label)) return label[0] ?? null;
  return label ?? null;
}

/**
 * Walks a form's flat content.survey array (as returned by the Kobo API) and
 * resolves each question's full path and nearest enclosing repeat group, so
 * callers can match questions against submission JSON keys (which use "/" for
 * group nesting and arrays for repeats).
 */
export function buildQuestionPaths(survey: RawSurveyItem[]): FormQuestion[] {
  const questions: FormQuestion[] = [];
  const stack: Array<{ name: string; isRepeat: boolean }> = [];

  for (const item of survey) {
    const type = item.type;

    if (GROUP_BEGIN.has(type) || REPEAT_BEGIN.has(type)) {
      stack.push({ name: item.name ?? item.$autoname ?? "(group)", isRepeat: REPEAT_BEGIN.has(type) });
      continue;
    }
    if (GROUP_END.has(type) || REPEAT_END.has(type)) {
      stack.pop();
      continue;
    }
    if (SKIP_TYPES.has(type)) continue;

    const name = item.name ?? item.$autoname ?? "(unnamed)";
    const path = [...stack.map((s) => s.name), name].join("/");

    let repeatPath: string | null = null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].isRepeat) {
        repeatPath = stack
          .slice(0, i + 1)
          .map((s) => s.name)
          .join("/");
        break;
      }
    }

    questions.push({
      name,
      path,
      type,
      label: normalizeLabel(item.label),
      required: item.required === true,
      repeatPath,
      selectFromListName: item.select_from_list_name ?? null,
    });
  }

  return questions;
}

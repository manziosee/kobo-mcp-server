import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildChoiceIndex, resolveLanguageIndex, resolveRecordLabels } from "./choices.js";
import type { FormQuestion } from "./survey-schema.js";

function question(overrides: Partial<FormQuestion>): FormQuestion {
  return {
    name: "q",
    path: "q",
    type: "select_one",
    label: null,
    required: false,
    repeatPath: null,
    selectFromListName: null,
    ...overrides,
  };
}

describe("buildChoiceIndex", () => {
  test("groups choices by list_name then choice name", () => {
    const index = buildChoiceIndex([
      { list_name: "yes_no", name: "yes", label: ["Yes"] },
      { list_name: "yes_no", name: "no", label: ["No"] },
    ]);

    assert.deepEqual(index.get("yes_no")?.get("yes"), ["Yes"]);
    assert.deepEqual(index.get("yes_no")?.get("no"), ["No"]);
  });

  test("skips choices missing list_name or name", () => {
    const index = buildChoiceIndex([{ list_name: "yes_no" }, { name: "yes" }, {}]);
    assert.equal(index.size, 0);
  });
});

describe("resolveLanguageIndex", () => {
  test("defaults to 0 when no language is requested", () => {
    assert.equal(resolveLanguageIndex(["English", "French"]), 0);
  });

  test("finds a case-insensitive match", () => {
    assert.equal(resolveLanguageIndex(["English", "French"], "french"), 1);
  });

  test("falls back to 0 for an unknown language", () => {
    assert.equal(resolveLanguageIndex(["English", "French"], "Kinyarwanda"), 0);
  });
});

describe("resolveRecordLabels", () => {
  const index = buildChoiceIndex([
    { list_name: "yes_no", name: "yes", label: ["Yes", "Oui"] },
    { list_name: "yes_no", name: "no", label: ["No", "Non"] },
    { list_name: "services", name: "water", label: ["Water", "Eau"] },
    { list_name: "services", name: "power", label: ["Power", "Électricité"] },
  ]);

  test("resolves a top-level select_one field", () => {
    const questions = [question({ name: "has_water", path: "has_water", selectFromListName: "yes_no" })];
    const record = resolveRecordLabels({ has_water: "yes" }, questions, index, 0);
    assert.equal(record.has_water, "Yes");
  });

  test("resolves in a non-default language", () => {
    const questions = [question({ name: "has_water", path: "has_water", selectFromListName: "yes_no" })];
    const record = resolveRecordLabels({ has_water: "yes" }, questions, index, 1);
    assert.equal(record.has_water, "Oui");
  });

  test("resolves a select_multiple field, joining labels with '; '", () => {
    const questions = [
      question({ name: "services", path: "services", type: "select_multiple", selectFromListName: "services" }),
    ];
    const record = resolveRecordLabels({ services: "water power" }, questions, index, 0);
    assert.equal(record.services, "Water; Power");
  });

  test("leaves an unknown code as-is", () => {
    const questions = [question({ name: "has_water", path: "has_water", selectFromListName: "yes_no" })];
    const record = resolveRecordLabels({ has_water: "maybe" }, questions, index, 0);
    assert.equal(record.has_water, "maybe");
  });

  test("leaves blank/missing values untouched", () => {
    const questions = [question({ name: "has_water", path: "has_water", selectFromListName: "yes_no" })];
    assert.equal(resolveRecordLabels({ has_water: "" }, questions, index, 0).has_water, "");
    assert.equal(resolveRecordLabels({}, questions, index, 0).has_water, undefined);
  });

  test("is a no-op when there are no select questions", () => {
    const record = { name: "Jane" };
    const questions = [question({ name: "name", path: "name", type: "text", selectFromListName: null })];
    assert.deepEqual(resolveRecordLabels(record, questions, index, 0), record);
  });

  test("resolves select questions nested inside repeat-group instances", () => {
    const questions = [
      question({
        name: "has_water",
        path: "members/has_water",
        selectFromListName: "yes_no",
        repeatPath: "members",
      }),
    ];
    const record = resolveRecordLabels(
      { members: [{ has_water: "yes" }, { has_water: "no" }] },
      questions,
      index,
      0,
    );
    const members = record.members as Array<Record<string, unknown>>;
    assert.equal(members[0].has_water, "Yes");
    assert.equal(members[1].has_water, "No");
  });

  test("does not mutate the original record", () => {
    const questions = [question({ name: "has_water", path: "has_water", selectFromListName: "yes_no" })];
    const original = { has_water: "yes" };
    resolveRecordLabels(original, questions, index, 0);
    assert.equal(original.has_water, "yes");
  });
});

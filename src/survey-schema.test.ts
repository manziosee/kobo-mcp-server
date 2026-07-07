import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildQuestionPaths } from "./survey-schema.js";

describe("buildQuestionPaths", () => {
  test("flat form: paths equal question names, no repeatPath", () => {
    const questions = buildQuestionPaths([
      { type: "text", name: "name", label: ["Full name"], required: true },
      { type: "integer", name: "age", label: ["Age"] },
    ]);

    assert.equal(questions.length, 2);
    assert.deepEqual(questions[0], {
      name: "name",
      path: "name",
      type: "text",
      label: "Full name",
      required: true,
      repeatPath: null,
    });
    assert.equal(questions[1].required, false);
    assert.equal(questions[1].repeatPath, null);
  });

  test("nested group: path is slash-joined, repeatPath is null", () => {
    const questions = buildQuestionPaths([
      { type: "begin_group", name: "household" },
      { type: "text", name: "phone", required: true },
      { type: "end_group" },
    ]);

    assert.equal(questions.length, 1);
    assert.equal(questions[0].path, "household/phone");
    assert.equal(questions[0].repeatPath, null);
  });

  test("repeat group: sets repeatPath to the repeat's own path", () => {
    const questions = buildQuestionPaths([
      { type: "begin_repeat", name: "members" },
      { type: "text", name: "member_name", required: true },
      { type: "end_repeat" },
    ]);

    assert.equal(questions[0].path, "members/member_name");
    assert.equal(questions[0].repeatPath, "members");
  });

  test("nested group inside a repeat: repeatPath is the nearest enclosing repeat only", () => {
    const questions = buildQuestionPaths([
      { type: "begin_repeat", name: "members" },
      { type: "begin_group", name: "contact" },
      { type: "text", name: "phone", required: true },
      { type: "end_group" },
      { type: "end_repeat" },
    ]);

    assert.equal(questions[0].path, "members/contact/phone");
    assert.equal(questions[0].repeatPath, "members");
  });

  test("skips notes, calculates, start/end metadata fields", () => {
    const questions = buildQuestionPaths([
      { type: "start" },
      { type: "note", name: "intro_note" },
      { type: "calculate", name: "computed" },
      { type: "text", name: "real_question" },
      { type: "end" },
    ]);

    assert.equal(questions.length, 1);
    assert.equal(questions[0].name, "real_question");
  });

  test("falls back to $autoname when name is missing", () => {
    const questions = buildQuestionPaths([{ type: "text", $autoname: "auto_1" }]);
    assert.equal(questions[0].name, "auto_1");
  });
});

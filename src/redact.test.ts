import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRedactSet, redactRecord } from "./redact.js";

describe("buildRedactSet", () => {
  test("trims whitespace and drops empty entries", () => {
    const set = buildRedactSet([" phone ", "", "  ", "name"]);
    assert.deepEqual(Array.from(set).sort(), ["name", "phone"]);
  });

  test("returns an empty set for undefined", () => {
    assert.equal(buildRedactSet(undefined).size, 0);
  });
});

describe("redactRecord", () => {
  test("is a no-op when the redact set is empty", () => {
    const record = { phone: "555-0123" };
    assert.deepEqual(redactRecord(record, new Set()), record);
  });

  test("redacts an exact top-level key match", () => {
    const record = redactRecord({ phone: "555-0123", name: "Jane" }, new Set(["phone"]));
    assert.equal(record.phone, "[REDACTED]");
    assert.equal(record.name, "Jane");
  });

  test("redacts a full group-path key by its leaf name", () => {
    const record = redactRecord({ "household/phone": "555-0123" }, new Set(["phone"]));
    assert.equal(record["household/phone"], "[REDACTED]");
  });

  test("redacts a bare key when the redact set specifies the full path", () => {
    const record = redactRecord({ "household/phone": "555-0123" }, new Set(["household/phone"]));
    assert.equal(record["household/phone"], "[REDACTED]");
  });

  test("redacts inside repeat-group arrays recursively", () => {
    const record = redactRecord(
      { members: [{ member_name: "Jane" }, { member_name: "Amy" }] },
      new Set(["member_name"]),
    );
    const members = record.members as Array<Record<string, unknown>>;
    assert.equal(members[0].member_name, "[REDACTED]");
    assert.equal(members[1].member_name, "[REDACTED]");
  });

  test("leaves non-matching fields untouched", () => {
    const record = redactRecord({ age: 30, notes: "fine" }, new Set(["phone"]));
    assert.deepEqual(record, { age: 30, notes: "fine" });
  });
});

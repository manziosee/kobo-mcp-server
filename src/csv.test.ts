import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rowsToCsv } from "./csv.js";

describe("rowsToCsv", () => {
  test("returns empty string for no rows", () => {
    assert.equal(rowsToCsv([]), "");
  });

  test("infers columns from union of row keys", () => {
    const csv = rowsToCsv([{ a: 1, b: 2 }, { a: 3, c: 4 }]);
    const lines = csv.split("\n");
    assert.equal(lines[0], "a,b,c");
    assert.equal(lines[1], "1,2,");
    assert.equal(lines[2], "3,,4");
  });

  test("uses explicit column order when provided", () => {
    const csv = rowsToCsv([{ a: 1, b: 2 }], ["b", "a"]);
    assert.equal(csv, "b,a\n2,1");
  });

  test("escapes commas, quotes, and newlines", () => {
    const csv = rowsToCsv([{ note: 'has "quotes", a comma, and\na newline' }], ["note"]);
    assert.equal(csv, 'note\n"has ""quotes"", a comma, and\na newline"');
  });

  test("renders null/undefined as empty cell", () => {
    const csv = rowsToCsv([{ a: null, b: undefined }], ["a", "b"]);
    assert.equal(csv, "a,b\n,");
  });
});

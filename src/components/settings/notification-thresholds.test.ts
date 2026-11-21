import assert from "node:assert/strict";
import test from "node:test";

import { parseDays } from "./notification-thresholds.ts";

test("parseDays rejects blank text instead of reading it as 0", () => {
  assert.equal(parseDays(""), null);
  assert.equal(parseDays("  "), null);
});

test("parseDays accepts whole numbers of days from 0 to 60", () => {
  assert.equal(parseDays("0"), 0);
  assert.equal(parseDays("60"), 60);
  assert.equal(parseDays("61"), null);
  assert.equal(parseDays("1.5"), null);
  assert.equal(parseDays("abc"), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { intervalAdd } from "./functions.ts";

test("an interval in months is refused, not turned into 30 days", () => {
  assert.throws(
    () => intervalAdd("2026-01-31T00:00:00.000Z", "1 month", 1),
    /Unsupported interval unit/,
  );
  assert.equal(
    intervalAdd("2026-01-31T00:00:00.000Z", "2 days", 1),
    "2026-02-02T00:00:00.000Z",
  );
});

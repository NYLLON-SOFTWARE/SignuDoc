import assert from "node:assert/strict";
import test from "node:test";

import { preferenceCheckboxLabel } from "./preference-label.ts";

const row = { kind: "envelope_completed", label: "Envelope completed" };

test("the checkbox is named by the row's visible label, never its id", () => {
  const name = preferenceCheckboxLabel(row);

  assert.ok(!name.includes("envelope_completed"), name);
  assert.equal(name, "Envelope completed, for my envelopes");
});

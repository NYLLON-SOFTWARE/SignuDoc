import assert from "node:assert/strict";
import test from "node:test";

import { formatLocalTime } from "./local-time.ts";

const unix = (iso: string) => Date.parse(iso) / 1000;

test("a moment is written in the reader's time zone, which is named", () => {
  const sentAt = unix("2026-11-18T23:00:23Z");

  assert.equal(
    formatLocalTime(sentAt, "shortDateTime", "America/Detroit"),
    "Nov 18, 6:00 PM EST",
  );
  assert.equal(
    formatLocalTime(sentAt, "shortDateTime", "Europe/Belgrade"),
    "Nov 19, 12:00 AM GMT+1",
  );
  assert.equal(
    formatLocalTime(sentAt, "shortDateTime", "UTC"),
    "Nov 18, 11:00 PM UTC",
  );
});

test("a date is the reader's calendar day, not the day in UTC", () => {
  // Already the 19th in UTC, still the evening of the 18th in Detroit.
  const timestamp = unix("2026-12-19T02:00:00Z");

  assert.equal(
    formatLocalTime(timestamp, "date", "America/Detroit"),
    "December 18, 2026",
  );
  assert.equal(
    formatLocalTime(timestamp, "shortDate", "America/Detroit"),
    "Dec 18, 2026",
  );
  assert.equal(
    formatLocalTime(timestamp, "dateTime", "America/Detroit"),
    "December 18, 2026 at 9:00 PM EST",
  );
  assert.equal(formatLocalTime(timestamp, "date", "UTC"), "December 19, 2026");
  assert.equal(
    formatLocalTime(timestamp, "dateTime", "UTC"),
    "December 19, 2026 at 2:00 AM UTC",
  );
});

test("the hour that happens twice when clocks go back is told apart", () => {
  assert.equal(
    formatLocalTime(
      unix("2026-11-01T05:30:00Z"),
      "shortDateTime",
      "America/Detroit",
    ),
    "Nov 1, 1:30 AM EDT",
  );
  assert.equal(
    formatLocalTime(
      unix("2026-11-01T06:30:00Z"),
      "shortDateTime",
      "America/Detroit",
    ),
    "Nov 1, 1:30 AM EST",
  );
});

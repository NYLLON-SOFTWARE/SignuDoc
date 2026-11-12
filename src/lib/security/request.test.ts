import assert from "node:assert/strict";
import { test } from "node:test";

import { getClientIpAddress, getClientIpHeaderNames } from "./request.ts";

const onVercel = { VERCEL: "1" };
const elsewhere = {};

test("on Vercel, the address Vercel wrote wins over one the visitor could have sent", () => {
  const headers = new Headers({
    "cf-connecting-ip": "198.51.100.9",
    "x-forwarded-for": "198.51.100.7",
    "x-real-ip": "203.0.113.5",
    "x-vercel-forwarded-for": "203.0.113.5",
  });

  assert.equal(getClientIpAddress(headers, onVercel), "203.0.113.5");
  assert.equal(
    getClientIpAddress(
      new Headers({
        "x-forwarded-for": "198.51.100.7",
        "x-real-ip": "203.0.113.5",
      }),
      onVercel,
    ),
    "203.0.113.5",
  );
});

test("off Vercel, Vercel's header means nothing and the proxy headers are used", () => {
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.7, 10.0.0.1",
    "x-vercel-forwarded-for": "203.0.113.5",
  });

  assert.equal(getClientIpAddress(headers, elsewhere), "198.51.100.7");
  assert.equal(
    getClientIpAddress(
      new Headers({ "cf-connecting-ip": "198.51.100.9" }),
      elsewhere,
    ),
    "198.51.100.9",
  );
  assert.equal(
    getClientIpHeaderNames(elsewhere).includes("x-vercel-forwarded-for"),
    false,
  );
});

test("an empty header is passed over, and no header at all gives no address", () => {
  assert.equal(
    getClientIpAddress(
      new Headers({ "x-forwarded-for": " ", "x-real-ip": "203.0.113.5" }),
      elsewhere,
    ),
    "203.0.113.5",
  );
  assert.equal(getClientIpAddress(new Headers(), onVercel), null);
});

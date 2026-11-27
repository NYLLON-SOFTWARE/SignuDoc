import assert from "node:assert/strict";
import { test } from "node:test";

import { auditEventRecordSchema } from "../schemas/envelope.ts";
import {
  getClientIpAddress,
  getClientIpHeaderNames,
  getRequestUserAgent,
  readClientIpSettings,
} from "./request.ts";

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

test("off Vercel, addresses a visitor puts at the start of X-Forwarded-For do not count", () => {
  const read = (value: string) =>
    getClientIpAddress(new Headers({ "x-forwarded-for": value }), elsewhere);

  // A reverse proxy adds the address it saw at the end.
  assert.equal(read("1.2.3.4, 198.51.100.7"), "198.51.100.7");
  // The install's own proxies on a private network are passed over.
  assert.equal(read("1.2.3.4, 198.51.100.7, 10.0.0.1"), "198.51.100.7");
  assert.equal(read("198.51.100.7, 172.16.0.2, fd00::1"), "198.51.100.7");
  // Nothing but private addresses: the first, as before.
  assert.equal(read("192.168.1.20, 10.0.0.1"), "192.168.1.20");
  // On Vercel, Vercel's own header decides, and the list is not read.
  assert.equal(
    getClientIpAddress(
      new Headers({
        "x-forwarded-for": "1.2.3.4, 198.51.100.7",
        "x-vercel-forwarded-for": "203.0.113.5",
      }),
      onVercel,
    ),
    "203.0.113.5",
  );
});

test("with CLIENT_IP_HEADER set, only that header counts", () => {
  const env = { CLIENT_IP_HEADER: "X-Real-IP" };
  const forged = {
    "cf-connecting-ip": "198.51.100.9",
    "x-forwarded-for": "198.51.100.7",
  };

  assert.deepEqual(getClientIpHeaderNames(env), ["x-real-ip"]);
  assert.equal(
    getClientIpAddress(
      new Headers({ ...forged, "x-real-ip": "203.0.113.5" }),
      env,
    ),
    "203.0.113.5",
  );
  // The other headers are never a fallback: no address rather than a
  // forged one.
  assert.equal(getClientIpAddress(new Headers(forged), env), null);
  // A single-value header must hold one address.
  assert.equal(
    getClientIpAddress(new Headers({ "x-real-ip": "not-an-ip" }), env),
    null,
  );
  assert.equal(
    getClientIpAddress(
      new Headers({ "x-real-ip": "1.2.3.4, 203.0.113.5" }),
      env,
    ),
    null,
  );
});

test("X-Forwarded-For is walked from its end past the trusted proxies", () => {
  const env = {
    CLIENT_IP_HEADER: "x-forwarded-for",
    TRUSTED_PROXIES: "10.0.0.1, 172.16.0.0/12",
  };
  const read = (value: string) =>
    getClientIpAddress(new Headers({ "x-forwarded-for": value }), env);

  assert.equal(read("1.2.3.4, 198.51.100.7, 10.0.0.1"), "198.51.100.7");
  assert.equal(read("198.51.100.7, 172.16.0.2, 10.0.0.1"), "198.51.100.7");
  // A visitor on the install's own network is named, not the address it
  // put in front, which guessing by private ranges would have picked.
  assert.equal(read("1.2.3.4, 10.0.0.5, 10.0.0.1"), "10.0.0.5");
  // IPv6 addresses are kept whole, as the audit trail needs them.
  assert.equal(
    read("2001:db8:1:2:3:4:5:6, 10.0.0.1"),
    "2001:0db8:0001:0002:0003:0004:0005:0006",
  );
  // Without trusted proxies, a list is not trusted at all.
  assert.equal(
    getClientIpAddress(
      new Headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" }),
      { CLIENT_IP_HEADER: "x-forwarded-for" },
    ),
    null,
  );
});

test("client address settings that cannot be right stop the app", () => {
  assert.throws(
    () => readClientIpSettings({ CLIENT_IP_HEADER: "x real ip" }),
    /must be a header name/,
  );
  assert.throws(
    () =>
      readClientIpSettings({
        CLIENT_IP_HEADER: "x-forwarded-for",
        TRUSTED_PROXIES: "10.0.0.0/8, proxy.internal",
      }),
    /proxy\.internal/,
  );
  assert.throws(
    () => readClientIpSettings({ TRUSTED_PROXIES: "10.0.0.1" }),
    /CLIENT_IP_HEADER is not/,
  );
  assert.equal(readClientIpSettings({}), null);
});

test("on Vercel, CLIENT_IP_HEADER is ignored for Vercel's own header", () => {
  const env = { CLIENT_IP_HEADER: "cf-connecting-ip", VERCEL: "1" };

  assert.equal(readClientIpSettings(env), null);
  assert.equal(
    getClientIpAddress(
      new Headers({
        "cf-connecting-ip": "198.51.100.9",
        "x-vercel-forwarded-for": "203.0.113.5",
      }),
      env,
    ),
    "203.0.113.5",
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

test("a user agent header with no value counts as no user agent", () => {
  assert.equal(getRequestUserAgent(new Headers()), null);
  assert.equal(getRequestUserAgent(new Headers({ "user-agent": "" })), null);
  assert.equal(getRequestUserAgent(new Headers({ "user-agent": "  " })), null);
  assert.equal(
    getRequestUserAgent(new Headers({ "user-agent": " curl/8.5.0 " })),
    "curl/8.5.0",
  );
});

test("the audit schema accepts what an empty user agent header gives", () => {
  const userAgent = getRequestUserAgent(new Headers({ "user-agent": "" }));

  assert.ok(
    auditEventRecordSchema.shape.userAgent.safeParse(userAgent).success,
  );
});

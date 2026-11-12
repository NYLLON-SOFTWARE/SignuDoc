import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addEmailDomain,
  emailNeedsAttention,
  getEmailStatus,
  recheckEmailDomain,
  type ResendDomainsClient,
} from "./email-status.ts";
import { resolveSettings, type AppSettings } from "./settings.ts";

const stored: AppSettings = {
  allowedEmailDomains: ["acme.com"],
  emailReadyAt: null,
  organizationName: "Acme Corp",
  privacyUrl: null,
  senderAddress: "sign@acme.com",
  setupCompletedAt: 1_800_000_000,
  signupMode: "domains",
  supportAddress: null,
  termsUrl: null,
};

const env = { RESEND_API_KEY: "re_test_key" };
const settings = resolveSettings(stored, env);

const DKIM_RECORD = {
  name: "resend._domainkey",
  record: "DKIM",
  status: "pending",
  ttl: "Auto",
  type: "TXT",
  value: "p=MIGfMA0GCSqGSIb3DQEB",
};
const SPF_MX_RECORD = {
  name: "send",
  priority: 10,
  record: "SPF",
  status: "pending",
  ttl: "Auto",
  type: "MX",
  value: "feedback-smtp.us-east-1.amazonses.com",
};
// Resend lists records for features this app does not use without a name
// or a value.
const TRACKING_RECORD = { record: "Tracking", status: "not_started" };

type FakeError = { message: string; name: string; statusCode: number };
type FakeDomain = {
  id: string;
  name: string;
  records: unknown[];
  status: string;
};

/** Stands in for Resend's domains API and remembers what was asked of it. */
function fakeResend(
  initial: {
    domains?: FakeDomain[];
    errors?: Record<string, FakeError[]>;
  } = {},
) {
  const domains = [...(initial.domains ?? [])];
  const errors = initial.errors ?? {};
  const calls: string[] = [];
  const readyMarks: boolean[] = [];

  function respond<T>(method: string, data: () => T) {
    const error = errors[method]?.shift();

    return Promise.resolve(
      error ? { data: null, error } : { data: data(), error: null },
    );
  }

  const client = {
    create({ name }: { name: string }) {
      calls.push(`create ${name}`);

      return respond("create", () => {
        const created = {
          id: `domain_${String(domains.length + 1)}`,
          name,
          records: [DKIM_RECORD, SPF_MX_RECORD, TRACKING_RECORD],
          status: "not_started",
        };

        domains.push(created);

        return created;
      });
    },
    get(id: string) {
      calls.push(`get ${id}`);

      return respond("get", () => domains.find((domain) => domain.id === id));
    },
    list() {
      calls.push("list");

      return respond("list", () => ({
        data: domains.map(({ id, name, status }) => ({ id, name, status })),
      }));
    },
    verify(id: string) {
      calls.push(`verify ${id}`);

      return respond("verify", () => ({ id }));
    },
  };

  return {
    calls,
    domains,
    options: {
      domainsClient: client as unknown as ResendDomainsClient,
      env,
      recordReady: async (ready: boolean) => {
        readyMarks.push(ready);
      },
      settings,
    },
    readyMarks,
  };
}

test("the capture driver is reported as such without asking anyone", async () => {
  assert.deepEqual(await getEmailStatus({ env: { EMAIL_DRIVER: "capture" } }), {
    state: "capture",
  });
});

test("no Resend key means email is not connected", async () => {
  assert.deepEqual(await getEmailStatus({ env: {}, settings }), {
    state: "missing_key",
  });
});

test("Resend's test address is reported without asking Resend about domains", async () => {
  const resend = fakeResend();
  const status = await getEmailStatus({
    ...resend.options,
    settings: resolveSettings({ ...stored, senderAddress: null }, env),
  });

  assert.deepEqual(status, {
    senderAddress: "onboarding@resend.dev",
    state: "test_sender",
  });
  assert.deepEqual(resend.calls, []);
  assert.deepEqual(resend.readyMarks, [false]);
});

test("a sender address in the environment is the one that is checked", async () => {
  const resend = fakeResend();
  const status = await getEmailStatus({
    ...resend.options,
    settings: resolveSettings(stored, {
      ...env,
      RESEND_FROM_EMAIL: "Acme <Sign@Mail.Acme.com>",
    }),
  });

  assert.deepEqual(status, {
    domain: "mail.acme.com",
    senderAddress: "sign@mail.acme.com",
    state: "domain_missing",
  });
});

test("a domain Resend has not heard of needs setting up", async () => {
  const resend = fakeResend();

  assert.deepEqual(await getEmailStatus(resend.options), {
    domain: "acme.com",
    senderAddress: "sign@acme.com",
    state: "domain_missing",
  });
  assert.deepEqual(resend.calls, ["list"]);
  assert.deepEqual(resend.readyMarks, [false]);
});

test("setting the domain up adds it to Resend and returns the DNS records to add", async () => {
  const resend = fakeResend();
  const status = await addEmailDomain(resend.options);

  assert.deepEqual(status, {
    domain: "acme.com",
    records: [
      {
        name: "resend._domainkey",
        priority: null,
        purpose: "DKIM",
        status: "pending",
        type: "TXT",
        value: "p=MIGfMA0GCSqGSIb3DQEB",
      },
      {
        name: "send",
        priority: 10,
        purpose: "SPF",
        status: "pending",
        type: "MX",
        value: "feedback-smtp.us-east-1.amazonses.com",
      },
    ],
    senderAddress: "sign@acme.com",
    state: "domain_pending",
  });
  assert.deepEqual(resend.calls, ["list", "create acme.com"]);
});

test("setting up a domain that is already there shows its records instead of adding it twice", async () => {
  const resend = fakeResend({
    domains: [
      {
        id: "domain_1",
        name: "Acme.com",
        records: [DKIM_RECORD],
        status: "pending",
      },
    ],
  });
  const status = await addEmailDomain(resend.options);

  assert.equal(status.state, "domain_pending");
  assert.deepEqual(resend.calls, ["list", "get domain_1"]);
});

test("a domain whose records are not verified yet is pending, with its records", async () => {
  const resend = fakeResend({
    domains: [
      {
        id: "domain_1",
        name: "acme.com",
        records: [DKIM_RECORD],
        status: "pending",
      },
    ],
  });
  const status = await getEmailStatus(resend.options);

  assert.equal(status.state, "domain_pending");
  assert.equal(
    status.state === "domain_pending" ? status.records.length : 0,
    1,
  );
  assert.deepEqual(resend.calls, ["list", "get domain_1"]);
  assert.deepEqual(resend.readyMarks, [false]);
});

test("a verified domain means email is working, and that is recorded", async () => {
  const resend = fakeResend({
    domains: [
      { id: "domain_1", name: "acme.com", records: [], status: "verified" },
    ],
  });

  assert.deepEqual(await getEmailStatus(resend.options), {
    domain: "acme.com",
    senderAddress: "sign@acme.com",
    state: "ready",
  });
  assert.deepEqual(resend.calls, ["list"]);
  assert.deepEqual(resend.readyMarks, [true]);
});

test("checking again asks Resend to verify, then reads the result", async () => {
  const resend = fakeResend({
    domains: [
      {
        id: "domain_1",
        name: "acme.com",
        records: [DKIM_RECORD],
        status: "pending",
      },
    ],
  });

  // The DNS records were found between the two requests.
  const pending = await recheckEmailDomain(resend.options);

  assert.equal(pending.state, "domain_pending");
  assert.deepEqual(resend.calls, ["list", "verify domain_1", "get domain_1"]);

  resend.domains[0]!.status = "verified";

  assert.equal((await recheckEmailDomain(resend.options)).state, "ready");
});

test("a key that may only send points the administrator at Resend instead", async () => {
  const resend = fakeResend({
    errors: {
      list: [
        {
          message: "This API key is restricted to only send emails",
          name: "restricted_api_key",
          statusCode: 401,
        },
      ],
    },
  });

  assert.deepEqual(await getEmailStatus(resend.options), {
    domain: "acme.com",
    senderAddress: "sign@acme.com",
    state: "restricted_key",
  });
  // Nothing was learned about the domain, so the mark is left alone.
  assert.deepEqual(resend.readyMarks, []);
});

test("any other failure is reported in Resend's own words", async () => {
  const resend = fakeResend({
    errors: {
      list: [
        {
          message: "Something went wrong on our side",
          name: "internal_server_error",
          statusCode: 500,
        },
      ],
    },
  });

  assert.deepEqual(await getEmailStatus(resend.options), {
    message: "Something went wrong on our side",
    senderAddress: "sign@acme.com",
    state: "error",
  });
});

test("a request turned away for going too fast is tried once more", async () => {
  const resend = fakeResend({
    errors: {
      list: [
        {
          message: "Too many requests",
          name: "rate_limit_exceeded",
          statusCode: 429,
        },
      ],
    },
  });

  assert.equal((await getEmailStatus(resend.options)).state, "domain_missing");
  assert.deepEqual(resend.calls, ["list", "list"]);
});

test("the administrator is told about email until it has been seen working", () => {
  assert.equal(emailNeedsAttention(settings, env), true);
  assert.equal(
    emailNeedsAttention(
      resolveSettings({ ...stored, emailReadyAt: 1_800_000_100 }, env),
      env,
    ),
    false,
  );
  // Nothing to set up when messages are only being captured.
  assert.equal(
    emailNeedsAttention(settings, { EMAIL_DRIVER: "capture" }),
    false,
  );
});

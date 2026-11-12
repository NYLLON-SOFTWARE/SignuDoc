import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  createRecipientDownloadLink,
  DownloadAccessError,
  renewRecipientDownloadLinks,
} from "./downloads.ts";
import { hashOpaqueToken } from "./services/opaque-tokens.ts";

// Renewing a signer's download links, against a real Postgres: the point is
// what two requests at once, a failed write and a failed email leave in the
// table. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

/** A finished envelope whose one signer holds a link to each file. */
async function createFinishedEnvelope() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, completed_at
      ) values ($1, $2, 'Test', 'completed', $3, 'test.pdf', 10, 1, $4, $5)
    `,
    [
      envelopeId,
      userId,
      `test/${envelopeId}.pdf`,
      "a".repeat(64),
      Math.floor(Date.now() / 1000),
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Signer', $3, 1, 'signed')
    `,
    [signerId, envelopeId, `${signerId}@example.test`],
  );

  const signed = await createRecipientDownloadLink(
    { envelopeId, fileType: "signed", signerId },
    { database },
  );
  const evidence = await createRecipientDownloadLink(
    { envelopeId, fileType: "evidence", signerId },
    { database },
  );

  return { envelopeId, evidence, signed, signerId };
}

async function storedHashes(envelopeId: string, signerId: string) {
  const result = await database.query<{
    file_type: string;
    token_hash: string;
  }>(
    `
      select file_type, token_hash from recipient_download_tokens
      where envelope_id = $1 and signer_id = $2
    `,
    [envelopeId, signerId],
  );

  return Object.fromEntries(
    result.rows.map((row) => [row.file_type, row.token_hash]),
  );
}

function hashOfLink(url: string | null): string | null {
  return url
    ? hashOpaqueToken(new URL(url).pathname.split("/").at(-1) ?? "")
    : null;
}

type QueryFunction = (text: unknown, values?: unknown[]) => unknown;

/**
 * The same database, except that one write of a download link fails: the
 * first, the second, and so on, counted across the pool and its clients.
 */
function failOnLinkWrite(pool: pg.Pool, failAt: number): pg.Pool {
  let writes = 0;

  function intercept<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property);

        if (property === "query") {
          const query: QueryFunction = (text, values) => {
            if (
              typeof text === "string" &&
              text.includes("INSERT INTO recipient_download_tokens")
            ) {
              writes += 1;

              if (writes === failAt) {
                // Not at once: a write that was started alongside this one
                // has time to land before the failure is reported.
                return new Promise((_, reject) => {
                  setTimeout(() => {
                    reject(new Error("the link could not be stored"));
                  }, 25);
                });
              }
            }

            return (value as QueryFunction).call(object, text, values);
          };

          return query;
        }

        if (property === "connect") {
          return async () =>
            intercept(
              await (value as () => Promise<pg.PoolClient>).call(object),
            );
        }

        return typeof value === "function"
          ? (value.bind(object) as unknown)
          : value;
      },
    });
  }

  return intercept(pool);
}

test("two renewals at once send one email, and its links are the ones that work", async () => {
  const { envelopeId, evidence, signed, signerId } =
    await createFinishedEnvelope();
  const sent: { evidenceUrl: string; signedUrl: string | null }[] = [];
  const sendLinks = async (links: {
    evidenceUrl: string;
    signedUrl: string | null;
  }) => {
    // Long enough for the other request to overlap.
    await new Promise((resolve) => setTimeout(resolve, 50));
    sent.push({ evidenceUrl: links.evidenceUrl, signedUrl: links.signedUrl });
  };

  // One request from each of the signer's two old links.
  const results = await Promise.allSettled([
    renewRecipientDownloadLinks(signed.token, { database, sendLinks }),
    renewRecipientDownloadLinks(evidence.token, { database, sendLinks }),
  ]);
  const refused = results.filter((result) => result.status === "rejected");

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(refused.length, 1);
  assert.ok(refused[0]?.reason instanceof DownloadAccessError);
  assert.equal(refused[0].reason.statusCode, 410);

  // One email, and both of its links are the stored ones.
  assert.equal(sent.length, 1);
  assert.deepEqual(await storedHashes(envelopeId, signerId), {
    evidence: hashOfLink(sent[0]?.evidenceUrl ?? null),
    signed: hashOfLink(sent[0]?.signedUrl ?? null),
  });
});

test("a new link that cannot be stored leaves both old links as they were", async () => {
  const { envelopeId, evidence, signed, signerId } =
    await createFinishedEnvelope();
  let emails = 0;

  // The signed link is written first, so failing the second write fails
  // the certificate's link after the signed one has been replaced.
  await assert.rejects(
    renewRecipientDownloadLinks(signed.token, {
      database: failOnLinkWrite(database, 2),
      sendLinks: async () => {
        emails += 1;
      },
    }),
    /could not be stored/,
  );

  assert.equal(emails, 0);
  assert.deepEqual(await storedHashes(envelopeId, signerId), {
    evidence: evidence.tokenHash,
    signed: signed.tokenHash,
  });
});

test("when the email does not go out the old links are put back, and the signer can ask again", async () => {
  const { envelopeId, evidence, signed, signerId } =
    await createFinishedEnvelope();

  await assert.rejects(
    renewRecipientDownloadLinks(evidence.token, {
      database,
      sendLinks: async () => {
        throw new Error("the mail provider is down");
      },
    }),
    /mail provider is down/,
  );
  assert.deepEqual(await storedHashes(envelopeId, signerId), {
    evidence: evidence.tokenHash,
    signed: signed.tokenHash,
  });

  const sent: (string | null)[] = [];
  const renewed = await renewRecipientDownloadLinks(evidence.token, {
    database,
    sendLinks: async (links) => {
      sent.push(links.signedUrl, links.evidenceUrl);
    },
  });

  assert.match(renewed.maskedEmail, /^.\*+@example\.test$/);
  assert.deepEqual(await storedHashes(envelopeId, signerId), {
    evidence: hashOfLink(sent[1] ?? null),
    signed: hashOfLink(sent[0] ?? null),
  });
});

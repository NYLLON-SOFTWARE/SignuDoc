import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { resolveEnvelopeViewerAccess } from "./envelope-access.ts";
import { listAllEnvelopesForAdmin, listEnvelopesForUser } from "./envelopes.ts";

// Who can see an envelope: its sender, and any administrator once it has
// been sent. Run with `npm run test:db`.

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

async function createUser(role: "admin" | "user", name: string) {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, $2, $3, $4)`,
    [id, name, email, role],
  );

  return { email, name, userId: id };
}

async function createEnvelope(
  userId: string,
  title: string,
  status: "draft" | "sent" = "sent",
) {
  const envelopeId = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at
      ) values ($1, $2, $3, $4, $5, 'doc.pdf', 4, 1, $6, $7)
    `,
    [
      envelopeId,
      userId,
      title,
      status,
      `users/${userId}/envelopes/${envelopeId}/source.pdf`,
      "a".repeat(64),
      status === "draft" ? null : Math.floor(Date.now() / 1000),
    ],
  );

  return envelopeId;
}

test("the sender sees their own envelope", async () => {
  const sender = await createUser("user", "Sam Sender");
  const envelopeId = await createEnvelope(sender.userId, "Lease");

  assert.deepEqual(
    await resolveEnvelopeViewerAccess(sender.userId, envelopeId, database),
    {
      folderId: null,
      ownerEmail: sender.email,
      ownerName: "Sam Sender",
      ownerUserId: sender.userId,
      viewerIsAdmin: false,
      viewerIsOwner: true,
    },
  );
});

test("an administrator sees another member's envelope, and whose it is", async () => {
  const sender = await createUser("user", "Sam Sender");
  const admin = await createUser("admin", "Avery Admin");
  const envelopeId = await createEnvelope(sender.userId, "Lease");

  assert.deepEqual(
    await resolveEnvelopeViewerAccess(admin.userId, envelopeId, database),
    {
      folderId: null,
      ownerEmail: sender.email,
      ownerName: "Sam Sender",
      ownerUserId: sender.userId,
      viewerIsAdmin: true,
      viewerIsOwner: false,
    },
  );
});

test("another member who is not an administrator does not see it", async () => {
  const sender = await createUser("admin", "Sam Sender");
  const other = await createUser("user", "Olive Other");
  const envelopeId = await createEnvelope(sender.userId, "Lease");

  assert.equal(
    await resolveEnvelopeViewerAccess(other.userId, envelopeId, database),
    null,
  );
  assert.equal(
    await resolveEnvelopeViewerAccess(other.userId, randomUUID(), database),
    null,
  );
});

test("an administrator's list of every envelope names each sender", async () => {
  const first = await createUser("user", "Sam Sender");
  const second = await createUser("admin", "");
  const firstEnvelope = await createEnvelope(first.userId, "First lease");
  const secondEnvelope = await createEnvelope(second.userId, "Second lease");

  const all = await listAllEnvelopesForAdmin(
    second.userId,
    { limit: 100 },
    database,
  );
  const byId = new Map(
    all.envelopes.map((envelope) => [envelope.id, envelope]),
  );

  assert.equal(
    byId.get(firstEnvelope)?.senderLabel,
    `Sam Sender (${first.email})`,
  );
  // No name: the address alone.
  assert.equal(byId.get(secondEnvelope)?.senderLabel, second.email);
  // The sender's address is searchable on the page too.
  assert.ok(byId.get(firstEnvelope)?.searchableEmails.includes(first.email));

  // A sender's own list stays theirs, without the sender on each card.
  const own = await listEnvelopesForUser(first.userId, {}, database);

  assert.deepEqual(
    own.envelopes.map((envelope) => envelope.id),
    [firstEnvelope],
  );
  assert.equal(own.envelopes[0]?.senderLabel, undefined);
  assert.equal(own.hasMore, false);
});

test("every envelope can be reached, a page at a time", async () => {
  const sender = await createUser("user", "Paige Pager");
  const ids: string[] = [];

  for (let index = 0; index < 5; index += 1) {
    ids.push(await createEnvelope(sender.userId, `Page test ${String(index)}`));
  }

  const seen: string[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await listEnvelopesForUser(
      sender.userId,
      { limit: 2, page },
      database,
    );

    assert.ok(result.envelopes.length <= 2);
    seen.push(...result.envelopes.map((envelope) => envelope.id));
    hasMore = result.hasMore;
    page += 1;
  }

  assert.deepEqual([...seen].sort(), [...ids].sort());
  assert.equal(page - 1, 3);
});

test("searching every envelope finds a sender by name or address", async () => {
  const sender = await createUser("user", "Quentin Quarry");
  const admin = await createUser("admin", "Avery Admin");
  const envelopeId = await createEnvelope(sender.userId, "Unrelated title");

  for (const search of ["quentin quarry", sender.email.slice(0, 12)]) {
    const result = await listAllEnvelopesForAdmin(
      admin.userId,
      { limit: 100, search },
      database,
    );

    assert.ok(
      result.envelopes.some((envelope) => envelope.id === envelopeId),
      `expected "${search}" to find the envelope`,
    );
  }

  // A sender's own search does not look at the sender.
  const own = await listEnvelopesForUser(
    sender.userId,
    { search: "quentin" },
    database,
  );

  assert.deepEqual(own.envelopes, []);
});

test("another member's draft stays theirs: an administrator neither lists nor opens it", async () => {
  const sender = await createUser("user", "Dana Drafter");
  const admin = await createUser("admin", "Avery Admin");
  const draftId = await createEnvelope(sender.userId, "Unsent lease", "draft");
  const sentId = await createEnvelope(sender.userId, "Sent lease");
  const ownDraftId = await createEnvelope(admin.userId, "Own draft", "draft");

  assert.equal(
    await resolveEnvelopeViewerAccess(admin.userId, draftId, database),
    null,
  );
  assert.ok(await resolveEnvelopeViewerAccess(admin.userId, sentId, database));
  // The sender still sees it.
  assert.ok(
    await resolveEnvelopeViewerAccess(sender.userId, draftId, database),
  );

  const all = await listAllEnvelopesForAdmin(
    admin.userId,
    { limit: 100, search: "lease" },
    database,
  );
  const ids = all.envelopes.map((envelope) => envelope.id);

  assert.ok(ids.includes(sentId));
  assert.ok(!ids.includes(draftId));

  // An administrator's own drafts are still in everyone's list.
  const own = await listAllEnvelopesForAdmin(
    admin.userId,
    { limit: 100, search: "own draft" },
    database,
  );

  assert.ok(own.envelopes.some((envelope) => envelope.id === ownDraftId));
});

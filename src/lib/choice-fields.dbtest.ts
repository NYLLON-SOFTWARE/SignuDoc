import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";
import { ZodError } from "zod";

import { openTestDatabase } from "./db/test-database.ts";
import {
  EnvelopeMutationError,
  getEnvelopeDetailDataForUser,
  getPrepareEnvelopeDataForUser,
  getReviewEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";

// Number, dropdown and radio fields against a real Postgres: a draft may
// hold them half-finished, and an envelope cannot be sent until they can
// be answered. Run with `npm run test:db`.

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

async function createDraft() {
  const userId = randomUUID();
  const envelopeId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Survey', 'draft', $3, 'survey.pdf', 10, 1, $4)
    `,
    [envelopeId, userId, `test/${envelopeId}.pdf`, "a".repeat(64)],
  );
  await database.query(
    `
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );

  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: [
        { email: "riley@example.test", name: "Riley Recipient" },
        { email: "casey@example.test", name: "Casey Second" },
      ],
    },
    database,
  );
  const [riley, casey] = saved.signers.map((signer) => signer.id);

  return { casey: casey!, envelopeId, riley: riley!, userId };
}

function field(
  signerId: string,
  type: string,
  y: number,
  extra: Record<string, unknown> = {},
) {
  return {
    height: 0.03,
    page: 1,
    required: true,
    signerId,
    type,
    width: 0.2,
    x: 0.1,
    y,
    ...extra,
  };
}

test("a draft keeps half-finished choices, and sending waits until they can be answered", async () => {
  const { casey, envelopeId, riley, userId } = await createDraft();
  const groupId = randomUUID();
  const signatures = [
    field(riley, "signature", 0.1),
    field(casey, "signature", 0.15),
  ];
  const save = (fields: unknown[]) =>
    replaceDraftEnvelopeFields(userId, envelopeId, { fields }, database);
  const review = () =>
    getReviewEnvelopeDataForUser(userId, envelopeId, database);

  // As the editor saves it the moment the fields are placed: a dropdown
  // with no choices yet and one radio button on its own.
  await save([
    ...signatures,
    field(riley, "number", 0.2, { required: false }),
    field(riley, "dropdown", 0.25, { options: [] }),
    field(casey, "radio", 0.3, { groupId, label: "Option 1" }),
  ]);

  let reviewed = await review();

  assert.equal(reviewed?.canSend, false);
  assert.match(
    reviewed?.disabledReason ?? "",
    /dropdown for Riley Recipient needs at least two choices/,
  );
  await assert.rejects(
    sendDraftEnvelope(
      userId,
      envelopeId,
      { senderEmail: "sam@example.test", senderName: "Sam Sender" },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.statusCode === 400 &&
      /dropdown/.test(error.message),
  );

  // With the dropdown filled in, the lone radio button is what is left.
  await save([
    ...signatures,
    field(riley, "number", 0.2, { required: false }),
    field(riley, "dropdown", 0.25, { options: ["Yes", "No", "Not sure"] }),
    field(casey, "radio", 0.3, { groupId, label: "Option 1" }),
  ]);
  reviewed = await review();
  assert.equal(reviewed?.canSend, false);
  assert.match(
    reviewed?.disabledReason ?? "",
    /radio button for Casey Second is on its own/,
  );

  await save([
    ...signatures,
    field(riley, "number", 0.2, { required: false }),
    field(riley, "dropdown", 0.25, { options: ["Yes", "No", "Not sure"] }),
    field(casey, "radio", 0.3, { groupId, label: "Agree" }),
    field(casey, "radio", 0.35, { groupId, label: "Disagree" }),
    field(casey, "radio", 0.4, { groupId, label: "Abstain" }),
  ]);
  reviewed = await review();
  assert.equal(reviewed?.canSend, true);
  assert.equal(reviewed?.disabledReason, null);

  // The three buttons are one thing to do, on the review page and on the
  // envelope page alike.
  assert.deepEqual(
    reviewed?.signers.map((signer) => signer.fieldSummaries),
    [
      ["Signature", "Number", "Dropdown"],
      ["Signature", "Radio group"],
    ],
  );

  const detail = await getEnvelopeDetailDataForUser(
    userId,
    envelopeId,
    database,
  );

  assert.deepEqual(
    detail?.signers.map((signer) => signer.metaLabel),
    ["3 fields assigned", "2 fields assigned"],
  );

  // What was saved comes back to the editor as it was.
  const prepared = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
    database,
  });
  const dropdown = prepared?.fields.find((entry) => entry.type === "dropdown");
  const radios = prepared?.fields.filter((entry) => entry.type === "radio");

  assert.deepEqual(dropdown?.options, ["Yes", "No", "Not sure"]);
  assert.equal(dropdown?.groupId, undefined);
  assert.deepEqual(
    radios?.map((entry) => [entry.label, entry.groupId, entry.options]),
    [
      ["Agree", groupId, undefined],
      ["Disagree", groupId, undefined],
      ["Abstain", groupId, undefined],
    ],
  );
});

test("choices only belong on dropdowns, groups only on radio buttons, and a group holds together", async () => {
  const { casey, envelopeId, riley, userId } = await createDraft();
  const groupId = randomUUID();
  const refused: unknown[][] = [
    // Choices on a field that is not a dropdown.
    [field(riley, "text", 0.2, { options: ["Yes", "No"] })],
    // The same choice twice.
    [field(riley, "dropdown", 0.2, { options: ["Yes", "Yes"] })],
    // More choices than a dropdown holds.
    [
      field(riley, "dropdown", 0.2, {
        options: Array.from({ length: 21 }, (_, index) => `Choice ${index}`),
      }),
    ],
    // A radio button with no group, and a group on something else.
    [field(riley, "radio", 0.2)],
    [field(riley, "checkbox", 0.2, { groupId })],
    // One group answered by two people.
    [
      field(riley, "radio", 0.2, { groupId }),
      field(casey, "radio", 0.25, { groupId }),
    ],
    // One group that is both required and optional.
    [
      field(riley, "radio", 0.2, { groupId }),
      field(riley, "radio", 0.25, { groupId, required: false }),
    ],
    // A type that does not exist.
    [field(riley, "slider", 0.2)],
  ];

  for (const fields of refused) {
    await assert.rejects(
      replaceDraftEnvelopeFields(userId, envelopeId, { fields }, database),
      ZodError,
      JSON.stringify(fields),
    );
  }

  const stored = await database.query(
    "select 1 from fields where envelope_id = $1",
    [envelopeId],
  );

  assert.equal(stored.rowCount, 0);
});

test("the database itself keeps choices and groups where they belong", async () => {
  const { envelopeId, riley } = await createDraft();
  const insert = (
    type: string,
    options: string | null,
    groupId: string | null,
  ) =>
    database.query(
      `
        insert into fields (
          id, envelope_id, signer_id, type, page, x, y, width, height,
          options, group_id
        ) values ($1, $2, $3, $4, 1, 0.1, 0.1, 0.1, 0.1, $5::jsonb, $6)
      `,
      [randomUUID(), envelopeId, riley, type, options, groupId],
    );

  await assert.rejects(
    insert("text", '["Yes"]', null),
    /fields_options_only_on_dropdowns/,
  );
  await assert.rejects(
    insert("dropdown", '{"not":"a list"}', null),
    /fields_options_only_on_dropdowns/,
  );
  await assert.rejects(
    insert("radio", null, null),
    /fields_group_only_on_radios/,
  );
  await assert.rejects(
    insert("checkbox", null, "group-1"),
    /fields_group_only_on_radios/,
  );
  await assert.rejects(insert("slider", null, null), /fields_type_check/);

  await insert("dropdown", '["Yes","No"]', null);
  await insert("radio", null, "group-1");
  await insert("number", null, null);
});

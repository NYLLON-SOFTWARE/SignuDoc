import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "../db/test-database.ts";
import { createNotificationRule, updateNotificationRule } from "./rules.ts";

// An administrator's rules as Settings changes them, against a real
// Postgres. Run with `npm run test:db`.

let database: pg.Pool;
let admin: { email: string; id: string };
const createdRules: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;

  const id = randomUUID();

  admin = { email: `${id}@example.test`, id };
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, 'Avery Admin', $2, true, 'admin')
    `,
    [id, admin.email],
  );
});

after(async () => {
  await database.query(`delete from notification_rules where id = any($1)`, [
    createdRules,
  ]);
  await database.query(`delete from public."user" where id = $1`, [admin.id]);
  await database.end();
});

test("editing a paused rule without saying enabled leaves it paused", async () => {
  const actor = { email: admin.email, id: admin.id };
  const created = await createNotificationRule(
    actor,
    {
      channel: "slack",
      destination: "C0PAUSED1",
      events: ["envelope_completed"],
    },
    database,
  );
  const rule = created.find((item) => item.destination === "C0PAUSED1");

  assert.ok(rule);
  createdRules.push(rule.id);

  const body = {
    channel: "slack",
    destination: "C0PAUSED1",
    events: ["envelope_completed"],
  };

  await updateNotificationRule(
    actor,
    rule.id,
    { ...body, enabled: false },
    database,
  );

  // The settings panel's edit sends no `enabled`.
  const edited = await updateNotificationRule(
    actor,
    rule.id,
    { ...body, events: ["envelope_completed", "envelope_declined"] },
    database,
  );
  const result = edited.find((item) => item.id === rule.id);

  assert.deepEqual(result?.events.slice().sort(), [
    "envelope_completed",
    "envelope_declined",
  ]);
  assert.equal(result?.enabled, false, "still paused");
});

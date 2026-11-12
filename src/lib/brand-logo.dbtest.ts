import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import {
  BrandLogoError,
  readBrandLogo,
  removeBrandLogo,
  saveBrandLogo,
} from "./brand-logo.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { readStoredSettings, saveSettings } from "./settings.ts";

// The install's logo and color against a real Postgres: they are kept in
// the one settings row, and saving either leaves the other alone. Run with
// `npm run test:db`.

type SettingsSnapshot = Record<string, unknown> | null;

let database: pg.Pool;
let settingsBefore: SettingsSnapshot = null;

function png(marker: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    marker,
  ]);
}

before(async () => {
  database = await openTestDatabase();

  // There is one settings row for the whole database. Whatever other tests
  // left in it is put back afterwards.
  const existing = await database.query(
    "select * from public.app_settings where id",
  );

  settingsBefore = existing.rows[0] ?? null;
});

after(async () => {
  if (settingsBefore) {
    await database.query(
      `
        update public.app_settings
        set
          brand_color = $1,
          logo_content_type = $2,
          logo_data = $3,
          logo_hash = $4,
          organization_name = $5,
          signup_mode = $6
        where id
      `,
      [
        settingsBefore.brand_color,
        settingsBefore.logo_content_type,
        settingsBefore.logo_data,
        settingsBefore.logo_hash,
        settingsBefore.organization_name,
        settingsBefore.signup_mode,
      ],
    );
  } else {
    await database.query("delete from public.app_settings where id");
  }

  await database.end();
});

test("a logo is stored, read back and replaced, and its version follows the image", async () => {
  const first = await saveBrandLogo(png(1), database);

  assert.match(first, /^[0-9a-f]{16}$/);

  const stored = await readBrandLogo(database);

  assert.ok(stored);
  assert.equal(stored.contentType, "image/png");
  assert.equal(stored.version, first);
  assert.deepEqual([...stored.bytes], [...png(1)]);
  assert.equal((await readStoredSettings(database))?.logoVersion, first);

  // A different image gets a different version; the same one keeps its own.
  const second = await saveBrandLogo(png(2), database);

  assert.notEqual(second, first);
  assert.equal(await saveBrandLogo(png(2), database), second);
  assert.deepEqual([...(await readBrandLogo(database))!.bytes], [...png(2)]);
});

test("saving the other settings leaves the logo where it is, and the color beside it", async () => {
  const version = await saveBrandLogo(png(3), database);
  const saved = await saveSettings(
    { brandColor: "#1a73e8", organizationName: "Logo Test Org" },
    database,
  );

  assert.equal(saved.brandColor, "#1a73e8");
  assert.equal(saved.logoVersion, version);
  assert.deepEqual([...(await readBrandLogo(database))!.bytes], [...png(3)]);

  // And the other way round: a new logo does not touch the color.
  await saveBrandLogo(png(4), database);
  assert.equal((await readStoredSettings(database))?.brandColor, "#1a73e8");

  const cleared = await saveSettings({ brandColor: null }, database);

  assert.equal(cleared.brandColor, null);
});

test("removing the logo clears every trace of it", async () => {
  await saveBrandLogo(png(5), database);
  await removeBrandLogo(database);

  assert.equal(await readBrandLogo(database), null);
  assert.equal((await readStoredSettings(database))?.logoVersion, null);

  // Removing what is not there is not an error.
  await removeBrandLogo(database);
});

test("what is not an image never reaches the database", async () => {
  await removeBrandLogo(database);

  await assert.rejects(
    saveBrandLogo(new TextEncoder().encode("<svg></svg>"), database),
    BrandLogoError,
  );
  assert.equal(await readBrandLogo(database), null);
});

test("the database itself refuses a color or a logo that is not one", async () => {
  await saveSettings({ organizationName: "Logo Test Org" }, database);

  await assert.rejects(
    database.query(
      "update public.app_settings set brand_color = 'red' where id",
    ),
    /app_settings_brand_color_check/,
  );
  await assert.rejects(
    database.query(
      "update public.app_settings set logo_data = '\\x00', logo_content_type = 'image/svg+xml', logo_hash = '0123456789abcdef' where id",
    ),
    /app_settings_logo_check/,
  );
  await assert.rejects(
    database.query(
      "update public.app_settings set logo_data = '\\x00' where id",
    ),
    /app_settings_logo_check/,
  );
});

import { createHash } from "node:crypto";

import { MAX_LOGO_BYTES, type LogoContentType } from "./branding.ts";
import { getDb, queryOne, type DbExecutor } from "./db/connection.ts";
import { invalidateSettingsCache, isMissingSchemaError } from "./settings.ts";

// The install's logo: one small image, kept in the settings row.
//
// It is shown to everyone, signers included, so what is stored is decided
// by looking at the bytes, never by what the upload claimed to be. SVG is
// not accepted: it can carry scripts, and email programs do not show it.

export { MAX_LOGO_BYTES, type LogoContentType } from "./branding.ts";

export type BrandLogo = {
  bytes: Uint8Array;
  contentType: LogoContentType;
  /** The start of the image's SHA-256: the same image, the same version. */
  version: string;
};

export class BrandLogoError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "BrandLogoError";
    this.statusCode = statusCode;
  }
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value)
  );
}

/** What kind of image these bytes are, or null when it is not one we take. */
export function sniffLogoContentType(
  bytes: Uint8Array,
): LogoContentType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  // "RIFF" <size> "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }

  return null;
}

/** Checks an upload and says what it is. Throws when it cannot be a logo. */
export function checkLogoUpload(bytes: Uint8Array): LogoContentType {
  if (bytes.length === 0) {
    throw new BrandLogoError("Choose an image to upload.");
  }

  if (bytes.length > MAX_LOGO_BYTES) {
    throw new BrandLogoError("The logo must be 512 KB or smaller.", 413);
  }

  const contentType = sniffLogoContentType(bytes);

  if (!contentType) {
    throw new BrandLogoError("The logo must be a PNG, JPEG or WebP image.");
  }

  return contentType;
}

type LogoRow = {
  logo_content_type: LogoContentType | null;
  logo_data: Buffer | null;
  logo_hash: string | null;
};

/**
 * Stores the logo, replacing any there was, and returns its version.
 *
 * The version is the start of the image's hash. The address the logo is
 * served at carries it and is cached for good, so a different image always
 * gets a different address and the same image keeps the one it had.
 */
export async function saveBrandLogo(
  bytes: Uint8Array,
  database: DbExecutor = getDb(),
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const contentType = checkLogoUpload(bytes);
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

  // An install that was never set up has no settings row. Sign-up stays as
  // it was without one: open.
  await database.query(
    `
      insert into public.app_settings (
        id,
        signup_mode,
        logo_content_type,
        logo_data,
        logo_hash,
        created_at,
        updated_at
      )
      values (true, 'open', $1, $2, $3, $4, $4)
      on conflict (id) do update set
        logo_content_type = excluded.logo_content_type,
        logo_data = excluded.logo_data,
        logo_hash = excluded.logo_hash,
        updated_at = excluded.updated_at
    `,
    [contentType, Buffer.from(bytes), version, now],
  );

  invalidateSettingsCache();

  return version;
}

/** Removes the logo. Nothing happens when there is none. */
export async function removeBrandLogo(
  database: DbExecutor = getDb(),
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await database.query(
    `
      update public.app_settings
      set
        logo_content_type = null,
        logo_data = null,
        logo_hash = null,
        updated_at = $1
      where id and logo_data is not null
    `,
    [now],
  );

  invalidateSettingsCache();
}

/** The stored logo, or null when there is none (or no column for it yet). */
export async function readBrandLogo(
  database: DbExecutor = getDb(),
): Promise<BrandLogo | null> {
  let row: LogoRow | null;

  try {
    row = await queryOne<LogoRow>(
      database,
      `
        select logo_content_type, logo_data, logo_hash
        from public.app_settings
        where id
      `,
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return null;
    }

    throw error;
  }

  if (!row?.logo_data || !row.logo_content_type || !row.logo_hash) {
    return null;
  }

  return {
    bytes: new Uint8Array(row.logo_data),
    contentType: row.logo_content_type,
    version: row.logo_hash,
  };
}

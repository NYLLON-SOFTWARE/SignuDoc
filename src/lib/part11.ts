import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { SIGNUDOC_NAME } from "./branding.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { getBranding, getSettings } from "./settings.ts";
import { type SignatureMeaning } from "./types/domain.ts";

// Part 11 mode: the controls 21 CFR Part 11 asks of a system that keeps
// signed electronic records, for installs that turn it on.
//
// - Every signer signs with their own account on this install (11.100(a)),
//   and an administrator has recorded that they checked who the person is
//   (11.100(b)).
// - The signer gives their email address and password to open the document
//   and again for each signature (11.200(a)). Five wrong passwords lock the
//   account for signing until an administrator unlocks it, and the
//   administrators are told (11.300(d)).
// - Each signature says what it means: approval, review, responsibility or
//   authorship, printed beside it with the signer's name and the time
//   (11.50).
// - Finished envelopes are never deleted by the retention period or a data
//   request, and a void needs a reason.
//
// Whether an install meets Part 11 depends on how it is validated and run.
// This is the software's part only.

export const MAX_SIGNING_PASSWORD_ATTEMPTS = 5;

export {
  parseSignatureMeaning,
  SIGNATURE_MEANING_DETAILS,
  signatureMeaningLabel,
} from "./signature-meanings.ts";

export class Part11Error extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "Part11Error";
    this.statusCode = statusCode;
  }
}

/** Whether the install is in Part 11 mode right now. */
export async function isPart11ModeOn(): Promise<boolean> {
  return (await getSettings()).part11Mode;
}

export type Part11SignerAccount = {
  email: string;
  emailVerified: boolean;
  identityVerifiedAt: number | null;
  name: string;
  signingLockedAt: number | null;
  userId: string;
};

/** The accounts these addresses belong to, keyed by lower-case address. */
export async function findSignerAccounts(
  emails: readonly string[],
  database: DbExecutor = getDb(),
): Promise<Map<string, Part11SignerAccount>> {
  if (emails.length === 0) {
    return new Map();
  }

  const rows = await queryMany<Part11SignerAccount>(
    database,
    `
      SELECT
        u.id AS "userId",
        u.email,
        u.name,
        u."emailVerified" AS "emailVerified",
        u.identity_verified_at AS "identityVerifiedAt",
        u.signing_locked_at AS "signingLockedAt"
      FROM "user" u
      WHERE lower(u.email) = ANY($1)
    `,
    [emails.map((email) => email.toLowerCase())],
  );

  return new Map(rows.map((row) => [row.email.toLowerCase(), row]));
}

/**
 * Why this signer cannot sign a Part 11 envelope, or null when they can.
 * Said in words the sender can act on.
 */
export function describePart11SignerProblem(
  signer: {
    email: string;
    name: string;
    signatureMeaning?: SignatureMeaning | null;
  },
  account: Part11SignerAccount | undefined,
): string | null {
  if (!account) {
    return `${signer.name} (${signer.email}) needs an account on this site before they can sign. Part 11 mode only lets people sign with their own account.`;
  }

  if (!account.emailVerified) {
    return `${signer.name} has not confirmed their email address yet.`;
  }

  if (account.identityVerifiedAt === null) {
    return `An administrator has to confirm ${signer.name}'s identity under Settings, People before they can sign.`;
  }

  if (account.signingLockedAt !== null) {
    return `${signer.name}'s account is locked for signing after too many wrong passwords. An administrator can unlock it under Settings, People.`;
  }

  if (!signer.signatureMeaning) {
    return `Choose what ${signer.name}'s signature means (approval, review, responsibility or authorship).`;
  }

  return null;
}

type Actor = {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

async function assertActorIsAdmin(actor: Actor, tx: DbExecutor) {
  const row = await queryOne<{ role: string }>(
    tx,
    `SELECT role FROM "user" WHERE id = $1`,
    [actor.userId],
  );

  if (row?.role !== "admin") {
    throw new Part11Error("Only an administrator can do this.", 403);
  }
}

type TargetRow = {
  email: string;
  emailVerified: boolean;
  identityVerifiedAt: number | null;
  name: string;
  signingLockedAt: number | null;
};

async function lockTarget(
  targetUserId: string,
  tx: DbExecutor,
): Promise<TargetRow> {
  const target = await queryOne<TargetRow>(
    tx,
    `
      SELECT
        email,
        name,
        "emailVerified" AS "emailVerified",
        identity_verified_at AS "identityVerifiedAt",
        signing_locked_at AS "signingLockedAt"
      FROM "user"
      WHERE id = $1
      FOR UPDATE
    `,
    [targetUserId],
  );

  if (!target) {
    throw new Part11Error("That account no longer exists.", 404);
  }

  return target;
}

/**
 * Records that an administrator checked who this person is (for example
 * against an ID document or an HR record), or takes that back. The note
 * says how, and goes in the install's audit trail with the change.
 */
export async function setIdentityVerification(
  actor: Actor,
  targetUserId: string,
  input: { note?: string | null; verified: boolean },
  database: DbPool = getDb(),
): Promise<void> {
  const note = input.note?.trim().slice(0, 500) || null;

  if (input.verified && !note) {
    throw new Part11Error(
      "Say how you checked this person's identity, for example the document you saw.",
      400,
    );
  }

  await withTransaction(async (tx) => {
    await assertActorIsAdmin(actor, tx);

    const target = await lockTarget(targetUserId, tx);

    if (input.verified && !target.emailVerified) {
      throw new Part11Error(
        "This person has not confirmed their email address yet.",
        409,
      );
    }

    const now = Math.floor(Date.now() / 1000);

    await tx.query(
      `
        UPDATE "user"
        SET
          identity_verified_at = $1,
          identity_verified_by = $2,
          identity_verification_note = $3,
          "updatedAt" = now()
        WHERE id = $4
      `,
      input.verified
        ? [now, actor.userId, note, targetUserId]
        : [null, null, null, targetUserId],
    );
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt: now,
        event: input.verified
          ? "identity_verified"
          : "identity_verification_revoked",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          note,
          previousVerifiedAt: target.identityVerifiedAt,
          targetEmail: target.email,
          targetName: target.name,
        },
        targetUserId,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);
}

/** Lets a person whose wrong passwords locked them sign again. */
export async function unlockSigning(
  actor: Actor,
  targetUserId: string,
  database: DbPool = getDb(),
): Promise<void> {
  await withTransaction(async (tx) => {
    await assertActorIsAdmin(actor, tx);

    const target = await lockTarget(targetUserId, tx);

    if (target.signingLockedAt === null) {
      return;
    }

    await tx.query(
      `
        UPDATE "user"
        SET signing_locked_at = NULL, signing_failed_attempts = 0
        WHERE id = $1
      `,
      [targetUserId],
    );
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "signing_unlocked",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          lockedAt: target.signingLockedAt,
          targetEmail: target.email,
          targetName: target.name,
        },
        targetUserId,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);
}

/** Checks a password against an account's stored hash. */
export type PasswordVerifier = (input: {
  hash: string;
  password: string;
}) => Promise<boolean>;

async function defaultPasswordVerifier(input: {
  hash: string;
  password: string;
}): Promise<boolean> {
  // The same hashing Better Auth signs people in with. Loaded here, not at
  // the top, so this module can be used where the auth server is not set up.
  const { getAuth } = await import("./auth/server.ts");
  const context = await getAuth().$context;

  return context.password.verify(input);
}

export type SigningPasswordResult =
  { ok: true } | { attemptsLeft: number; locked: boolean; ok: false };

/**
 * The two parts of a Part 11 signature: the account's email address (its
 * identification code) and its password. Wrong answers count against the
 * account, and the fifth in a row locks it for signing and tells the
 * administrators. A right answer clears the count.
 */
export async function checkSigningCredentials(
  input: {
    email: string;
    ipAddress?: string | null;
    password: string;
    userAgent?: string | null;
    userId: string;
  },
  {
    database = getDb(),
    emailService,
    verifyPassword = defaultPasswordVerifier,
  }: {
    database?: DbPool;
    emailService?: EmailService;
    verifyPassword?: PasswordVerifier;
  } = {},
): Promise<SigningPasswordResult> {
  const outcome = await withTransaction(async (tx) => {
    const account = await queryOne<{
      email: string;
      failedAttempts: number;
      hash: string | null;
      lockedAt: number | null;
      name: string;
    }>(
      tx,
      `
        SELECT
          u.email,
          u.name,
          u.signing_failed_attempts AS "failedAttempts",
          u.signing_locked_at AS "lockedAt",
          (
            SELECT a.password FROM account a
            WHERE a."userId" = u.id AND a."providerId" = 'credential'
            LIMIT 1
          ) AS hash
        FROM "user" u
        WHERE u.id = $1
        FOR UPDATE OF u
      `,
      [input.userId],
    );

    if (!account) {
      return { attemptsLeft: 0, locked: true, ok: false as const };
    }

    if (account.lockedAt !== null) {
      return { attemptsLeft: 0, locked: true, ok: false as const };
    }

    const emailMatches =
      input.email.trim().toLowerCase() === account.email.toLowerCase();
    const passwordMatches =
      account.hash !== null && input.password.length > 0
        ? await verifyPassword({ hash: account.hash, password: input.password })
        : false;

    if (emailMatches && passwordMatches) {
      if (account.failedAttempts > 0) {
        await tx.query(
          `UPDATE "user" SET signing_failed_attempts = 0 WHERE id = $1`,
          [input.userId],
        );
      }

      return { ok: true as const };
    }

    const failedAttempts = account.failedAttempts + 1;
    const locked = failedAttempts >= MAX_SIGNING_PASSWORD_ATTEMPTS;
    const now = Math.floor(Date.now() / 1000);

    await tx.query(
      `
        UPDATE "user"
        SET signing_failed_attempts = $1, signing_locked_at = $2
        WHERE id = $3
      `,
      [failedAttempts, locked ? now : null, input.userId],
    );
    await recordSystemAuditEvent(
      {
        actorEmail: account.email,
        actorUserId: input.userId,
        createdAt: now,
        event: locked ? "signing_locked" : "reauthentication_failed",
        ipAddress: input.ipAddress ?? null,
        metadata: { failedAttempts },
        targetUserId: input.userId,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );

    return {
      account,
      attemptsLeft: Math.max(0, MAX_SIGNING_PASSWORD_ATTEMPTS - failedAttempts),
      locked,
      ok: false as const,
    };
  }, database);

  if (
    !outcome.ok &&
    "account" in outcome &&
    outcome.account &&
    outcome.locked
  ) {
    await alertAdministrators(
      { email: outcome.account.email, name: outcome.account.name },
      { database, emailService },
    );
  }

  if (outcome.ok) {
    return { ok: true };
  }

  return {
    attemptsLeft: outcome.attemptsLeft,
    locked: outcome.locked,
    ok: false,
  };
}

/** Tells every administrator that an account was locked for signing. */
async function alertAdministrators(
  person: { email: string; name: string },
  {
    database,
    emailService,
  }: { database: DbExecutor; emailService?: EmailService },
): Promise<void> {
  try {
    const admins = await queryMany<{ email: string }>(
      database,
      `SELECT email FROM "user" WHERE role = 'admin'`,
    );
    // The alert goes out even when the branding cannot be read.
    const productName = await getBranding()
      .then((branding) => branding.productName)
      .catch(() => SIGNUDOC_NAME);
    const service = emailService ?? createEmailService();
    const textBody = [
      `${person.name} <${person.email}> gave the wrong password ${MAX_SIGNING_PASSWORD_ATTEMPTS} times in a row while signing on ${productName}.`,
      "",
      "Their account can no longer sign until an administrator unlocks it under Settings, People.",
      "If this was not them, someone may be trying to sign in their name. Check with them before unlocking.",
    ].join("\n");

    for (const admin of admins) {
      await service.send({
        subject: `Signing locked for ${person.name}`,
        template: "signing_lock_alert",
        textBody,
        to: admin.email,
      });
    }
  } catch (error) {
    // The lock is in place and in the audit trail; the email is a courtesy.
    console.error("Failed to tell administrators about a signing lock:", error);
  }
}

/**
 * Turns Part 11 mode on or off for the install. Turning it on needs the
 * retention period off first, because Part 11 records are kept for as long
 * as the regulations that apply to them say, not by a timer here.
 */
export async function setPart11Mode(
  actor: Actor,
  enabled: boolean,
  database: DbPool = getDb(),
): Promise<void> {
  const { readStoredSettings, saveSettings } = await import("./settings.ts");

  await withTransaction(async (tx) => {
    await assertActorIsAdmin(actor, tx);
    // Settings are one row; holding it keeps two changes from crossing.
    await tx.query(`SELECT id FROM app_settings WHERE id FOR UPDATE`);

    const current = await readStoredSettings(tx);
    const wasEnabled = current?.part11Mode ?? false;

    if (wasEnabled === enabled) {
      return;
    }

    if (enabled && current?.retentionDays != null) {
      throw new Part11Error(
        "Turn off the retention period under Organization first. Part 11 records are kept for as long as the rules that apply to them require.",
        409,
      );
    }

    await saveSettings({ part11Mode: enabled }, tx);
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "part11_mode_changed",
        ipAddress: actor.ipAddress ?? null,
        metadata: { from: wasEnabled, to: enabled },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);
}

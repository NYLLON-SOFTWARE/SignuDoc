import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { getDb, withTransaction, type DbPool } from "./db/connection.ts";
import { emailSchema, nameSchema } from "./schemas/common.ts";
import {
  closeSignupUntilSetupFinishes,
  invalidateSettingsCache,
  readSetupState,
  readStoredSettings,
  saveSettings,
  type SettingsUpdate,
  type SetupState,
} from "./settings.ts";
import { suggestSignupPolicy } from "./signup-policy.ts";
import { getEnv, isHostedMode, type EnvSource } from "./utils/env.ts";

// First-run setup: the step that turns a deployment into someone's install.
//
// On a database with no accounts, the first visitor to /setup creates the
// administrator and names the organization. Setting SETUP_TOKEN means the
// visitor must also know that token, for installs that sit on a public URL
// before their owner gets to them.
//
// On a database that already has accounts but no administrator (an install
// that predates settings), nobody is created. A signed-in user becomes the
// administrator, and SETUP_TOKEN is required: without it, any account
// holder could promote themselves.
//
// Either way, setup does not finish without a support address, the one
// signers and account holders are told to write to, unless SUPPORT_EMAIL
// already sets it for the deployment. It is saved in this install's own
// settings, and nothing stands in for it: any address written into the
// code would belong to somebody else.

// Held for the length of the setup transaction, so two visitors cannot both
// become the first administrator.
const SETUP_ADVISORY_LOCK_ID = 746108322;

export type SetupFieldName =
  | "email"
  | "fullName"
  | "organizationName"
  | "password"
  | "senderAddress"
  | "setupToken"
  | "supportAddress";

export class SetupError extends Error {
  readonly fieldErrors: Partial<Record<SetupFieldName, string>>;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    fieldErrors: Partial<Record<SetupFieldName, string>> = {},
  ) {
    super(message);
    this.name = "SetupError";
    this.fieldErrors = fieldErrors;
    this.statusCode = statusCode;
  }
}

/** What the setup page should show. */
export type SetupView =
  | { view: "complete" }
  | { view: "unmigrated" }
  | {
      /** Nobody has an account: the visitor creates the administrator. */
      view: "create";
      /** False when SUPPORT_EMAIL sets the address, or one is saved already. */
      asksForSupportAddress: boolean;
      requiresToken: boolean;
      senderAddressFromEnv: boolean;
    }
  | {
      /** Accounts exist: a signed-in user becomes the administrator. */
      view: "claim";
      asksForSupportAddress: boolean;
      signedInEmail: string | null;
      tokenConfigured: boolean;
    };

type SetupSessionUser = {
  email: string;
  emailVerified: boolean;
  id: string;
};

type CreateAdminAccount = (input: {
  email: string;
  name: string;
  password: string;
}) => Promise<{ userId: string }>;

type CompleteSetupOptions = {
  /**
   * Creates the administrator's account through the auth library. Passed in
   * so this module does not depend on the auth setup (and can be tested).
   */
  createAdminAccount: CreateAdminAccount;
  database?: DbPool;
  env?: EnvSource;
  sessionUser?: SetupSessionUser | null;
};

export type CompleteSetupResult =
  | { mode: "create"; email: string; userId: string }
  | { mode: "claim"; email: string; userId: string };

const organizationNameSchema = z.string().trim().min(1).max(120);
const optionalEmailSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  emailSchema.optional(),
);

const baseSetupSchema = z.object({
  organizationName: organizationNameSchema,
  senderAddress: optionalEmailSchema,
  setupToken: z.string().max(512).optional(),
  // Whether one is needed depends on what is saved already, which is only
  // known once the database has been read.
  supportAddress: optionalEmailSchema,
});

const createAccountSchema = z.object({
  email: emailSchema,
  fullName: nameSchema,
  password: z.string().min(15).max(128),
});

const FIELD_MESSAGES: Record<SetupFieldName, string> = {
  email: "Enter a valid email address",
  fullName: "Enter your full name",
  organizationName: "Enter the name of your organization",
  password: "Password must be at least 15 characters",
  senderAddress: "Enter a valid email address, or leave this empty",
  setupToken: "Enter the setup token",
  supportAddress: "Enter an email address people can write to for help",
};

function toFieldErrors(error: z.ZodError) {
  const fieldErrors: Partial<Record<SetupFieldName, string>> = {};

  for (const issue of error.issues) {
    const field = issue.path[0];

    if (typeof field === "string" && field in FIELD_MESSAGES) {
      fieldErrors[field as SetupFieldName] ??=
        FIELD_MESSAGES[field as SetupFieldName];
    }
  }

  return fieldErrors;
}

function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }

  // Hashing first makes both sides the same length, which timingSafeEqual
  // requires, without revealing how long the real token is.
  const providedDigest = createHash("sha256").update(provided.trim()).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Whether setup still has to be given a support address: not when
 * SUPPORT_EMAIL sets it for this deployment, and not when one is saved.
 */
function needsSupportAddress(
  storedSupportAddress: string | null,
  env: EnvSource,
): boolean {
  return (
    getEnv(env).email.supportAddress === undefined && !storedSupportAddress
  );
}

/** Whether setup can be claimed right now, and what the page should ask for. */
export function resolveSetupView(
  state: SetupState,
  {
    env = process.env,
    sessionUser = null,
    storedSupportAddress = null,
  }: {
    env?: EnvSource;
    sessionUser?: SetupSessionUser | null;
    /** The support address in the settings row, if there is one. */
    storedSupportAddress?: string | null;
  } = {},
): SetupView {
  const appEnv = getEnv(env);
  const tokenConfigured = appEnv.setup.token !== undefined;
  const asksForSupportAddress = needsSupportAddress(storedSupportAddress, env);

  if (state.status === "complete") {
    return { view: "complete" };
  }

  if (state.status === "unmigrated") {
    return { view: "unmigrated" };
  }

  if (state.status === "fresh") {
    return {
      asksForSupportAddress,
      requiresToken: tokenConfigured,
      senderAddressFromEnv: appEnv.email.senderAddress !== undefined,
      view: "create",
    };
  }

  return {
    asksForSupportAddress,
    signedInEmail: sessionUser?.email ?? null,
    tokenConfigured,
    view: "claim",
  };
}

function assertSetupToken(
  state: SetupState,
  providedToken: string | undefined,
  env: EnvSource,
) {
  const expectedToken = getEnv(env).setup.token;

  if (state.status === "unclaimed" && expectedToken === undefined) {
    throw new SetupError(
      "This site already has accounts. Set the SETUP_TOKEN environment variable and redeploy to choose its administrator.",
      403,
    );
  }

  if (
    expectedToken !== undefined &&
    !tokensMatch(providedToken, expectedToken)
  ) {
    throw new SetupError("The setup token is not correct.", 403, {
      setupToken: "This is not the setup token for this site",
    });
  }
}

/**
 * Runs first-run setup. Everything that decides who becomes administrator
 * happens inside one transaction under a lock, after the state has been read
 * again, so a second request that arrives at the same moment finds setup
 * already complete.
 */
export async function completeSetup(
  rawInput: unknown,
  {
    createAdminAccount,
    database = getDb(),
    env = process.env,
    sessionUser = null,
  }: CompleteSetupOptions,
): Promise<CompleteSetupResult> {
  const parsedBase = baseSetupSchema.safeParse(rawInput);

  if (!parsedBase.success) {
    throw new SetupError(
      "Check the highlighted fields.",
      400,
      toFieldErrors(parsedBase.error),
    );
  }

  const base = parsedBase.data;
  // Set from inside the transaction callback, read again if it fails.
  const created: { userId: string | null } = { userId: null };

  try {
    const result = await withTransaction(async (tx) => {
      // Taken without waiting. A submission that waited would sit on a
      // database connection for as long as the one ahead of it runs, and
      // that one needs a second connection to create the account. Enough
      // of them waiting would leave it none.
      const lock = await tx.query<{ locked: boolean }>(
        "select pg_try_advisory_xact_lock($1) as locked",
        [SETUP_ADVISORY_LOCK_ID],
      );

      if (lock.rows[0]?.locked !== true) {
        throw new SetupError(
          "Setup is already running. Try again in a moment.",
          409,
        );
      }

      const state = await readSetupState(tx);

      if (state.status === "complete") {
        throw new SetupError("This site has already been set up.", 409);
      }

      if (state.status === "unmigrated") {
        throw new SetupError(
          "The database is not ready yet. Deploy again so the tables can be created.",
          503,
        );
      }

      assertSetupToken(state, base.setupToken, env);

      const now = Math.floor(Date.now() / 1000);
      const stored = await readStoredSettings(tx);
      const settingsUpdate: SettingsUpdate = {
        organizationName: base.organizationName,
        setupCompletedAt: now,
      };

      if (base.senderAddress !== undefined) {
        settingsUpdate.senderAddress = base.senderAddress.toLowerCase();
      }

      // The one given now, or else the one this install already has. It is
      // never guessed: not the administrator's own address, and not one
      // written into the code.
      const supportAddress =
        base.supportAddress?.toLowerCase() ?? stored?.supportAddress ?? null;
      const supportAddressErrors: Partial<Record<SetupFieldName, string>> =
        needsSupportAddress(supportAddress, env)
          ? { supportAddress: FIELD_MESSAGES.supportAddress }
          : {};

      if (state.status === "fresh") {
        const parsedAccount = createAccountSchema.safeParse(rawInput);

        // Refused here, before any account exists.
        if (!parsedAccount.success || supportAddressErrors.supportAddress) {
          throw new SetupError("Check the highlighted fields.", 400, {
            ...(parsedAccount.success
              ? {}
              : toFieldErrors(parsedAccount.error)),
            ...supportAddressErrors,
          });
        }

        const account = parsedAccount.data;
        const email = account.email.toLowerCase();

        // The account below is created on its own connection, so it can be
        // seen before this transaction commits. Sign-up is closed first,
        // also outside the transaction, so nobody else can register while
        // an account exists and the rule chosen here has not landed yet.
        await closeSignupUntilSetupFinishes(database);

        const { userId } = await createAdminAccount({
          email,
          name: account.fullName,
          password: account.password,
        });

        created.userId = userId;

        // The account is verified here because email cannot work before
        // setup has finished, and there is nobody else to vouch for it.
        const promoted = await tx.query(
          `
            update public."user"
            set role = 'admin', "emailVerified" = true, "updatedAt" = now()
            where id = $1
          `,
          [userId],
        );

        if (promoted.rowCount !== 1) {
          throw new SetupError(
            "The administrator account was not created.",
            500,
          );
        }

        // A hosted service takes sign-ups from anyone. Any other install
        // starts with the administrator's own email domain, or closed when
        // that domain is a public mailbox provider.
        const signupPolicy = isHostedMode(env)
          ? { allowedEmailDomains: [], signupMode: "open" as const }
          : suggestSignupPolicy(email);

        await saveSettings(
          {
            ...settingsUpdate,
            allowedEmailDomains: [...signupPolicy.allowedEmailDomains],
            signupMode: signupPolicy.signupMode,
            supportAddress,
          },
          tx,
        );

        return { email, mode: "create" as const, userId };
      }

      if (!sessionUser) {
        throw new SetupError(
          "Sign in with the account that should become the administrator, then open this page again.",
          401,
        );
      }

      if (!sessionUser.emailVerified) {
        throw new SetupError(
          "Verify your email address before becoming the administrator.",
          403,
        );
      }

      if (supportAddressErrors.supportAddress) {
        throw new SetupError(
          "Check the highlighted fields.",
          400,
          supportAddressErrors,
        );
      }

      const promoted = await tx.query(
        `update public."user" set role = 'admin', "updatedAt" = now() where id = $1`,
        [sessionUser.id],
      );

      if (promoted.rowCount !== 1) {
        throw new SetupError("Your account was not found.", 404);
      }

      // An install that already has accounts keeps the sign-up rule it has
      // been running with (open, if it never had one) until the new
      // administrator changes it.
      await saveSettings(
        {
          ...settingsUpdate,
          ...(stored
            ? {}
            : { allowedEmailDomains: [], signupMode: "open" as const }),
          supportAddress,
        },
        tx,
      );

      return {
        email: sessionUser.email,
        mode: "claim" as const,
        userId: sessionUser.id,
      };
    }, database);

    invalidateSettingsCache();

    return result;
  } catch (error) {
    // The account is created on its own connection, so it survives a
    // rollback here. Left behind, it would make the install look claimed.
    if (created.userId) {
      await database
        .query(`delete from public."user" where id = $1 and role <> 'admin'`, [
          created.userId,
        ])
        .catch(() => undefined);
    }

    invalidateSettingsCache();

    throw error;
  }
}

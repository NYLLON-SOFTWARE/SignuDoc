import { buildBranding, type Branding } from "./branding.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  evaluateSignup,
  type SignupDecision,
  type SignupMode,
  type SignupPolicy,
} from "./signup-policy.ts";
import { getEnv, isHostedMode, type EnvSource } from "./utils/env.ts";

// Install-wide settings: one row in app_settings, written by the first-run
// setup page and by an administrator in Settings.
//
// Environment variables win over the row (RESEND_FROM_EMAIL, SUPPORT_EMAIL),
// so a deployment that was configured that way before settings existed keeps
// working without anyone touching it.

/** What is stored. Null means "not set". */
export type AppSettings = {
  allowedEmailDomains: string[];
  /** The install's own color as "#rrggbb", or null for the default. */
  brandColor: string | null;
  emailReadyAt: number | null;
  /**
   * A short hash of the install's logo, or null when it has none. The logo
   * itself is read and written in brand-logo.ts, never here.
   */
  logoVersion: string | null;
  organizationName: string | null;
  /**
   * Part 11 mode: signers sign with their own verified accounts, give the
   * meaning of each signature, and records are never deleted on a timer.
   * See part11.ts.
   */
  part11Mode: boolean;
  privacyUrl: string | null;
  /**
   * Days a finished envelope is kept before the nightly job deletes it, or
   * null to keep finished envelopes until someone deletes them.
   */
  retentionDays: number | null;
  senderAddress: string | null;
  setupCompletedAt: number | null;
  signupMode: SignupMode;
  supportAddress: string | null;
  termsUrl: string | null;
};

/** What the app should use: the stored row with environment overrides applied. */
export type ResolvedSettings = AppSettings & {
  hosted: boolean;
  senderAddressFromEnv: boolean;
  supportAddressFromEnv: boolean;
};

export type SettingsUpdate = Partial<Omit<AppSettings, "logoVersion">>;

/**
 * Where an install stands on first-run setup.
 *
 * - complete: someone is the administrator.
 * - fresh: nobody has an account and setup has never run. The first visitor
 *   may claim the install.
 * - unclaimed: accounts exist (or setup ran once) but nobody is the
 *   administrator. Claiming it needs SETUP_TOKEN.
 * - unmigrated: the database does not have this version's tables yet.
 */
export type SetupState = {
  status: "complete" | "fresh" | "unclaimed" | "unmigrated";
};

/** The answer to a sign-up attempt on an install nobody has set up yet. */
export type SetupRequiredDecision = {
  allowed: false;
  code: "setup_required";
  message: string;
};

type AppSettingsRow = {
  allowed_email_domains: string[] | null;
  brand_color: string | null;
  email_ready_at: number | null;
  logo_hash: string | null;
  organization_name: string | null;
  part11_mode: boolean;
  privacy_url: string | null;
  retention_days: number | null;
  sender_address: string | null;
  setup_completed_at: number | null;
  signup_mode: SignupMode;
  support_address: string | null;
  terms_url: string | null;
};

// The columns the settings table was created with, who may sign up among
// them.
const FIRST_SETTINGS_COLUMNS = [
  "allowed_email_domains",
  "email_ready_at",
  "organization_name",
  "privacy_url",
  "sender_address",
  "setup_completed_at",
  "signup_mode",
  "support_address",
  "terms_url",
] as const;

// What each migration since has added, oldest first. A database that is
// behind this version is read in the newest of these shapes it has, so
// what it does hold still counts. A migration that adds a column the app
// reads adds a line here.
const LATER_SETTINGS_COLUMNS = [
  ["retention_days"], // 20261113090000_signature_evidence
  ["brand_color", "logo_hash"], // 20261114120000_branding
  ["part11_mode"], // 20261115090000_part11_mode
] as const;

type LaterSettingsColumn = (typeof LATER_SETTINGS_COLUMNS)[number][number];

/** A row read from a table that may not have every later column yet. */
type StoredSettingsRow = Omit<AppSettingsRow, LaterSettingsColumn> &
  Partial<Pick<AppSettingsRow, LaterSettingsColumn>>;

/** The columns of the table after this many of the later migrations. */
function settingsColumnsAfter(laterMigrations: number): string {
  return [
    ...FIRST_SETTINGS_COLUMNS,
    ...LATER_SETTINGS_COLUMNS.slice(0, laterMigrations).flat(),
  ].join(", ");
}

const SETTINGS_COLUMNS = settingsColumnsAfter(LATER_SETTINGS_COLUMNS.length);

// How an install behaves before it has a settings row. This is what the app
// did before settings existed, so an upgraded deployment does not change
// until someone decides otherwise.
const UNSET_SETTINGS: AppSettings = {
  allowedEmailDomains: [],
  brandColor: null,
  emailReadyAt: null,
  logoVersion: null,
  organizationName: null,
  part11Mode: false,
  privacyUrl: null,
  retentionDays: null,
  senderAddress: null,
  setupCompletedAt: null,
  signupMode: "open",
  supportAddress: null,
  termsUrl: null,
};

// Other instances pick up a change within this time; the instance that made
// the change sees it at once.
const SETTINGS_CACHE_MS = 30_000;
const SETUP_COMPLETE_CACHE_MS = 60_000;

type SettingsCache = {
  settings: { expiresAt: number; value: AppSettings | null } | null;
  setupCompleteUntil: number;
};

declare global {
  var __signudocSettingsCache: SettingsCache | undefined;
}

// Kept on globalThis, like the rate limit store, so every copy of this
// module in one process shares it and a change clears it for all of them.
const cache: SettingsCache = (globalThis.__signudocSettingsCache ??= {
  settings: null,
  setupCompleteUntil: 0,
});

export function invalidateSettingsCache() {
  cache.settings = null;
  cache.setupCompleteUntil = 0;
}

/**
 * True when a query failed because a table or column from a newer migration
 * is not there. That happens on a preview deployment that shares a database
 * with production, and on a first deployment whose build ran before the
 * database was connected.
 */
export function isMissingSchemaError(error: unknown): boolean {
  const code = readErrorCode(error);

  return code === "42P01" || code === "42703";
}

/** The table is there, but a column this version reads is not. */
function isMissingColumnError(error: unknown): boolean {
  return readErrorCode(error) === "42703";
}

function readErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function mapSettingsRow(row: StoredSettingsRow): AppSettings {
  return {
    allowedEmailDomains: row.allowed_email_domains ?? [],
    brandColor: row.brand_color ?? null,
    emailReadyAt: row.email_ready_at,
    logoVersion: row.logo_hash ?? null,
    organizationName: row.organization_name,
    part11Mode: row.part11_mode ?? false,
    privacyUrl: row.privacy_url,
    retentionDays: row.retention_days ?? null,
    senderAddress: row.sender_address,
    setupCompletedAt: row.setup_completed_at,
    signupMode: row.signup_mode,
    supportAddress: row.support_address,
    termsUrl: row.terms_url,
  };
}

/**
 * Reads the stored row. Null when there is none (or no table for it yet).
 *
 * A table that is there but behind this version, because a migration has
 * not run, is read in the newest shape it does have, and what it lacks is
 * taken as not set. Taking it for "no row" would swap the sign-up rule an
 * administrator chose for the open default of an install that never had
 * settings, and drop the retention period along with it.
 */
export async function readStoredSettings(
  database: DbExecutor = getDb(),
): Promise<AppSettings | null> {
  const newest = LATER_SETTINGS_COLUMNS.length;

  for (let laterMigrations = newest; ; laterMigrations -= 1) {
    try {
      const row = await queryOne<StoredSettingsRow>(
        database,
        `select ${settingsColumnsAfter(laterMigrations)} from public.app_settings where id`,
      );

      return row ? mapSettingsRow(row) : null;
    } catch (error) {
      // One migration further back. Past the table as it was created there
      // is nothing left to try.
      if (isMissingColumnError(error) && laterMigrations > 0) {
        continue;
      }

      if (laterMigrations === newest && isMissingSchemaError(error)) {
        return null;
      }

      // Anything else reaches the caller, and so does a second failure
      // (inside a transaction, the first one has already ended it). Nobody
      // is let in on the strength of a guess.
      throw error;
    }
  }
}

async function getStoredSettings(): Promise<AppSettings | null> {
  const now = Date.now();

  if (cache.settings && cache.settings.expiresAt > now) {
    return cache.settings.value;
  }

  const value = await readStoredSettings();

  cache.settings = { expiresAt: now + SETTINGS_CACHE_MS, value };

  return value;
}

export function resolveSettings(
  stored: AppSettings | null,
  env: EnvSource = process.env,
): ResolvedSettings {
  const emailEnv = getEnv(env).email;
  const settings = stored ?? UNSET_SETTINGS;

  return {
    ...settings,
    hosted: isHostedMode(env),
    senderAddress: emailEnv.senderAddress ?? settings.senderAddress,
    senderAddressFromEnv: emailEnv.senderAddress !== undefined,
    supportAddress: emailEnv.supportAddress ?? settings.supportAddress,
    supportAddressFromEnv: emailEnv.supportAddress !== undefined,
  };
}

/** The settings the app should use right now. Cached for a short time. */
export async function getSettings(
  env: EnvSource = process.env,
): Promise<ResolvedSettings> {
  return resolveSettings(await getStoredSettings(), env);
}

/** What this install calls itself, for pages and emails. */
export async function getBranding(
  env: EnvSource = process.env,
): Promise<Branding> {
  return buildBranding(await getSettings(env));
}

export function toSignupPolicy(settings: AppSettings): SignupPolicy {
  return {
    allowedEmailDomains: settings.allowedEmailDomains,
    signupMode: settings.signupMode,
  };
}

/**
 * Writes settings, creating the row if there is none. Only the fields given
 * are changed. Changing the sender address clears the "email works" mark,
 * because that mark was earned by the old address.
 */
export async function saveSettings(
  update: SettingsUpdate,
  database: DbExecutor = getDb(),
): Promise<AppSettings> {
  // Read and write under the row's lock, so a save of some fields never
  // writes back a stale value of another (Part 11 mode above all) that a
  // different writer changed in between.
  if ("connect" in database && "totalCount" in database) {
    return withTransaction(
      (client) => saveSettingsLocked(update, client),
      database as DbPool,
    );
  }

  return saveSettingsLocked(update, database);
}

async function saveSettingsLocked(
  update: SettingsUpdate,
  database: DbExecutor,
): Promise<AppSettings> {
  await database.query(`SELECT id FROM app_settings WHERE id FOR UPDATE`);

  const current = (await readStoredSettings(database)) ?? {
    ...UNSET_SETTINGS,
    // A row that is being created is a decision about this install, and the
    // safe starting point for sign-up is closed, not open.
    signupMode: "closed" as const,
  };
  const next: AppSettings = { ...current, ...update };

  if (
    update.senderAddress !== undefined &&
    update.senderAddress !== current.senderAddress &&
    update.emailReadyAt === undefined
  ) {
    next.emailReadyAt = null;
  }

  const now = Math.floor(Date.now() / 1000);
  const row = await queryOne<AppSettingsRow>(
    database,
    `
      insert into public.app_settings (
        id,
        allowed_email_domains,
        email_ready_at,
        organization_name,
        privacy_url,
        sender_address,
        setup_completed_at,
        signup_mode,
        support_address,
        terms_url,
        retention_days,
        brand_color,
        part11_mode,
        created_at,
        updated_at
      )
      values (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $12, $13, $10, $10)
      on conflict (id) do update set
        allowed_email_domains = excluded.allowed_email_domains,
        email_ready_at = excluded.email_ready_at,
        organization_name = excluded.organization_name,
        privacy_url = excluded.privacy_url,
        sender_address = excluded.sender_address,
        setup_completed_at = excluded.setup_completed_at,
        signup_mode = excluded.signup_mode,
        support_address = excluded.support_address,
        terms_url = excluded.terms_url,
        retention_days = excluded.retention_days,
        brand_color = excluded.brand_color,
        part11_mode = excluded.part11_mode,
        updated_at = excluded.updated_at
      returning ${SETTINGS_COLUMNS}
    `,
    [
      next.allowedEmailDomains,
      next.emailReadyAt,
      next.organizationName,
      next.privacyUrl,
      next.senderAddress,
      next.setupCompletedAt,
      next.signupMode,
      next.supportAddress,
      next.termsUrl,
      now,
      next.retentionDays,
      next.brandColor,
      next.part11Mode,
    ],
  );

  invalidateSettingsCache();

  return row ? mapSettingsRow(row) : next;
}

/** The sender address a check or a test email was made with. */
export type CheckedSender = Pick<
  ResolvedSettings,
  "senderAddress" | "senderAddressFromEnv"
>;

/**
 * Records whether email has been seen working from the sender address that
 * was checked. Only touches an existing row: noticing that email works is
 * not a reason to create settings nobody chose.
 *
 * A check talks to the email provider and can take a while. If an
 * administrator saves a different sender address in the meantime, the
 * result belongs to the old address and is dropped, so it cannot vouch for
 * one that was never tried. An address fixed by the environment cannot
 * change under a running check, so there is nothing to compare.
 */
export async function markEmailReady(
  ready: boolean,
  checked: CheckedSender,
  database: DbExecutor = getDb(),
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      update public.app_settings
      set email_ready_at = $1, updated_at = $2
      where id
        and (email_ready_at is null) = $3
        and ($4::boolean or sender_address is not distinct from $5)
    `,
    [
      ready ? now : null,
      now,
      ready,
      checked.senderAddressFromEnv,
      checked.senderAddressFromEnv ? null : checked.senderAddress,
    ],
  );

  invalidateSettingsCache();
}

/**
 * Closes sign-up on an install that has no stored rule yet, and leaves an
 * existing rule alone.
 *
 * First-run setup calls this just before it creates the administrator's
 * account. That account is created on its own connection and so can be seen
 * before setup's transaction commits; without a stored rule, an install
 * with an account counts as open to anyone. With this row in place nobody
 * else can register in that gap, or after a setup that failed halfway.
 */
export async function closeSignupUntilSetupFinishes(
  database: DbExecutor = getDb(),
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      insert into public.app_settings (id, signup_mode, created_at, updated_at)
      values (true, 'closed', $1, $1)
      on conflict (id) do nothing
    `,
    [now],
  );

  invalidateSettingsCache();
}

type SetupStateRow = {
  has_admin: boolean;
  has_users: boolean;
  setup_completed_at: number | null;
};

/** Reads the setup state straight from the database, with no caching. */
export async function readSetupState(
  database: DbExecutor = getDb(),
): Promise<SetupState> {
  try {
    const row = await queryOne<SetupStateRow>(
      database,
      `
        select
          exists (select 1 from public."user" where role = 'admin') as has_admin,
          exists (select 1 from public."user") as has_users,
          (select setup_completed_at from public.app_settings where id)
            as setup_completed_at
      `,
    );

    if (row?.has_admin) {
      return { status: "complete" };
    }

    if (!row?.has_users && (row?.setup_completed_at ?? null) === null) {
      return { status: "fresh" };
    }

    return { status: "unclaimed" };
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { status: "unmigrated" };
    }

    throw error;
  }
}

/**
 * Where this install stands on first-run setup. "Complete" is remembered for
 * a minute, so pages on a set-up install do not ask the database every time.
 */
export async function getSetupState(): Promise<SetupState> {
  if (cache.setupCompleteUntil > Date.now()) {
    return { status: "complete" };
  }

  const state = await readSetupState();

  if (state.status === "complete") {
    cache.setupCompleteUntil = Date.now() + SETUP_COMPLETE_CACHE_MS;
  }

  return state;
}

/**
 * Applies this install's sign-up rule to one email address. Before first-run
 * setup has happened nobody can sign up at all: the first account is the
 * administrator's, and only the setup page creates it.
 *
 * The rule is read from the database every time rather than from the short
 * cache the pages use. Sign-ups are rare, and a rule that an administrator
 * (or setup) has just saved has to hold at once on every instance, not
 * thirty seconds later.
 */
export async function evaluateSignupRequest(
  email: string,
  env: EnvSource = process.env,
  database: DbExecutor = getDb(),
): Promise<SignupDecision | SetupRequiredDecision> {
  const setupState =
    cache.setupCompleteUntil > Date.now()
      ? ({ status: "complete" } as const)
      : await readSetupState(database);

  if (setupState.status === "fresh") {
    return {
      allowed: false,
      code: "setup_required",
      message: "This site has not been set up yet.",
    };
  }

  return evaluateSignup(
    email,
    resolveSettings(await readStoredSettings(database), env),
  );
}

/** True when every visitor should be sent to the setup page. */
export async function isFreshInstall(): Promise<boolean> {
  return (await getSetupState()).status === "fresh";
}

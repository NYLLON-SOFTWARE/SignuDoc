import { z } from "zod";

import { normalizeBrandColor } from "./brand-color.ts";
import { buildBrandLogoPath } from "./branding.ts";
import { getDb, type DbExecutor } from "./db/connection.ts";
import { emailSchema } from "./schemas/common.ts";
import {
  saveSettings,
  type AppSettings,
  type ResolvedSettings,
} from "./settings.ts";
import { parseEmailDomainList, SIGNUP_MODES } from "./signup-policy.ts";

// What an administrator can change on the Organization tab in Settings.

export type OrganizationSettingsField =
  | "allowedEmailDomains"
  | "brandColor"
  | "organizationName"
  | "privacyUrl"
  | "retentionDays"
  | "senderAddress"
  | "signupMode"
  | "supportAddress"
  | "termsUrl";

export class OrganizationSettingsError extends Error {
  readonly fieldErrors: Partial<Record<OrganizationSettingsField, string>>;

  constructor(fieldErrors: Partial<Record<OrganizationSettingsField, string>>) {
    super("Check the highlighted fields.");
    this.name = "OrganizationSettingsError";
    this.fieldErrors = fieldErrors;
  }
}

/** The values the Organization form shows and sends back. */
export type OrganizationSettingsView = {
  allowedEmailDomains: string;
  /** "#rrggbb", or empty for the default color. */
  brandColor: string;
  hosted: boolean;
  /** Part 11 mode is on: the retention period cannot be set. */
  part11Mode: boolean;
  /** Where the logo is served, or null when there is none. */
  logoUrl: string | null;
  organizationName: string;
  privacyUrl: string;
  /** Days, as typed. Empty keeps finished envelopes until deleted by hand. */
  retentionDays: string;
  senderAddress: string;
  senderAddressFromEnv: boolean;
  signupMode: AppSettings["signupMode"];
  supportAddress: string;
  supportAddressFromEnv: boolean;
  termsUrl: string;
};

export function toOrganizationSettingsView(
  settings: ResolvedSettings,
): OrganizationSettingsView {
  return {
    allowedEmailDomains: settings.allowedEmailDomains.join(", "),
    brandColor: settings.brandColor ?? "",
    hosted: settings.hosted,
    logoUrl:
      settings.logoVersion === null
        ? null
        : buildBrandLogoPath(settings.logoVersion),
    organizationName: settings.organizationName ?? "",
    part11Mode: settings.part11Mode,
    privacyUrl: settings.privacyUrl ?? "",
    retentionDays:
      settings.retentionDays === null ? "" : String(settings.retentionDays),
    senderAddress: settings.senderAddress ?? "",
    senderAddressFromEnv: settings.senderAddressFromEnv,
    signupMode: settings.signupMode,
    supportAddress: settings.supportAddress ?? "",
    supportAddressFromEnv: settings.supportAddressFromEnv,
    termsUrl: settings.termsUrl ?? "",
  };
}

function blankToNull(value: unknown): unknown {
  return typeof value === "string" && value.trim().length === 0 ? null : value;
}

const optionalEmail = z.preprocess(blankToNull, emailSchema.nullable());
const optionalWebUrl = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);

        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    })
    .nullable(),
);

// Stored as "#rrggbb" whatever way it was typed. Empty means the default.
const optionalBrandColor = z.preprocess(
  blankToNull,
  z
    .string()
    .max(16)
    .transform((value, context) => {
      const color = normalizeBrandColor(value);

      if (!color) {
        context.addIssue({ code: "custom", message: "Not a color" });

        return z.NEVER;
      }

      return color;
    })
    .nullable(),
);

const organizationSettingsSchema = z.object({
  allowedEmailDomains: z.string().max(4000).default(""),
  brandColor: optionalBrandColor.default(null),
  organizationName: z.string().trim().min(1).max(120),
  privacyUrl: optionalWebUrl.default(null),
  retentionDays: z
    .preprocess((value) => {
      const blank = blankToNull(value);

      return typeof blank === "string" ? Number(blank) : blank;
    }, z.number().int().min(30).max(36_500).nullable())
    .default(null),
  senderAddress: optionalEmail.default(null),
  signupMode: z.enum(SIGNUP_MODES),
  supportAddress: optionalEmail.default(null),
  termsUrl: optionalWebUrl.default(null),
});

const FIELD_MESSAGES: Record<OrganizationSettingsField, string> = {
  allowedEmailDomains: "Enter one or more domains, such as yourcompany.com",
  brandColor: "Enter a color as six letters and digits, such as #1a73e8",
  organizationName: "Enter the name of your organization",
  privacyUrl: "Enter a full web address starting with https://",
  retentionDays: "Enter a number of days, 30 or more, or leave this empty",
  senderAddress: "Enter a valid email address, or leave this empty",
  signupMode: "Choose who can create an account",
  supportAddress: "Enter an email address people can write to for help",
  termsUrl: "Enter a full web address starting with https://",
};

/**
 * Drops the fields the form shows but cannot change, before anything is
 * checked. The form sends them back as displayed, and a value fixed by the
 * environment need not pass the form's rules: RESEND_FROM_EMAIL may carry a
 * display name ("Acme <sign@acme.com>"), which is not a bare address.
 */
function withoutLockedFields(
  rawInput: unknown,
  current: ResolvedSettings,
): unknown {
  if (typeof rawInput !== "object" || rawInput === null) {
    return rawInput;
  }

  const input: Record<string, unknown> = { ...rawInput };

  if (current.senderAddressFromEnv) {
    delete input.senderAddress;
  }

  if (current.supportAddressFromEnv) {
    delete input.supportAddress;
  }

  if (current.hosted) {
    delete input.brandColor;
    delete input.privacyUrl;
    delete input.termsUrl;
  }

  return input;
}

/**
 * Validates and saves the Organization form. Addresses that are fixed by an
 * environment variable are left as they are stored, since the stored value
 * is not the one in use.
 */
export async function updateOrganizationSettings(
  rawInput: unknown,
  current: ResolvedSettings,
  database: DbExecutor = getDb(),
): Promise<AppSettings> {
  const parsed = organizationSettingsSchema.safeParse(
    withoutLockedFields(rawInput, current),
  );
  const fieldErrors: Partial<Record<OrganizationSettingsField, string>> = {};

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];

      if (typeof field === "string" && field in FIELD_MESSAGES) {
        fieldErrors[field as OrganizationSettingsField] ??=
          FIELD_MESSAGES[field as OrganizationSettingsField];
      }
    }

    throw new OrganizationSettingsError(fieldErrors);
  }

  const input = parsed.data;
  // The list of domains only means something, and is only shown, when
  // sign-up is limited to domains. Under any other rule the stored list is
  // kept as it is, and whatever was left in the hidden field is not judged.
  const domainRule = input.signupMode === "domains";
  const { domains, invalid } = parseEmailDomainList(
    domainRule ? input.allowedEmailDomains : "",
  );

  if (invalid.length > 0) {
    fieldErrors.allowedEmailDomains = `Not a domain: ${invalid.slice(0, 3).join(", ")}`;
  } else if (domainRule && domains.length === 0) {
    fieldErrors.allowedEmailDomains = FIELD_MESSAGES.allowedEmailDomains;
  }

  // Setup does not finish without a support address, and it cannot be
  // taken away afterwards: signers are told to write to it. An install
  // whose address comes from SUPPORT_EMAIL has one whatever is stored.
  if (!current.supportAddressFromEnv && input.supportAddress === null) {
    fieldErrors.supportAddress = FIELD_MESSAGES.supportAddress;
  }

  // Part 11 records are never deleted on a timer.
  if (current.part11Mode && input.retentionDays !== null) {
    fieldErrors.retentionDays =
      "Part 11 mode is on, so finished envelopes are kept until you delete them. Leave this empty.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new OrganizationSettingsError(fieldErrors);
  }

  return saveSettings(
    {
      ...(domainRule ? { allowedEmailDomains: domains } : {}),
      organizationName: input.organizationName,
      retentionDays: input.retentionDays,
      signupMode: input.signupMode,
      ...(current.hosted
        ? {}
        : {
            brandColor: input.brandColor,
            privacyUrl: input.privacyUrl,
            termsUrl: input.termsUrl,
          }),
      ...(current.senderAddressFromEnv
        ? {}
        : { senderAddress: input.senderAddress?.toLowerCase() ?? null }),
      ...(current.supportAddressFromEnv || input.supportAddress === null
        ? {}
        : { supportAddress: input.supportAddress.toLowerCase() }),
    },
    database,
  );
}

const AUDITED_SETTINGS = [
  "allowedEmailDomains",
  "brandColor",
  "organizationName",
  "privacyUrl",
  "retentionDays",
  "senderAddress",
  "signupMode",
  "supportAddress",
  "termsUrl",
] as const satisfies readonly (keyof AppSettings)[];

/** What changed between two versions of the settings, for the audit trail. */
export function diffSettings(
  before: AppSettings | null,
  after: AppSettings,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of AUDITED_SETTINGS) {
    const from = before ? before[key] : null;
    const to = after[key];

    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[key] = { from, to };
    }
  }

  return changes;
}

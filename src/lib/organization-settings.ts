import { z } from "zod";

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
  | "organizationName"
  | "privacyUrl"
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
  hosted: boolean;
  organizationName: string;
  privacyUrl: string;
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
    hosted: settings.hosted,
    organizationName: settings.organizationName ?? "",
    privacyUrl: settings.privacyUrl ?? "",
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

const organizationSettingsSchema = z.object({
  allowedEmailDomains: z.string().max(4000).default(""),
  organizationName: z.string().trim().min(1).max(120),
  privacyUrl: optionalWebUrl.default(null),
  senderAddress: optionalEmail.default(null),
  signupMode: z.enum(SIGNUP_MODES),
  supportAddress: optionalEmail.default(null),
  termsUrl: optionalWebUrl.default(null),
});

const FIELD_MESSAGES: Record<OrganizationSettingsField, string> = {
  allowedEmailDomains: "Enter one or more domains, such as yourcompany.com",
  organizationName: "Enter the name of your organization",
  privacyUrl: "Enter a full web address starting with https://",
  senderAddress: "Enter a valid email address, or leave this empty",
  signupMode: "Choose who can create an account",
  supportAddress: "Enter a valid email address, or leave this empty",
  termsUrl: "Enter a full web address starting with https://",
};

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
  const parsed = organizationSettingsSchema.safeParse(rawInput);
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
  const { domains, invalid } = parseEmailDomainList(input.allowedEmailDomains);

  if (invalid.length > 0) {
    fieldErrors.allowedEmailDomains = `Not a domain: ${invalid.slice(0, 3).join(", ")}`;
  } else if (input.signupMode === "domains" && domains.length === 0) {
    fieldErrors.allowedEmailDomains = FIELD_MESSAGES.allowedEmailDomains;
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new OrganizationSettingsError(fieldErrors);
  }

  return saveSettings(
    {
      allowedEmailDomains: domains,
      organizationName: input.organizationName,
      signupMode: input.signupMode,
      ...(current.hosted
        ? {}
        : { privacyUrl: input.privacyUrl, termsUrl: input.termsUrl }),
      ...(current.senderAddressFromEnv
        ? {}
        : { senderAddress: input.senderAddress?.toLowerCase() ?? null }),
      ...(current.supportAddressFromEnv
        ? {}
        : { supportAddress: input.supportAddress?.toLowerCase() ?? null }),
    },
    database,
  );
}

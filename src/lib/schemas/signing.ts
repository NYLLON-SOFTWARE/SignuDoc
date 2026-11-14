import { z } from "zod";

import { signatureMeanings } from "../types/domain.ts";
import { envelopePageSchema } from "./envelope.ts";
import { fieldInputMethodSchema, fieldTypeSchema } from "./field.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  idSchema,
  nameSchema,
  normalizedCoordinateSchema,
  normalizedSizeSchema,
  optionalTrimmedString,
  unixTimestampSchema,
} from "./common.ts";

export const signingUnavailableStateSchema = z.enum([
  "expired",
  "already-signed",
  "voided",
  "declined",
]);

const signingFieldBaseSchema = z.object({
  /** The group a radio button belongs to. */
  groupId: z.string().trim().min(1).optional(),
  height: normalizedSizeSchema,
  id: idSchema,
  label: optionalTrimmedString(120),
  /** The choices of a dropdown. */
  options: z.array(z.string().trim().min(1)).optional(),
  page: z.number().int().positive(),
  required: z.boolean(),
  signerId: idSchema,
  type: fieldTypeSchema,
  width: normalizedSizeSchema,
  x: normalizedCoordinateSchema,
  y: normalizedCoordinateSchema,
});

export const signingCurrentFieldSchema = signingFieldBaseSchema.extend({
  signerName: nameSchema,
});

export const signingVisibleFieldSchema = signingFieldBaseSchema.extend({
  checked: z.boolean().nullable().optional(),
  imageDataUrl: z.string().trim().min(1).nullable().optional(),
  inputMethod: fieldInputMethodSchema.nullable().optional(),
  signerName: nameSchema,
  submittedAt: unixTimestampSchema,
  value: optionalTrimmedString(5000).nullable().optional(),
});

export const signingDisclosureSchema = z.object({
  sections: z.array(
    z.object({
      heading: z.string().trim().min(1),
      text: z.string().trim().min(1),
    }),
  ),
  statement: z.string().trim().min(1),
  version: z.string().trim().min(1),
});

export const signingPayloadSchema = z.object({
  consentUrl: z.string().trim().min(1),
  consentedAt: unixTimestampSchema.nullable(),
  currentSignerFields: z.array(signingCurrentFieldSchema),
  disclosure: signingDisclosureSchema,
  declineUrl: z.string().trim().min(1),
  documentUrl: z.string().trim().min(1),
  envelopeId: idSchema,
  envelopeTitle: envelopeTitleSchema,
  pageCount: z.number().int().positive(),
  pages: z.array(envelopePageSchema),
  /**
   * Set for a Part 11 envelope: the signer gives their email address and
   * password again to sign, and confirms what the signature means.
   */
  part11: z
    .object({
      meaning: z.enum(signatureMeanings),
      meaningLabel: z.string().trim().min(1),
      meaningStatement: z.string().trim().min(1),
    })
    .nullable()
    .optional(),
  /**
   * Set when each signer signs with a certificate in their own name through
   * a signing provider: Finish takes the signer there instead of submitting.
   */
  providerSignature: z
    .object({
      level: z.enum(["advanced", "qualified"]),
      providerName: z.string().trim().min(1),
      startUrl: z.string().trim().min(1),
    })
    .nullable()
    .optional(),
  senderName: z.string().trim().min(1).max(320),
  signer: z.object({
    email: emailSchema,
    id: idSchema,
    name: nameSchema,
    order: z.number().int().positive(),
  }),
  state: z.literal("ready"),
  submitUrl: z.string().trim().min(1),
  visibleFields: z.array(signingVisibleFieldSchema),
});

export const signingSubmitResponseSchema = z.object({
  envelopeId: idSchema,
  redirectPath: z.string().trim().min(1),
  submittedAt: unixTimestampSchema,
});

export const signingDeclineResponseSchema = z.object({
  declinedAt: unixTimestampSchema,
  envelopeId: idSchema,
  state: z.literal("declined"),
});

export const signingUnavailableResponseSchema = z.object({
  error: z.string().trim().min(1),
  state: signingUnavailableStateSchema,
});

export const signingRouteResponseSchema = z.union([
  signingPayloadSchema,
  signingUnavailableResponseSchema,
]);

export type SigningCurrentField = z.infer<typeof signingCurrentFieldSchema>;
export type SigningVisibleField = z.infer<typeof signingVisibleFieldSchema>;
export type SigningPayload = z.infer<typeof signingPayloadSchema>;
export type SigningDisclosure = z.infer<typeof signingDisclosureSchema>;

export const signerCheckRequestSchema = z.discriminatedUnion("method", [
  z.object({
    code: z.string().trim().min(1).max(64),
    method: z.enum(["access_code", "email_code"]),
  }),
  // Part 11 envelopes: the signer's own account, by its email address and
  // password.
  z.object({
    email: z.string().trim().min(1).max(320),
    method: z.literal("account"),
    password: z.string().min(1).max(128),
  }),
]);

export const signerConsentRequestSchema = z.object({
  disclosureVersion: z.string().trim().min(1).max(40),
});

export type SigningVerificationState = {
  emailCodeSentAt: number | null;
  envelopeTitle: string;
  maskedEmail: string;
  pending: Array<"access_code" | "account" | "email_code">;
  required: Array<"access_code" | "account" | "email_code">;
  senderName: string;
};
export type SigningDeclineResponse = z.infer<
  typeof signingDeclineResponseSchema
>;
export type SigningSubmitResponse = z.infer<typeof signingSubmitResponseSchema>;
export type SigningUnavailableResponse = z.infer<
  typeof signingUnavailableResponseSchema
>;

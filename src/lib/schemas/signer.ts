import { z } from "zod";

import { MAX_SIGNERS_PER_ENVELOPE, signerStatuses } from "../types/domain.ts";
import {
  emailSchema,
  idSchema,
  nameSchema,
  optionalTrimmedString,
  unixTimestampSchema,
} from "./common.ts";

export const signerStatusSchema = z.enum(signerStatuses);
export const duplicateSignerEmailMessage =
  "Each signer must have a unique email address.";

export const draftSignerSchema = z.object({
  id: idSchema.optional(),
  envelopeId: idSchema.optional(),
  name: nameSchema,
  email: emailSchema,
  signOrder: z.number().int().positive().optional(),
  // Extra checks before signing. accessCode: a string sets it, null removes
  // it, and leaving it out keeps the code already saved.
  accessCode: z.string().trim().min(4).max(64).nullable().optional(),
  requireEmailCode: z.boolean().optional(),
});

export const signerListSchema = z
  .array(draftSignerSchema)
  .min(1)
  .max(MAX_SIGNERS_PER_ENVELOPE)
  .superRefine((signers, ctx) => {
    const emails = new Set<string>();
    const signOrders = new Set<number>();

    for (const [index, signer] of signers.entries()) {
      const normalizedEmail = signer.email.toLowerCase();

      if (emails.has(normalizedEmail)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: duplicateSignerEmailMessage,
          path: [index, "email"],
        });
      }

      emails.add(normalizedEmail);

      if (signer.signOrder === undefined) {
        continue;
      }

      if (signOrders.has(signer.signOrder)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer must have a unique routing order",
          path: [index, "signOrder"],
        });
      }

      signOrders.add(signer.signOrder);
    }
  });

export const replaceSignersSchema = z.object({
  signers: signerListSchema,
});

export const replaceSignersResponseSchema = z.object({
  envelopeId: idSchema,
  redirectPath: z.string().trim().min(1),
  signers: z.array(
    z.object({
      email: emailSchema,
      id: idSchema,
      hasAccessCode: z.boolean(),
      name: nameSchema,
      requireEmailCode: z.boolean(),
      signOrder: z.number().int().positive(),
    }),
  ),
  updatedAt: unixTimestampSchema,
});

export const signerRecordSchema = draftSignerSchema.extend({
  status: signerStatusSchema,
  signingTokenExpiresAt: unixTimestampSchema.nullable().optional(),
  signingTokenHash: z.string().trim().length(64).nullable().optional(),
  turnStartedAt: unixTimestampSchema.nullable().optional(),
  lastNotifiedAt: unixTimestampSchema.nullable().optional(),
  lastNudgedAt: unixTimestampSchema.nullable().optional(),
  signedAt: unixTimestampSchema.nullable().optional(),
  declinedAt: unixTimestampSchema.nullable().optional(),
  declineReason: optionalTrimmedString(1000).nullable().optional(),
  createdAt: unixTimestampSchema,
  updatedAt: unixTimestampSchema,
});

export const declineEnvelopeSchema = z.object({
  reason: optionalTrimmedString(1000),
});

export type DraftSigner = z.infer<typeof draftSignerSchema>;
export type ReplaceSignersInput = z.infer<typeof replaceSignersSchema>;
export type ReplaceSignersResponse = z.infer<
  typeof replaceSignersResponseSchema
>;
export type SignerRecord = z.infer<typeof signerRecordSchema>;
export type DeclineEnvelopeInput = z.infer<typeof declineEnvelopeSchema>;

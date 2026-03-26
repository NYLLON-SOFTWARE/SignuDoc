import { z } from "zod";

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
  height: normalizedSizeSchema,
  id: idSchema,
  label: optionalTrimmedString(120),
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

export const signingPayloadSchema = z.object({
  currentSignerFields: z.array(signingCurrentFieldSchema),
  declineUrl: z.string().trim().min(1),
  documentUrl: z.string().trim().min(1),
  envelopeId: idSchema,
  envelopeTitle: envelopeTitleSchema,
  pageCount: z.number().int().positive(),
  pages: z.array(envelopePageSchema),
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
export type SigningDeclineResponse = z.infer<
  typeof signingDeclineResponseSchema
>;
export type SigningSubmitResponse = z.infer<typeof signingSubmitResponseSchema>;
export type SigningUnavailableResponse = z.infer<
  typeof signingUnavailableResponseSchema
>;

import { z } from "zod";

import {
  auditActorTypes,
  auditEventTypes,
  downloadFileTypes,
  envelopeStatuses,
} from "../types/domain.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  idSchema,
  optionalTrimmedString,
  unixTimestampSchema,
} from "./common.ts";

const sourcePdfHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const envelopeStatusSchema = z.enum(envelopeStatuses);
export const downloadFileTypeSchema = z.enum(downloadFileTypes);
export const auditEventTypeSchema = z.enum(auditEventTypes);
export const auditActorTypeSchema = z.enum(auditActorTypes);

export const envelopeCreateResponseSchema = z.object({
  envelopeId: idSchema,
  pageCount: z.number().int().positive(),
  redirectPath: z.string().trim().min(1),
  sourcePdfFilename: z.string().trim().min(1).max(255),
  sourcePdfSizeBytes: z.number().int().positive(),
  title: envelopeTitleSchema,
});

export const sendEnvelopeResponseSchema = z.object({
  envelopeId: idSchema,
  notifiedSignerName: z.string().trim().min(1).max(160),
  redirectPath: z.string().trim().min(1),
  sentAt: unixTimestampSchema,
});

export const voidEnvelopeResponseSchema = z.object({
  envelopeId: idSchema,
  redirectPath: z.string().trim().min(1),
  voidedAt: unixTimestampSchema,
});

export const manualNudgeResponseSchema = z.object({
  envelopeId: idSchema,
  nextAvailableAt: unixTimestampSchema,
  nextAvailableAtLabel: z.string().trim().min(1),
  sentAt: unixTimestampSchema,
  signerId: idSchema,
  signerName: z.string().trim().min(1).max(160),
});

export const envelopeListFiltersSchema = z.object({
  status: envelopeStatusSchema.optional(),
  search: optionalTrimmedString(160),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const downloadRequestSchema = z.object({
  type: downloadFileTypeSchema,
});

export const envelopePageSchema = z.object({
  id: idSchema.optional(),
  envelopeId: idSchema.optional(),
  pageNumber: z.number().int().positive(),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
});

export const auditEventRecordSchema = z.object({
  id: idSchema,
  envelopeId: idSchema,
  event: auditEventTypeSchema,
  actorType: auditActorTypeSchema,
  actorEmail: emailSchema.nullable().optional(),
  ipAddress: z.string().trim().min(1).nullable().optional(),
  userAgent: z.string().trim().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: unixTimestampSchema,
});

export const envelopeRecordSchema = z.object({
  id: idSchema,
  userId: idSchema,
  title: envelopeTitleSchema,
  status: envelopeStatusSchema,
  sourcePdfKey: z.string().trim().min(1),
  sourcePdfFilename: z.string().trim().min(1).max(255),
  sourcePdfSizeBytes: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  signedPdfKey: z.string().trim().min(1).nullable().optional(),
  evidenceKey: z.string().trim().min(1).nullable().optional(),
  sourcePdfHash: sourcePdfHashSchema,
  sentAt: unixTimestampSchema.nullable().optional(),
  completedAt: unixTimestampSchema.nullable().optional(),
  declinedAt: unixTimestampSchema.nullable().optional(),
  voidedAt: unixTimestampSchema.nullable().optional(),
  createdAt: unixTimestampSchema,
  updatedAt: unixTimestampSchema,
});

export type CreateEnvelopeResponse = z.infer<
  typeof envelopeCreateResponseSchema
>;
export type SendEnvelopeResponse = z.infer<typeof sendEnvelopeResponseSchema>;
export type VoidEnvelopeResponse = z.infer<typeof voidEnvelopeResponseSchema>;
export type ManualNudgeResponse = z.infer<typeof manualNudgeResponseSchema>;
export type EnvelopeListFilters = z.infer<typeof envelopeListFiltersSchema>;
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;
export type EnvelopePageRecord = z.infer<typeof envelopePageSchema>;
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;
export type EnvelopeRecord = z.infer<typeof envelopeRecordSchema>;

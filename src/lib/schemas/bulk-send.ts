import { z } from "zod";

import {
  MAX_COPY_RECIPIENTS_PER_ENVELOPE,
  signatureMeanings,
} from "../types/domain.ts";
import { emailSchema, nameSchema } from "./common.ts";
import {
  deadlineDaysSchema,
  reminderIntervalDaysSchema,
  reminderScheduleSchema,
} from "./envelope.ts";
import { duplicateCopyRecipientEmailMessage } from "./signer.ts";

/** Enough for 200 rows with names, addresses and a title. */
export const MAX_BULK_SEND_CSV_CHARS = 512 * 1024;

/** Preview or send a template from a CSV of people. */
export const bulkSendRequestSchema = z.object({
  /**
   * Stable id for one confirm. A retry with the same key returns or
   * finishes the stored results instead of sending the list again.
   */
  batchKey: z.string().trim().min(1).max(64).optional(),
  confirm: z.boolean().optional(),
  copyRecipients: z
    .array(z.object({ email: emailSchema, name: nameSchema }))
    .max(MAX_COPY_RECIPIENTS_PER_ENVELOPE)
    // Every envelope gets the same copy list, so a repeated address would
    // fail on every row once its draft exists. Refuse it before the preview.
    .superRefine((recipients, ctx) => {
      const emails = new Set<string>();

      for (const [index, recipient] of recipients.entries()) {
        const email = recipient.email.toLowerCase();

        if (emails.has(email)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: duplicateCopyRecipientEmailMessage,
            path: [index, "email"],
          });
        }

        emails.add(email);
      }
    })
    .optional(),
  csv: z.string().min(1).max(MAX_BULK_SEND_CSV_CHARS),
  expiresInDays: deadlineDaysSchema.optional(),
  permittedUseConfirmed: z.boolean().optional(),
  reminderIntervalDays: reminderIntervalDaysSchema.optional(),
  reminderSchedule: reminderScheduleSchema.optional(),
  requireEmailCode: z.boolean().optional(),
  signatureMeaning: z.enum(signatureMeanings).nullable().optional(),
});

export type BulkSendRequest = z.infer<typeof bulkSendRequestSchema>;

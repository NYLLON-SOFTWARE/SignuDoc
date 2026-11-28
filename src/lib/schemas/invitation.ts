import { z } from "zod";

export const MAX_INVITATION_SUBJECT_LENGTH = 160;
export const MAX_INVITATION_MESSAGE_LENGTH = 2000;

export type InvitationCopy = {
  subject: string | null;
  message: string | null;
};

const subjectSchema = z
  .string()
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u, "Enter a single-line email subject.")
  .trim()
  .max(MAX_INVITATION_SUBJECT_LENGTH)
  .transform((value) => value || null);

const messageSchema = z
  .string()
  .refine((value) => !value.includes("\u0000"), "Enter a valid email message.")
  .trim()
  .max(MAX_INVITATION_MESSAGE_LENGTH)
  .transform((value) => value || null);

export const invitationCopySchema = z.object({
  subject: subjectSchema.nullish(),
  message: messageSchema.nullish(),
});

/** Omitted fields preserve defaults. Null clears a field. */
export type InvitationCopyInput = z.infer<typeof invitationCopySchema>;

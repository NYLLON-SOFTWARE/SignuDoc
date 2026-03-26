import { z } from "zod";

import {
  emailSchema,
  idSchema,
  nameSchema,
  nonEmptyStringSchema,
  unixTimestampSchema,
} from "./common.ts";

export const accountClosureConfirmationPhrase = "close my account" as const;

export const signUpSchema = z.object({
  fullName: nameSchema,
  email: emailSchema,
  password: z.string().min(15).max(128),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: nonEmptyStringSchema,
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const updateProfileSchema = z.object({
  fullName: nameSchema,
  email: emailSchema,
});

export const updatePasswordSchema = z.object({
  currentPassword: nonEmptyStringSchema,
  newPassword: z.string().min(15).max(128),
});

export const accountClosureRequestSchema = z.object({
  confirmation: z.literal(accountClosureConfirmationPhrase),
});

export const senderProfileSchema = z.object({
  id: idSchema,
  fullName: nameSchema,
  email: emailSchema,
});

export const senderSessionSchema = z.object({
  user: senderProfileSchema,
  expiresAt: unixTimestampSchema.nullable().optional(),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;
export type AccountClosureRequestInput = z.infer<
  typeof accountClosureRequestSchema
>;
export type SenderProfile = z.infer<typeof senderProfileSchema>;
export type SenderSession = z.infer<typeof senderSessionSchema>;

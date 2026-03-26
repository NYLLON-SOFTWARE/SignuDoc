import { z } from "zod";

import { emailSchema, nameSchema, nonEmptyStringSchema } from "./common.ts";

export const contactMessageSchema = nonEmptyStringSchema.max(5000);

export const contactFormSchema = z.object({
  company: z.string().trim().default(""),
  email: emailSchema,
  message: contactMessageSchema,
  name: nameSchema,
});

export type ContactFormInput = z.infer<typeof contactFormSchema>;

import { z } from "zod";

import { MAX_SIGNERS_PER_ENVELOPE } from "../types/domain.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  idSchema,
  nameSchema,
  nonEmptyStringSchema,
} from "./common.ts";
import { duplicateSignerEmailMessage } from "./signer.ts";

export const MAX_TEMPLATE_ROLE_NAME_LENGTH = 60;

export const templateNameSchema = envelopeTitleSchema;
export const templateRoleNameSchema = nonEmptyStringSchema.max(
  MAX_TEMPLATE_ROLE_NAME_LENGTH,
);
export const duplicateRoleNameMessage =
  "Give each signer in the template a different name.";

/** One place in a template's signing order, such as "Client". */
export const templateRoleSchema = z.object({
  id: idSchema,
  name: templateRoleNameSchema,
});

/** A template's roles, in the order their people will sign. */
export const templateRolesSchema = z
  .array(templateRoleSchema)
  .min(1)
  .max(MAX_SIGNERS_PER_ENVELOPE)
  .superRefine((roles, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();

    for (const [index, role] of roles.entries()) {
      const name = role.name.toLowerCase();

      if (names.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: duplicateRoleNameMessage,
          path: [index, "name"],
        });
      }

      if (ids.has(role.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer in the template must be unique.",
          path: [index, "id"],
        });
      }

      ids.add(role.id);
      names.add(name);
    }
  });

/** Saving an envelope as a template. */
export const saveTemplateSchema = z.object({
  name: templateNameSchema,
  // What to call each signer, in signing order. Left out, they are called
  // "Signer 1", "Signer 2" and so on.
  roleNames: z
    .array(templateRoleNameSchema)
    .min(1)
    .max(MAX_SIGNERS_PER_ENVELOPE)
    .optional(),
});

/** Starting an envelope from a template: who fills each role, in order. */
export const useTemplateSchema = z.object({
  signers: z
    .array(z.object({ email: emailSchema, name: nameSchema }))
    .min(1)
    .max(MAX_SIGNERS_PER_ENVELOPE)
    .superRefine((signers, ctx) => {
      const emails = new Set<string>();

      for (const [index, signer] of signers.entries()) {
        const email = signer.email.toLowerCase();

        if (emails.has(email)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: duplicateSignerEmailMessage,
            path: [index, "email"],
          });
        }

        emails.add(email);
      }
    }),
  title: envelopeTitleSchema,
});

export type TemplateRole = z.infer<typeof templateRoleSchema>;
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;
export type UseTemplateInput = z.infer<typeof useTemplateSchema>;

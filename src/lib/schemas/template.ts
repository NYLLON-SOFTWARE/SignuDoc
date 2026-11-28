import { z } from "zod";

import {
  MAX_SIGNERS_CEILING,
  recipientRoles,
  signatureMeanings,
} from "../types/domain.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  idSchema,
  nameSchema,
  nonEmptyStringSchema,
} from "./common.ts";
import { duplicateSignerEmailMessage } from "./signer.ts";
import { invitationCopySchema } from "./invitation.ts";

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
  // The step of the signing order the role is in; roles that share one
  // sign at the same time. Templates saved before steps existed have none,
  // and their roles sign one after the other.
  step: z.number().int().positive().max(MAX_SIGNERS_CEILING).optional(),
  // Whether the person in this role signs or only approves. Templates
  // saved before approvers existed have none, and every role signs.
  kind: z.enum(recipientRoles).optional(),
});

/** A template's roles, in the order their people will sign. */
export const templateRolesSchema = z
  .array(templateRoleSchema)
  .min(1)
  .max(MAX_SIGNERS_CEILING)
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
  invitation: invitationCopySchema.optional(),
  name: templateNameSchema,
  // What to call each signer, in signing order. Left out, they are called
  // "Signer 1", "Signer 2" and so on.
  roleNames: z
    .array(templateRoleNameSchema)
    .min(1)
    .max(MAX_SIGNERS_CEILING)
    .optional(),
});

/** Starting an envelope from a template: who fills each role, in order. */
export const useTemplateSchema = z.object({
  invitation: invitationCopySchema.optional(),
  signers: z
    .array(
      z.object({
        email: emailSchema,
        name: nameSchema,
        // What the signature means, for Part 11 envelopes. The web app
        // asks for it later; the API can give it here, so the draft can be
        // sent at once.
        signatureMeaning: z.enum(signatureMeanings).optional(),
      }),
    )
    .min(1)
    .max(MAX_SIGNERS_CEILING)
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

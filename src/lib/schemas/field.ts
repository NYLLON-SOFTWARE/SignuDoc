import { z } from "zod";

import { fieldInputMethods, fieldTypes } from "../types/domain.ts";
import {
  idSchema,
  normalizedCoordinateSchema,
  normalizedSizeSchema,
  optionalTrimmedString,
  unixTimestampSchema,
} from "./common.ts";

export const fieldTypeSchema = z.enum(fieldTypes);
export const fieldInputMethodSchema = z.enum(fieldInputMethods);

export const MAX_DRAWN_SIGNATURE_BYTES = 256 * 1024;
const MAX_DRAWN_SIGNATURE_DATA_URL_LENGTH =
  "data:image/png;base64,".length +
  Math.ceil(MAX_DRAWN_SIGNATURE_BYTES / 3) * 4;

export const fieldPlacementSchema = z
  .object({
    id: idSchema.optional(),
    envelopeId: idSchema.optional(),
    signerId: idSchema,
    type: fieldTypeSchema,
    page: z.number().int().positive(),
    x: normalizedCoordinateSchema,
    y: normalizedCoordinateSchema,
    width: normalizedSizeSchema,
    height: normalizedSizeSchema,
    required: z.boolean().default(true),
    label: optionalTrimmedString(120),
  })
  .superRefine((field, ctx) => {
    if (field.x + field.width > 1.000001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Field width extends beyond the page bounds",
        path: ["width"],
      });
    }

    if (field.y + field.height > 1.000001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Field height extends beyond the page bounds",
        path: ["height"],
      });
    }

    if (
      (field.type === "signature" ||
        field.type === "initials" ||
        field.type === "date") &&
      !field.required
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field.type} fields are always required`,
        path: ["required"],
      });
    }
  });

export const fieldPlacementListSchema = z.array(fieldPlacementSchema);

export const replaceFieldsSchema = z.object({
  fields: fieldPlacementListSchema,
});

export const replaceFieldsResponseSchema = z.object({
  envelopeId: idSchema,
  fields: z.array(
    fieldPlacementSchema.safeExtend({
      id: idSchema,
    }),
  ),
  redirectPath: z.string().trim().min(1),
  updatedAt: unixTimestampSchema,
});

export const fieldRecordSchema = fieldPlacementSchema.extend({
  inputMethod: fieldInputMethodSchema.nullable().optional(),
  value: optionalTrimmedString(5000).nullable().optional(),
  imageKey: z.string().trim().min(1).nullable().optional(),
  checked: z.boolean().nullable().optional(),
  submittedAt: unixTimestampSchema.nullable().optional(),
  createdAt: unixTimestampSchema,
  updatedAt: unixTimestampSchema,
});

const typedSignatureSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.enum(["signature", "initials"]),
  inputMethod: z.literal("typed"),
  value: z.string().trim().min(1).max(200),
});

const drawnSignatureSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.enum(["signature", "initials"]),
  inputMethod: z.literal("drawn"),
  imageDataUrl: z
    .string()
    .trim()
    .min(1)
    .max(
      MAX_DRAWN_SIGNATURE_DATA_URL_LENGTH,
      "Drawn signature image data is too large.",
    ),
});

const textSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.literal("text"),
  value: z.string().trim().min(1).max(5000),
});

const checkboxSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.literal("checkbox"),
  checked: z.boolean(),
});

export const signingFieldSubmissionSchema = z.union([
  typedSignatureSubmissionSchema,
  drawnSignatureSubmissionSchema,
  textSubmissionSchema,
  checkboxSubmissionSchema,
]);

export const signingSubmissionSchema = z.object({
  clientTimezoneOffsetMinutes: z.number().int().min(-840).max(840),
  fields: z.array(signingFieldSubmissionSchema),
});

export type FieldPlacement = z.infer<typeof fieldPlacementSchema>;
export type FieldRecord = z.infer<typeof fieldRecordSchema>;
export type ReplaceFieldsInput = z.infer<typeof replaceFieldsSchema>;
export type ReplaceFieldsResponse = z.infer<typeof replaceFieldsResponseSchema>;
export type SigningFieldSubmission = z.infer<
  typeof signingFieldSubmissionSchema
>;
export type SigningSubmission = z.infer<typeof signingSubmissionSchema>;

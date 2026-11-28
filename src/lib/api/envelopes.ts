import { z } from "zod";

import { getDb, type DbExecutor, type DbPool } from "../db/connection.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  EnvelopeMutationError,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "../envelopes.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  nameSchema,
} from "../schemas/common.ts";
import {
  deadlineDaysSchema,
  reminderIntervalDaysSchema,
  reminderScheduleSchema,
} from "../schemas/envelope.ts";
import { fieldTypeSchema } from "../schemas/field.ts";
import {
  MAX_COPY_RECIPIENTS_PER_ENVELOPE,
  MAX_SIGNERS_CEILING,
  signatureMeanings,
} from "../types/domain.ts";

// Envelopes as the public API sees them: one shape, ApiEnvelope, returned by
// every endpoint (and, later, carried by webhooks), and the one-call create.
// Everything that changes an envelope goes through the same functions the
// web app uses, so the same rules apply.

export const MAX_API_METADATA_BYTES = 2048;
export const MAX_API_FIELDS = 500;

export {
  apiListQuerySchema,
  decodeCursor,
  encodeCursor,
  getApiEnvelope,
  listApiEnvelopeEvents,
  listApiEnvelopes,
  toApiEnvelope,
  type ApiEnvelope,
  type ApiSigner,
} from "./envelope-view.ts";
import { getApiEnvelope, type ApiEnvelope } from "./envelope-view.ts";

const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Use letters, digits, '.', '_', ':' or '-' in a ref.",
  );

const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      MAX_API_METADATA_BYTES,
    {
      message: `Metadata must be at most ${String(MAX_API_METADATA_BYTES)} bytes of JSON.`,
    },
  );

export const apiSendOptionsSchema = z.object({
  delivery: z.enum(["email", "embedded"]).optional(),
  expiresInDays: deadlineDaysSchema.optional(),
  permittedUseConfirmed: z.literal(true, {
    message:
      "Set permittedUseConfirmed to true to confirm the envelope is an ordinary business agreement (see /electronic-signatures on your install).",
  }),
  reminderIntervalDays: reminderIntervalDaysSchema.optional(),
  reminderSchedule: reminderScheduleSchema.optional(),
  signatureLevel: z.enum(["simple", "advanced", "qualified"]).optional(),
});

const apiSignerSchema = z.object({
  accessCode: z.string().trim().min(4).max(64).optional(),
  email: emailSchema,
  name: nameSchema,
  ref: refSchema,
  requireEmailCode: z.boolean().optional(),
  signatureMeaning: z.enum(signatureMeanings).optional(),
  // The step of the signing order, as in the web app: signers who share a
  // step sign at the same time. Given for every signer or for none; left
  // out, they sign one after the other in the order of the list.
  step: z.number().int().positive().max(MAX_SIGNERS_CEILING).optional(),
});

const apiFieldSchema = z.object({
  groupId: z.string().trim().min(1).max(64).optional(),
  height: z.number().finite().gt(0).max(1),
  label: z.string().trim().max(120).optional(),
  options: z.array(z.string()).optional(),
  page: z.number().int().positive(),
  required: z.boolean().optional(),
  signer: refSchema,
  type: fieldTypeSchema,
  width: z.number().finite().gt(0).max(1),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

export const apiCreateEnvelopeSchema = z
  .object({
    copyRecipients: z
      .array(z.object({ email: emailSchema, name: nameSchema }))
      .max(MAX_COPY_RECIPIENTS_PER_ENVELOPE)
      .optional(),
    fields: z.array(apiFieldSchema).min(1).max(MAX_API_FIELDS),
    metadata: metadataSchema.optional(),
    send: apiSendOptionsSchema.optional(),
    // The install's own limit, MAX_SIGNERS_PER_ENVELOPE, is checked when
    // the signers are saved, as in the web app.
    signers: z.array(apiSignerSchema).min(1).max(MAX_SIGNERS_CEILING),
    title: envelopeTitleSchema,
  })
  .superRefine((value, ctx) => {
    const refs = new Set<string>();

    for (const [index, signer] of value.signers.entries()) {
      if (refs.has(signer.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer needs its own ref.",
          path: ["signers", index, "ref"],
        });
      }

      refs.add(signer.ref);
    }

    for (const [index, field] of value.fields.entries()) {
      if (!refs.has(field.signer)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `No signer has the ref "${field.signer}".`,
          path: ["fields", index, "signer"],
        });
      }
    }
  });

export type ApiCreateEnvelopeInput = z.infer<typeof apiCreateEnvelopeSchema>;
export type ApiSendOptions = z.infer<typeof apiSendOptionsSchema>;

export type ApiActor = {
  apiKeyId: string;
  email: string;
  ipAddress: string | null;
  name: string;
  userAgent: string | null;
  userId: string;
};

/** The first message of a zod error, with where it was. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];

  if (!issue) {
    return "The request is not valid.";
  }

  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";

  return `${where}${issue.message}`;
}

export async function sendEnvelopeForApi(
  actor: ApiActor,
  envelopeId: string,
  options: ApiSendOptions,
  database: DbPool = getDb(),
) {
  await sendDraftEnvelope(
    actor.userId,
    envelopeId,
    {
      apiKeyId: actor.apiKeyId,
      delivery: options.delivery,
      expiresInDays: options.expiresInDays,
      ipAddress: actor.ipAddress,
      reminderIntervalDays: options.reminderIntervalDays,
      reminderSchedule: options.reminderSchedule,
      senderEmail: actor.email,
      senderName: actor.name.trim() ? actor.name : actor.email,
      signatureLevel: options.signatureLevel,
      userAgent: actor.userAgent,
    },
    { database },
  );
}

/**
 * Creates a draft with its signers, copy recipients and fields, and sends it
 * if asked. Either all of it happens or none of it does: a draft that cannot
 * be completed (a field off its page, a send the install refuses) is deleted
 * again before the error is returned.
 */
export async function createEnvelopeForApi(
  actor: ApiActor,
  input: ApiCreateEnvelopeInput,
  sourcePdf: { body: Uint8Array; contentType: string; filename: string },
  database: DbPool = getDb(),
  options: {
    /** Called once the envelope is made, and sent if asked, for good. */
    onCreated?: (envelopeId: string) => Promise<void>;
  } = {},
): Promise<ApiEnvelope> {
  const draft = await createDraftEnvelope(
    actor.userId,
    { sourcePdf, title: input.title },
    { database },
  );
  const envelopeId = draft.envelope.id;

  try {
    for (const [index, field] of input.fields.entries()) {
      if (field.page > draft.envelope.pageCount) {
        throw new EnvelopeMutationError(
          `fields.${String(index)}.page: the document has ${String(draft.envelope.pageCount)} page(s).`,
          400,
        );
      }
    }

    const signers = await replaceDraftEnvelopeSigners(
      actor.userId,
      envelopeId,
      {
        copyRecipients: input.copyRecipients ?? [],
        signers: input.signers.map((signer, index) => ({
          accessCode: signer.accessCode,
          email: signer.email,
          name: signer.name,
          requireEmailCode: signer.requireEmailCode,
          signatureMeaning: signer.signatureMeaning,
          signingStep: signer.step,
          signOrder: index + 1,
        })),
      },
      database,
    );
    const idByEmail = new Map(
      signers.signers.map((signer) => [signer.email.toLowerCase(), signer.id]),
    );
    const idByRef = new Map<string, string>();

    for (const signer of input.signers) {
      const id = idByEmail.get(signer.email.toLowerCase());

      if (!id) {
        throw new Error("A signer that was just saved could not be found.");
      }

      idByRef.set(signer.ref, id);
      await database.query(
        `UPDATE signers SET api_ref = $1 WHERE id = $2 AND envelope_id = $3`,
        [signer.ref, id, envelopeId],
      );
    }

    await replaceDraftEnvelopeFields(
      actor.userId,
      envelopeId,
      {
        fields: input.fields.map((field) => ({
          groupId: field.groupId,
          height: field.height,
          label: field.label,
          options: field.options,
          page: field.page,
          required: field.required ?? true,
          signerId: idByRef.get(field.signer),
          type: field.type,
          width: field.width,
          x: field.x,
          y: field.y,
        })),
      },
      database,
    );
    await database.query(
      `UPDATE envelopes SET api_key_id = $1, api_metadata = $2 WHERE id = $3`,
      [actor.apiKeyId, input.metadata ?? null, envelopeId],
    );

    if (input.send) {
      await sendEnvelopeForApi(actor, envelopeId, input.send, database);
    }
  } catch (error) {
    await deleteDraftEnvelope(actor.userId, envelopeId, { database }).catch(
      (cleanupError: unknown) => {
        console.error(
          `Deleting the API draft ${envelopeId} after a failed create failed:`,
          cleanupError,
        );
      },
    );
    throw error;
  }

  await options.onCreated?.(envelopeId);

  const envelope = await getApiEnvelope(actor.userId, envelopeId, database);

  if (!envelope) {
    throw new Error(
      "An envelope that was just created could not be read back.",
    );
  }

  return envelope;
}

/** Sets what an envelope made from a template keeps for the API. */
export async function markEnvelopeAsApiMade(
  envelopeId: string,
  apiKeyId: string,
  metadata: Record<string, unknown> | null,
  database: DbExecutor = getDb(),
) {
  await database.query(
    `UPDATE envelopes SET api_key_id = $1, api_metadata = $2 WHERE id = $3`,
    [apiKeyId, metadata, envelopeId],
  );
}

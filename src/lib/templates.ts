import { randomUUID } from "node:crypto";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
} from "./db/connection.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  EnvelopeDocumentAccessError,
  getDraftEnvelopeDocumentForUser,
  getPrepareEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
} from "./envelopes.ts";
import { countAnswerableFields } from "./field-choices.ts";
import { fieldPlacementListSchema } from "./schemas/field.ts";
import {
  saveTemplateSchema,
  templateRolesSchema,
  useTemplateSchema,
  type TemplateRole,
} from "./schemas/template.ts";
import { buildTemplatePdfKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  StorageObjectNotFoundError,
  type StorageService,
} from "./services/storage.ts";

// A template is a document, the fields placed on it and its signing order,
// kept so the same thing can be sent again. It names no one: each place in
// the signing order is a role ("Client"), filled in when the template is
// used. It is made from an envelope and turned back into a draft envelope,
// so everything a draft can hold, a template can hold.

/** A guard on storage, not a product limit anyone should run into. */
export const MAX_TEMPLATES_PER_USER = 100;

const UNUSABLE_TEMPLATE_MESSAGE =
  "This template can no longer be used. Delete it, then save the document as a template again.";

export class TemplateError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "TemplateError";
    this.statusCode = statusCode;
  }
}

type TemplateOptions = {
  database?: DbPool;
  storageService?: StorageService;
};

type TemplateRow = {
  createdAt: number;
  fields: unknown;
  id: string;
  name: string;
  pageCount: number;
  roles: unknown;
  sourcePdfFilename: string;
  sourcePdfKey: string;
};

export type TemplateListItem = {
  createdAtLabel: string;
  fieldCountLabel: string;
  id: string;
  name: string;
  pageCountLabel: string;
  /** In signing order. */
  roleNames: string[];
};

/** What the "use this template" form needs. */
export type UseTemplateData = {
  fieldCountLabel: string;
  id: string;
  name: string;
  pageCountLabel: string;
  roles: TemplateRole[];
};

export type SavedTemplate = {
  id: string;
  name: string;
};

export type DraftFromTemplate = {
  envelopeId: string;
  redirectPath: string;
};

const TEMPLATE_COLUMNS = `
  id,
  name,
  page_count AS "pageCount",
  roles,
  fields,
  source_pdf_key AS "sourcePdfKey",
  source_pdf_filename AS "sourcePdfFilename",
  created_at AS "createdAt"
`;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function countLabel(count: number, singular: string): string {
  return `${String(count)} ${count === 1 ? singular : `${singular}s`}`;
}

// A list must still open when one template's stored contents cannot be
// read, so the names and the count are taken leniently here. Using a
// template checks them properly.
function readRoleNames(roles: unknown): string[] {
  if (!Array.isArray(roles)) {
    return [];
  }

  return roles.flatMap((role: unknown) =>
    typeof role === "object" &&
    role !== null &&
    "name" in role &&
    typeof role.name === "string"
      ? [role.name]
      : [],
  );
}

function countFields(fields: unknown): number {
  if (!Array.isArray(fields)) {
    return 0;
  }

  return countAnswerableFields(
    fields.flatMap((field: unknown) =>
      typeof field === "object" && field !== null
        ? [
            {
              groupId:
                "groupId" in field && typeof field.groupId === "string"
                  ? field.groupId
                  : undefined,
              type: "type" in field ? String(field.type) : "",
            },
          ]
        : [],
    ),
    () => true,
  );
}

async function getTemplateRow(
  userId: string,
  templateId: string,
  database: DbExecutor,
): Promise<TemplateRow | null> {
  return queryOne<TemplateRow>(
    database,
    `SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE id = $1 AND user_id = $2`,
    [templateId, userId],
  );
}

export async function listTemplatesForUser(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<TemplateListItem[]> {
  const rows = await queryMany<TemplateRow>(
    database,
    `
      SELECT ${TEMPLATE_COLUMNS}
      FROM templates
      WHERE user_id = $1
      ORDER BY created_at DESC, id ASC
    `,
    [userId],
  );

  return rows.map((row) => ({
    createdAtLabel: dateFormatter.format(new Date(row.createdAt * 1000)),
    fieldCountLabel: countLabel(countFields(row.fields), "field"),
    id: row.id,
    name: row.name,
    pageCountLabel: countLabel(row.pageCount, "page"),
    roleNames: readRoleNames(row.roles),
  }));
}

export async function getUseTemplateDataForUser(
  userId: string,
  templateId: string,
  database: DbExecutor = getDb(),
): Promise<UseTemplateData | null> {
  const row = await getTemplateRow(userId, templateId, database);

  if (!row) {
    return null;
  }

  const roles = templateRolesSchema.safeParse(row.roles);

  if (!roles.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  return {
    fieldCountLabel: countLabel(countFields(row.fields), "field"),
    id: row.id,
    name: row.name,
    pageCountLabel: countLabel(row.pageCount, "page"),
    roles: roles.data,
  };
}

/**
 * Keeps an envelope's document, fields and signing order as a template.
 * Any envelope of the user's will do, sent or not: only where the fields
 * are is copied, never what was entered in them, and the signers' names
 * and addresses are left behind.
 */
export async function saveEnvelopeAsTemplate(
  userId: string,
  envelopeId: string,
  input: unknown,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<SavedTemplate> {
  const parsedInput = saveTemplateSchema.parse(input);
  const envelope = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
    database,
  });

  if (!envelope) {
    throw new TemplateError("Envelope not found.", 404);
  }

  const signers = [...envelope.signers].sort(
    (left, right) => left.order - right.order,
  );

  if (signers.length === 0) {
    throw new TemplateError(
      "Add at least one signer before saving this as a template.",
      400,
    );
  }

  const roleNames =
    parsedInput.roleNames ??
    signers.map((_, index) => `Signer ${String(index + 1)}`);

  if (roleNames.length !== signers.length) {
    throw new TemplateError(
      "The signers of this envelope have changed. Reload the page and try again.",
      409,
    );
  }

  const roles = templateRolesSchema.parse(
    roleNames.map((name) => ({ id: randomUUID(), name })),
  );
  const roleIdBySignerId = new Map(
    signers.map((signer, index) => [signer.id, roles[index]!.id] as const),
  );
  // Where each field is and what kind it is. Anything a signer entered
  // stays with the envelope.
  const fields = fieldPlacementListSchema.parse(
    envelope.fields.flatMap((field) => {
      const roleId = roleIdBySignerId.get(field.signerId);

      return roleId
        ? [
            {
              groupId: field.groupId,
              height: field.height,
              label: field.label,
              options: field.options,
              page: field.page,
              required: field.required,
              signerId: roleId,
              type: field.type,
              width: field.width,
              x: field.x,
              y: field.y,
            },
          ]
        : [];
    }),
  );
  const existing = await queryOne<{ total: number }>(
    database,
    `SELECT count(*)::int AS total FROM templates WHERE user_id = $1`,
    [userId],
  );

  if ((existing?.total ?? 0) >= MAX_TEMPLATES_PER_USER) {
    throw new TemplateError(
      `You have ${String(MAX_TEMPLATES_PER_USER)} templates, which is the most an account can keep. Delete one to save another.`,
      409,
    );
  }

  let document: Awaited<ReturnType<typeof getDraftEnvelopeDocumentForUser>>;

  try {
    document = await getDraftEnvelopeDocumentForUser(userId, envelopeId, {
      database,
      storageService,
    });
  } catch (error) {
    if (error instanceof EnvelopeDocumentAccessError) {
      throw new TemplateError(
        "This envelope's document is no longer available, so it cannot be saved as a template.",
        error.statusCode,
      );
    }

    throw error;
  }

  const templateId = randomUUID();
  const sourcePdfKey = buildTemplatePdfKey({ templateId, userId });
  const now = Math.floor(Date.now() / 1000);

  await storageService.putObject({
    body: document.body,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  try {
    await database.query(
      `
        INSERT INTO templates (
          id,
          user_id,
          name,
          source_pdf_key,
          source_pdf_filename,
          source_pdf_size_bytes,
          page_count,
          roles,
          fields,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $10)
      `,
      [
        templateId,
        userId,
        parsedInput.name,
        sourcePdfKey,
        document.fileName,
        document.body.length,
        envelope.pageCount,
        JSON.stringify(roles),
        JSON.stringify(fields),
        now,
      ],
    );
  } catch (error) {
    // Nothing points at the copy, so nothing would ever remove it.
    await storageService.deleteObject(sourcePdfKey).catch(() => undefined);
    throw error;
  }

  return { id: templateId, name: parsedInput.name };
}

/**
 * Starts a draft envelope from a template: the template's document and
 * fields, with a person named for each role. The draft is an ordinary one
 * from then on, and changing it does not change the template.
 */
export async function createDraftFromTemplate(
  userId: string,
  templateId: string,
  input: unknown,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<DraftFromTemplate> {
  const parsedInput = useTemplateSchema.parse(input);
  const template = await getTemplateRow(userId, templateId, database);

  if (!template) {
    throw new TemplateError("Template not found.", 404);
  }

  const roles = templateRolesSchema.safeParse(template.roles);
  const fields = fieldPlacementListSchema.safeParse(template.fields);

  if (!roles.success || !fields.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  const roleIds = new Set(roles.data.map((role) => role.id));

  if (fields.data.some((field) => !roleIds.has(field.signerId))) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  if (parsedInput.signers.length !== roles.data.length) {
    throw new TemplateError(
      "Name one person for each signer in this template.",
      400,
    );
  }

  let sourcePdf: Uint8Array;

  try {
    sourcePdf = (await storageService.getObject(template.sourcePdfKey)).body;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
    }

    throw error;
  }

  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: {
        body: sourcePdf,
        contentType: "application/pdf",
        filename: template.sourcePdfFilename,
      },
      title: parsedInput.title,
    },
    { database, storageService },
  );
  const envelopeId = draft.envelope.id;

  try {
    const saved = await replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      { signers: parsedInput.signers },
      database,
    );
    const signerIdByOrder = new Map(
      saved.signers.map((signer) => [signer.signOrder, signer.id] as const),
    );
    const signerIdByRoleId = new Map(
      roles.data.map(
        (role, index) => [role.id, signerIdByOrder.get(index + 1)] as const,
      ),
    );

    await replaceDraftEnvelopeFields(
      userId,
      envelopeId,
      {
        fields: fields.data.map((field) => ({
          ...field,
          signerId: signerIdByRoleId.get(field.signerId),
        })),
      },
      database,
    );
  } catch (error) {
    // Half a draft is worse than none: the sender would find a document
    // with no fields on it and no sign of why.
    await deleteDraftEnvelope(userId, envelopeId, {
      database,
      storageService,
    }).catch(() => undefined);

    throw error;
  }

  return {
    envelopeId,
    // Everything is already in place, so the sender lands where they can
    // check it and send. The earlier steps are one click back.
    redirectPath: `/envelopes/${envelopeId}/review`,
  };
}

export async function deleteTemplate(
  userId: string,
  templateId: string,
  {
    database = getDb(),
    storageService = createStorageService(),
  }: TemplateOptions = {},
): Promise<void> {
  const deleted = await queryOne<{ sourcePdfKey: string }>(
    database,
    `
      DELETE FROM templates
      WHERE id = $1 AND user_id = $2
      RETURNING source_pdf_key AS "sourcePdfKey"
    `,
    [templateId, userId],
  );

  if (!deleted) {
    throw new TemplateError("Template not found.", 404);
  }

  // Envelopes made from the template have their own copies of the document.
  await storageService.deleteObject(deleted.sourcePdfKey).catch((error) => {
    console.error(
      `Failed to delete the document of template ${templateId}:`,
      error,
    );
  });
}

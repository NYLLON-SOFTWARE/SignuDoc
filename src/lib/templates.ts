import { randomUUID } from "node:crypto";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  EnvelopeDocumentAccessError,
  findUnreadableDropdown,
  getDraftEnvelopeDocumentForUser,
  getPrepareEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
} from "./envelopes.ts";
import {
  countAnswerableFields,
  describeChoiceFieldProblem,
  findChoiceFieldProblem,
} from "./field-choices.ts";
import { fieldPlacementListSchema } from "./schemas/field.ts";
import {
  saveTemplateSchema,
  templateRolesSchema,
  useTemplateSchema,
  type TemplateRole,
} from "./schemas/template.ts";
import {
  DocumentImportError,
  importPdfDocument,
} from "./services/document-import.ts";
import { buildTemplatePdfKey } from "./services/storage-keys.ts";
import { normalizeSigningSteps } from "./signing-steps.ts";
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

/** Refuses another template for a user who already has the most allowed. */
async function assertRoomForTemplate(
  userId: string,
  database: DbExecutor,
): Promise<void> {
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
}

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

export type TemplateForBulkSend = UseTemplateData & {
  fields: unknown;
  sourcePdfFilename: string;
  sourcePdfKey: string;
};

/**
 * Whether this template can be sent as it stands: someone has to sign,
 * every signer role needs a signature field, an approver role has no
 * fields, and choice fields must be finished. Saved from a draft
 * that was still being prepared, it is kept, but it cannot go out.
 */
export function describeUnsendableTemplate(
  roles: readonly TemplateRole[],
  fields: unknown,
): string | null {
  if (roles.length === 0) {
    return "Add signers and place fields before sending this envelope.";
  }

  const parsed = fieldPlacementListSchema.safeParse(fields);

  if (!parsed.success) {
    return UNUSABLE_TEMPLATE_MESSAGE;
  }

  if (parsed.data.length === 0) {
    return "Add signers and place fields before sending this envelope.";
  }

  const roleIds = new Set(roles.map((role) => role.id));

  if (parsed.data.some((field) => !roleIds.has(field.signerId))) {
    return UNUSABLE_TEMPLATE_MESSAGE;
  }

  if (!roles.some((role) => role.kind !== "approver")) {
    return "Add at least one signer. Approvers approve or reject, so someone else has to sign.";
  }

  const approverWithFields = roles.find(
    (role) =>
      role.kind === "approver" &&
      parsed.data.some((field) => field.signerId === role.id),
  );

  if (approverWithFields) {
    return `${approverWithFields.name} is an approver, and approvers have no fields. Remove their fields, or make them a signer.`;
  }

  const missing = roles.find(
    (role) =>
      role.kind !== "approver" &&
      !parsed.data.some(
        (field) => field.signerId === role.id && field.type === "signature",
      ),
  );

  if (missing) {
    return `Every signer must have at least one Signature field before sending. ${missing.name} is missing one.`;
  }

  const choiceProblem = findChoiceFieldProblem(parsed.data);

  if (!choiceProblem) {
    return null;
  }

  return describeChoiceFieldProblem(
    choiceProblem,
    roles.find((role) => role.id === choiceProblem.signerId)?.name ??
      "a signer",
  );
}

/**
 * Whether any dropdown on the template is too small to show one of its
 * choices at a readable size on the template's PDF, in words for the
 * sender, or null. Mirrors sendDraftEnvelope so Send to many rejects an
 * unreadable dropdown before preview marks rows Ready or creates drafts.
 */
export async function describeTemplateDropdownProblem(
  roles: readonly TemplateRole[],
  fields: unknown,
  sourcePdf: { filename: string; key: string },
  storageService?: StorageService,
): Promise<string | null> {
  const parsed = fieldPlacementListSchema.safeParse(fields);

  if (!parsed.success) {
    return UNUSABLE_TEMPLATE_MESSAGE;
  }

  if (
    !parsed.data.some(
      (field) => field.type === "dropdown" && (field.options?.length ?? 0) > 0,
    )
  ) {
    return null;
  }

  const resolvedStorage = storageService ?? createStorageService();
  let sourcePdfBody: Uint8Array;

  try {
    sourcePdfBody = (await resolvedStorage.getObject(sourcePdf.key)).body;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
    }

    throw error;
  }

  let imported: Awaited<ReturnType<typeof importPdfDocument>>;

  try {
    imported = await importPdfDocument({
      body: sourcePdfBody,
      contentType: "application/pdf",
      filename: sourcePdf.filename,
    });
  } catch (error) {
    if (error instanceof DocumentImportError) {
      throw new TemplateError(error.message, 400);
    }

    throw error;
  }

  return findUnreadableDropdown(roles, parsed.data, imported.pages);
}

export async function getTemplateForBulkSend(
  userId: string,
  templateId: string,
  database: DbExecutor = getDb(),
  {
    checkDropdownReadability = true,
    storageService,
  }: {
    checkDropdownReadability?: boolean;
    storageService?: StorageService;
  } = {},
): Promise<TemplateForBulkSend | null> {
  const row = await getTemplateRow(userId, templateId, database);

  if (!row) {
    return null;
  }

  const roles = templateRolesSchema.safeParse(row.roles);

  if (!roles.success) {
    throw new TemplateError(UNUSABLE_TEMPLATE_MESSAGE, 409);
  }

  if (
    checkDropdownReadability &&
    describeUnsendableTemplate(roles.data, row.fields) === null
  ) {
    const dropdownProblem = await describeTemplateDropdownProblem(
      roles.data,
      row.fields,
      {
        filename: row.sourcePdfFilename,
        key: row.sourcePdfKey,
      },
      storageService,
    );

    if (dropdownProblem) {
      throw new TemplateError(dropdownProblem, 400);
    }
  }

  return {
    fieldCountLabel: countLabel(countFields(row.fields), "field"),
    fields: row.fields,
    id: row.id,
    name: row.name,
    pageCountLabel: countLabel(row.pageCount, "page"),
    roles: roles.data,
    sourcePdfFilename: row.sourcePdfFilename,
    sourcePdfKey: row.sourcePdfKey,
  };
}

export async function getUseTemplateDataForUser(
  userId: string,
  templateId: string,
  database: DbExecutor = getDb(),
): Promise<UseTemplateData | null> {
  const template = await getTemplateForBulkSend(userId, templateId, database, {
    checkDropdownReadability: false,
  });

  if (!template) {
    return null;
  }

  return {
    fieldCountLabel: template.fieldCountLabel,
    id: template.id,
    name: template.name,
    pageCountLabel: template.pageCountLabel,
    roles: template.roles,
  };
}

/**
 * Keeps an envelope's document, fields and signing order as a template.
 * A personal template can only be saved from an unfiled envelope.
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
  await assertUnfiledTemplateSource(userId, envelopeId, database);
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

  // Each role keeps its signer's step, so roles that signed at the same
  // time still do when the template is used, and whether they sign or
  // approve.
  const steps = normalizeSigningSteps(signers.map((signer) => signer.step));
  const roles = templateRolesSchema.parse(
    roleNames.map((name, index) => ({
      id: randomUUID(),
      kind: signers[index]?.role ?? "signer",
      name,
      step: steps[index],
    })),
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

  // Before the document is copied, so a full account costs no upload. It is
  // counted again when the template is stored.
  await assertRoomForTemplate(userId, database);

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
    await withTransaction(async (tx) => {
      // Two saves at the same moment would both pass the count above. Here
      // the saves of one user take turns, and each counts what the one
      // before it stored.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 13))", [
        userId,
      ]);
      await tx.query('SELECT id FROM public."user" WHERE id = $1 FOR SHARE', [
        userId,
      ]);
      await assertUnfiledTemplateSource(userId, envelopeId, tx, true);
      await assertRoomForTemplate(userId, tx);
      await tx.query(
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
    }, database);
  } catch (error) {
    // Nothing points at the copy, so nothing would ever remove it.
    await storageService.deleteObject(sourcePdfKey).catch(() => undefined);
    throw error;
  }

  return { id: templateId, name: parsedInput.name };
}

async function assertUnfiledTemplateSource(
  userId: string,
  envelopeId: string,
  database: DbExecutor,
  lock = false,
) {
  const source = await queryOne<{ folderId: string | null }>(
    database,
    `SELECT folder_id AS "folderId" FROM envelopes WHERE id = $1 AND user_id = $2
     ${lock ? "FOR NO KEY UPDATE" : ""}`,
    [envelopeId, userId],
  );
  if (!source) {
    throw new TemplateError("Envelope not found.", 404);
  }
  if (source.folderId !== null) {
    throw new TemplateError(
      "Agreements in folders cannot be saved as personal templates.",
      409,
    );
  }
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
      folderId: parsedInput.folderId,
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
    const roleSteps = roles.data.every((role) => role.step !== undefined)
      ? roles.data.map((role) => role.step)
      : null;
    const saved = await replaceDraftEnvelopeSigners(
      userId,
      envelopeId,
      {
        // The roles' steps, when the template has them. One saved before
        // steps existed has none, and its people sign one after the other.
        signers: parsedInput.signers.map((signer, index) => ({
          ...signer,
          role: roles.data[index]?.kind ?? "signer",
          ...(roleSteps ? { signingStep: roleSteps[index] } : {}),
        })),
      },
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
  const template = await queryOne<{ sourcePdfKey: string }>(
    database,
    `
      SELECT source_pdf_key AS "sourcePdfKey"
      FROM templates
      WHERE id = $1 AND user_id = $2
    `,
    [templateId, userId],
  );

  if (!template) {
    throw new TemplateError("Template not found.", 404);
  }

  // The document goes first and the template only once it is gone. If
  // storage fails, the template is still listed, and deleting it again
  // tries again. The other way round, a failure would leave a document that
  // nothing points to, which nothing would ever remove. Envelopes made from
  // the template have their own copies of the document.
  try {
    await storageService.deleteObject(template.sourcePdfKey);
  } catch (error) {
    console.error(
      `Failed to delete the document of template ${templateId}:`,
      error,
    );

    throw new TemplateError(
      "The template's document could not be deleted, so the template was kept. Try again in a moment.",
      503,
    );
  }

  await database.query(`DELETE FROM templates WHERE id = $1 AND user_id = $2`, [
    templateId,
    userId,
  ]);
}

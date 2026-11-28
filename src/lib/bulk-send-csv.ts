import {
  emailSchema,
  envelopeTitleSchema,
  nameSchema,
} from "./schemas/common.ts";
import { duplicateSignerEmailMessage } from "./schemas/signer.ts";
import type { FixedReminderSchedule } from "./services/reminders.ts";

// CSV for sending one template to many people: a header that names the
// template's signer roles, then one envelope per row. The parser is small
// on purpose, so a quoted comma or a Windows line ending does not need a
// library.

/** Most envelopes one batch may send. Said on the form. */
export const MAX_BULK_SEND_ROWS = 200;

export const missingBulkSendColumnsMessage =
  "This CSV needs a name and email column for each signer. For one signer, use name,email. For more than one, name the columns after each role, such as Tenant name,Tenant email.";

export const ambiguousBulkSendColumnsMessage =
  "Two signers in this template have names that only differ in spacing, so their columns read the same. Write each signer's columns with the role name exactly as the template spells it, as in the example CSV.";

export const bulkSendCapMessage = `A batch can send at most ${String(MAX_BULK_SEND_ROWS)} envelopes.`;

export type BulkSendSigner = {
  email: string;
  name: string;
  roleName: string;
};

export type BulkSendRowStatus = "failed" | "ok" | "sent" | "skipped";

export type BulkSendRowResult = {
  envelopeId: string | null;
  envelopePath: string | null;
  reason: string | null;
  rowNumber: number;
  signers: BulkSendSigner[];
  status: BulkSendRowStatus;
  title: string;
};

export type BulkSendSummary = {
  failed: number;
  ok: number;
  sent: number;
  skipped: number;
};

export type BulkSendResult = {
  error: string | null;
  maxRows: number;
  rows: BulkSendRowResult[];
  summary: BulkSendSummary;
  templateId: string;
  templateName: string;
};

export type BulkSendRole = {
  name: string;
};

type ParsedBulkSendRow = {
  rowNumber: number;
  signers: BulkSendSigner[];
  title: string;
};

// Template role names may differ only in inner spacing ("Client Advisor"
// and "Client  Advisor" are two roles), so a header is matched with its
// spacing first and only then with runs of spaces collapsed.
function exactHeader(value: string): string {
  return value.trim().toLowerCase();
}

function looseHeader(value: string): string {
  return exactHeader(value).replace(/\s+/g, " ");
}

/** The CSV and copy fields that decide which rows a preview describes. */
export function bulkSendPreviewKey(input: {
  copyEmail: string;
  copyName: string;
  csv: string;
  expiresInDays: number;
  reminderIntervalDays: number | null;
  reminderSchedule?: FixedReminderSchedule | null;
  requireEmailCode: boolean;
  signatureMeaning: string | null;
}): string {
  return JSON.stringify({
    copyEmail: input.copyEmail,
    copyName: input.copyName,
    csv: input.csv,
    expiresInDays: input.expiresInDays,
    reminderIntervalDays: input.reminderIntervalDays,
    reminderSchedule: input.reminderSchedule,
    requireEmailCode: input.requireEmailCode,
    signatureMeaning: input.signatureMeaning,
  });
}

/** The batch key a send will confirm with, and the checked request it is for. */
export type BulkSendBatchKey = { key: string; requestKey: string | null };

/**
 * A retry of the same checked request keeps its batch key, so a send that
 * failed after the server saved the batch does not send twice. Checking a
 * changed request starts a new batch, since the server refuses a saved key
 * with a different list.
 */
export function bulkSendBatchKeyForCheck(
  current: BulkSendBatchKey,
  checkedRequestKey: string,
  newKey: () => string,
): BulkSendBatchKey {
  if (current.requestKey === null || current.requestKey === checkedRequestKey) {
    return { key: current.key, requestKey: checkedRequestKey };
  }

  return { key: newKey(), requestKey: checkedRequestKey };
}

/**
 * A copy recipient needs both a name and an email, or neither. One filled
 * field is not sent as an empty list: the sender has to finish it or clear
 * it.
 */
export function copyRecipientPairError(
  name: string,
  email: string,
): string | null {
  const hasName = name.trim().length > 0;
  const hasEmail = email.trim().length > 0;

  if (hasName === hasEmail) {
    return null;
  }

  return hasName
    ? "Enter the copy recipient's email, or clear the name."
    : "Enter the copy recipient's name, or clear the email.";
}

function quoteCsvCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One CSV line. A cell that a spreadsheet would run as a formula is
 * prefixed with an apostrophe, so a downloaded value can never execute.
 */
function csvCell(value: string): string {
  return quoteCsvCell(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
}

function joinCsv(
  rows: readonly (readonly string[])[],
  cell: (value: string) => string,
): string {
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return joinCsv(rows, csvCell);
}

/**
 * Splits CSV text into rows of cells. Quoted fields may hold commas,
 * quotes (as ""), CR, LF or CRLF. A UTF-8 BOM at the start is ignored.
 * Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushRow = () => {
    if (row.some((cell) => cell.trim().length > 0)) {
      rows.push(row);
    }

    row = [];
  };

  while (i < input.length) {
    const character = input[i]!;

    if (inQuotes) {
      if (character === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }

        inQuotes = false;
        i += 1;
        continue;
      }

      field += character;
      i += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (character === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (character === "\n" || character === "\r") {
      if (character === "\r" && input[i + 1] === "\n") {
        i += 1;
      }

      row.push(field);
      field = "";
      pushRow();
      i += 1;
      continue;
    }

    field += character;
    i += 1;
  }

  if (inQuotes || field.length > 0 || row.length > 0) {
    row.push(field);
    pushRow();
  }

  return rows;
}

function findColumn(headers: readonly string[], aliases: readonly string[]) {
  for (const normalize of [exactHeader, looseHeader]) {
    const normalized = headers.map(normalize);

    for (const alias of aliases) {
      const index = normalized.indexOf(normalize(alias));

      if (index >= 0) {
        return index;
      }
    }
  }

  return -1;
}

function cellAt(row: readonly string[], index: number): string {
  return (row[index] ?? "").trim();
}

export function csvHeadersForRoles(roleNames: readonly string[]): string[] {
  if (roleNames.length === 1) {
    return ["name", "email", "title"];
  }

  return [
    ...roleNames.flatMap((name) => [`${name} name`, `${name} email`]),
    "title",
  ];
}

/**
 * The sample CSV the send-many page fills in for the sender. It is read
 * back by parseBulkSendCsv, never opened in a spreadsheet, so its cells
 * skip the formula apostrophe: a role named "- Client" must give a
 * "- Client name" header the importer matches.
 */
export function exampleCsvForRoles(roleNames: readonly string[]): string {
  const headers = csvHeadersForRoles(roleNames);

  if (roleNames.length === 1) {
    return joinCsv(
      [headers, ["Jane Smith", "jane@company.com", "NDA for Jane Smith"]],
      quoteCsvCell,
    );
  }

  // Role names can hold punctuation and non-English letters, so the
  // sample addresses are numbered rather than built from the role name.
  const sample = [
    ...roleNames.flatMap((name, index) => [
      `${name} person`,
      `signer${String(index + 1)}@company.com`,
    ]),
    "Agreement",
  ];

  return joinCsv([headers, sample], quoteCsvCell);
}

function nameColumnAliases(roleName: string, soleRole: boolean): string[] {
  return soleRole ? ["name", `${roleName} name`] : [`${roleName} name`];
}

function emailColumnAliases(roleName: string, soleRole: boolean): string[] {
  return soleRole ? ["email", `${roleName} email`] : [`${roleName} email`];
}

export function parseBulkSendCsv(
  csv: string,
  roles: readonly BulkSendRole[],
  templateName: string,
): { error: string | null; rows: ParsedBulkSendRow[] } {
  if (roles.length === 0) {
    return { error: missingBulkSendColumnsMessage, rows: [] };
  }

  const table = parseCsv(csv);

  if (table.length === 0) {
    return { error: missingBulkSendColumnsMessage, rows: [] };
  }

  const headers = table[0]!;
  const soleRole = roles.length === 1;
  const titleIndex = findColumn(headers, ["title"]);
  const columns = roles.map((role) => ({
    emailIndex: findColumn(headers, emailColumnAliases(role.name, soleRole)),
    nameIndex: findColumn(headers, nameColumnAliases(role.name, soleRole)),
    roleName: role.name,
  }));

  if (columns.some((column) => column.emailIndex < 0 || column.nameIndex < 0)) {
    return { error: missingBulkSendColumnsMessage, rows: [] };
  }

  const claimed = columns.flatMap((column) => [
    column.emailIndex,
    column.nameIndex,
  ]);

  if (new Set(claimed).size !== claimed.length) {
    return { error: ambiguousBulkSendColumnsMessage, rows: [] };
  }

  const dataRows = table.slice(1);

  if (dataRows.length === 0) {
    return { error: "Add at least one person.", rows: [] };
  }

  const rows = dataRows.map((cells, index) => {
    const title = titleIndex >= 0 ? cellAt(cells, titleIndex) : "";

    return {
      rowNumber: index + 1,
      signers: columns.map((column) => ({
        email: cellAt(cells, column.emailIndex),
        name: cellAt(cells, column.nameIndex),
        roleName: column.roleName,
      })),
      title: title.length > 0 ? title : templateName,
    };
  });

  return { error: null, rows };
}

function duplicateRowMessage(rowNumber: number): string {
  return `This row is the same as row ${String(rowNumber)}.`;
}

function signerEmailKey(signers: readonly BulkSendSigner[]): string {
  return signers
    .map((signer) => signer.email.trim().toLowerCase())
    .join("\u0000");
}

export function summarizeBulkSendRows(
  rows: readonly BulkSendRowResult[],
): BulkSendSummary {
  return {
    failed: rows.filter((row) => row.status === "failed").length,
    ok: rows.filter((row) => row.status === "ok").length,
    sent: rows.filter((row) => row.status === "sent").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
  };
}

function skipped(row: ParsedBulkSendRow, reason: string): BulkSendRowResult {
  return {
    envelopeId: null,
    envelopePath: null,
    reason,
    rowNumber: row.rowNumber,
    signers: row.signers,
    status: "skipped",
    title: row.title,
  };
}

function firstSignerProblem(
  signers: readonly BulkSendSigner[],
  copyRecipientEmails: ReadonlySet<string>,
): string | null {
  const emails = new Set<string>();

  for (const signer of signers) {
    if (signer.name.length === 0) {
      return "Name is required.";
    }

    const named = nameSchema.safeParse(signer.name);

    if (!named.success) {
      return named.error.issues[0]?.message ?? "Name is required.";
    }

    if (signer.email.length === 0) {
      return "Email is required.";
    }

    const addressed = emailSchema.safeParse(signer.email);

    if (!addressed.success) {
      return "Enter a valid email address.";
    }

    const email = addressed.data.toLowerCase();

    if (emails.has(email)) {
      return duplicateSignerEmailMessage;
    }

    if (copyRecipientEmails.has(email)) {
      return "This address is already a signer or a copy recipient.";
    }

    emails.add(email);
  }

  return null;
}

/**
 * Marks rows that cannot be sent: a missing or invalid name or email, a
 * duplicate of an earlier row, a title the envelope cannot keep, or a row
 * past the batch cap. Does not create anything.
 */
export function validateBulkSendRows(
  rows: readonly ParsedBulkSendRow[],
  copyRecipientEmails: readonly string[] = [],
): BulkSendRowResult[] {
  const seen = new Map<string, number>();
  const copyEmails = new Set(
    copyRecipientEmails.map((email) => email.trim().toLowerCase()),
  );
  const results: BulkSendRowResult[] = [];

  for (const [index, row] of rows.entries()) {
    if (index >= MAX_BULK_SEND_ROWS) {
      results.push(skipped(row, bulkSendCapMessage));
      continue;
    }

    const title = envelopeTitleSchema.safeParse(row.title);

    if (!title.success) {
      results.push(
        skipped(
          row,
          title.error.issues[0]?.message ?? "Give the envelope a title.",
        ),
      );
      continue;
    }

    const signerProblem = firstSignerProblem(row.signers, copyEmails);

    if (signerProblem) {
      results.push(skipped(row, signerProblem));
      continue;
    }

    const key = signerEmailKey(row.signers);
    const earlier = seen.get(key);

    if (earlier !== undefined) {
      results.push(skipped(row, duplicateRowMessage(earlier)));
      continue;
    }

    seen.set(key, row.rowNumber);
    results.push({
      envelopeId: null,
      envelopePath: null,
      reason: null,
      rowNumber: row.rowNumber,
      signers: row.signers.map((signer) => ({
        email: emailSchema.parse(signer.email),
        name: nameSchema.parse(signer.name),
        roleName: signer.roleName,
      })),
      status: "ok",
      title: title.data,
    });
  }

  return results;
}

export function serializeBulkSendResultsCsv(
  rows: readonly BulkSendRowResult[],
  roleNames: readonly string[],
): string {
  const headers = [
    "Row",
    "Status",
    "Reason",
    "Title",
    ...roleNames.flatMap((name) => [`${name} name`, `${name} email`]),
    "Envelope",
  ];
  const body = rows.map((row) => [
    String(row.rowNumber),
    row.status,
    row.reason ?? "",
    row.title,
    ...roleNames.flatMap((_, index) => [
      row.signers[index]?.name ?? "",
      row.signers[index]?.email ?? "",
    ]),
    row.envelopePath ?? "",
  ]);

  return serializeCsv([headers, ...body]);
}

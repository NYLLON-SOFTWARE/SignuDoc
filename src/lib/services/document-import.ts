import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import type { EnvelopePageRecord } from "../schemas/envelope.ts";
import { MAX_UPLOAD_SIZE_BYTES } from "../types/domain.ts";

const PDF_MAGIC_HEADER = "%PDF-";

const PDF_IMPORT_ERROR_MESSAGES = {
  encrypted_pdf:
    "This PDF is password-protected or encrypted. Please upload an unlocked PDF.",
  invalid_type: "Only PDF files are supported. Please upload a valid PDF.",
  too_large: "This file exceeds the 20 MB limit.",
  unreadable_pdf: "We couldn't read this PDF. Please upload a valid file.",
  unsupported_variant:
    "This PDF uses an unsupported format. Please export it as a standard PDF.",
  upload_failed: "Upload failed. Please try again.",
} as const;

export const pdfImportFailureCodes = [
  "encrypted_pdf",
  "invalid_type",
  "too_large",
  "unreadable_pdf",
  "unsupported_variant",
  "upload_failed",
] as const;

export type PdfImportFailureCode = (typeof pdfImportFailureCodes)[number];

export type PdfImportError = {
  code: PdfImportFailureCode;
  message: string;
};

export type ImportedPdfPage = Pick<
  EnvelopePageRecord,
  "heightPt" | "pageNumber" | "widthPt"
>;

export type ImportedPdfDocument = {
  encrypted: boolean;
  filename: string;
  pageCount: number;
  pages: ImportedPdfPage[];
  pureXfa: boolean;
  sizeBytes: number;
  sourceHash: string;
};

type ImportPdfDocumentInput = {
  body: Uint8Array;
  contentType?: string | null;
  filename: string;
  maxSizeBytes?: number;
};

export class DocumentImportError extends Error {
  code: PdfImportFailureCode;

  constructor(
    code: PdfImportFailureCode,
    message = getPdfImportErrorMessage(code),
  ) {
    super(message);
    this.code = code;
    this.name = "DocumentImportError";
  }
}

export const DEFAULT_DOCUMENT_IMPORT_LIMITS = {
  maxSizeBytes: MAX_UPLOAD_SIZE_BYTES,
};

export function getPdfImportErrorMessage(code: PdfImportFailureCode): string {
  return PDF_IMPORT_ERROR_MESSAGES[code];
}

function assertImportRequest(input: {
  contentType?: string | null;
  filename: string;
  maxSizeBytes: number;
  sizeBytes: number;
}): void {
  if (!input.filename.toLowerCase().endsWith(".pdf")) {
    throw new DocumentImportError("invalid_type");
  }

  const normalizedContentType = input.contentType?.trim().toLowerCase() ?? "";

  if (
    normalizedContentType.length > 0 &&
    normalizedContentType !== "application/pdf"
  ) {
    throw new DocumentImportError("invalid_type");
  }

  if (input.sizeBytes > input.maxSizeBytes) {
    throw new DocumentImportError("too_large");
  }
}

function isPasswordException(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.trim().toLowerCase();

  return (
    error.name === "PasswordException" ||
    normalizedMessage.includes("password") ||
    normalizedMessage.includes("encrypted")
  );
}

function looksLikePdf(body: Uint8Array): boolean {
  if (body.length < PDF_MAGIC_HEADER.length) {
    return false;
  }

  const header = new TextDecoder("latin1").decode(
    body.subarray(0, PDF_MAGIC_HEADER.length),
  );

  return header === PDF_MAGIC_HEADER;
}

function maybeContainsXfa(body: Uint8Array): boolean {
  const prefix = new TextDecoder("latin1").decode(
    body.subarray(0, Math.min(body.length, 512 * 1024)),
  );

  return prefix.includes("/XFA");
}

function maybeContainsEncrypt(body: Uint8Array): boolean {
  const prefix = new TextDecoder("latin1").decode(
    body.subarray(0, Math.min(body.length, 512 * 1024)),
  );

  return prefix.includes("/Encrypt");
}

async function parsePdfDocument(
  body: Uint8Array,
): Promise<{ pages: ImportedPdfPage[]; pureXfa: boolean }> {
  const document = await PDFDocument.load(body, {
    ignoreEncryption: false,
  });

  const pages = document.getPages().map((page, index) => ({
    heightPt: page.getHeight(),
    pageNumber: index + 1,
    widthPt: page.getWidth(),
  }));

  return {
    pages,
    pureXfa: false,
  };
}

function hashDocument(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function importPdfDocument({
  body,
  contentType,
  filename,
  maxSizeBytes = DEFAULT_DOCUMENT_IMPORT_LIMITS.maxSizeBytes,
}: ImportPdfDocumentInput): Promise<ImportedPdfDocument> {
  const normalizedFilename = filename.trim() || "document.pdf";
  const sizeBytes = body.length;

  assertImportRequest({
    contentType,
    filename: normalizedFilename,
    maxSizeBytes,
    sizeBytes,
  });

  if (!looksLikePdf(body)) {
    throw new DocumentImportError("invalid_type");
  }

  const containsEncrypt = maybeContainsEncrypt(body);
  const containsXfa = maybeContainsXfa(body);
  const sourceHash = hashDocument(body);

  if (containsEncrypt) {
    throw new DocumentImportError("encrypted_pdf");
  }

  try {
    const { pages, pureXfa } = await parsePdfDocument(body.slice());

    if (pureXfa || containsXfa) {
      throw new DocumentImportError("unsupported_variant");
    }

    return {
      encrypted: false,
      filename: normalizedFilename,
      pageCount: pages.length,
      pages,
      pureXfa,
      sizeBytes,
      sourceHash,
    };
  } catch (error) {
    if (error instanceof DocumentImportError) {
      throw error;
    }

    if (isPasswordException(error) || containsXfa) {
      if (isPasswordException(error)) {
        throw new DocumentImportError("encrypted_pdf");
      }

      throw new DocumentImportError("unsupported_variant");
    }

    throw new DocumentImportError("unreadable_pdf");
  }
}

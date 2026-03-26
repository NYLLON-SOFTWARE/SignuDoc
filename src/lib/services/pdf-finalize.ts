import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";

import {
  auditEventRecordSchema,
  type AuditEventRecord,
  type EnvelopeRecord,
} from "../schemas/envelope.ts";
import type { FieldRecord } from "../schemas/field.ts";
import type { SignerRecord } from "../schemas/signer.ts";
import { normalizedRectToPdfRect } from "../utils/pdf-coords.ts";
import {
  buildEnvelopeCertificateKey,
  buildEnvelopeSignedPdfKey,
} from "./storage-keys.ts";
import {
  createStorageService,
  type StorageObjectRef,
  type StorageService,
} from "./storage.ts";

const TYPED_SIGNATURE_FONT_PATH = path.join(
  process.cwd(),
  "src",
  "assets",
  "fonts",
  "GreatVibes-Regular.ttf",
);
const DEFAULT_AUDIT_PAGE_SIZE = {
  height: 792,
  width: 612,
} as const;

let typedSignatureFontBytesPromise: Promise<Uint8Array> | null = null;

export type FinalizedEnvelopeArtifacts = {
  certificate: StorageObjectRef;
  generatedAt: number;
  signedPdf: StorageObjectRef;
};

export class PdfFinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfFinalizeError";
  }
}

function redactAuditEventMetadataForRecipients(
  metadata: AuditEventRecord["metadata"],
): AuditEventRecord["metadata"] {
  if (!metadata) {
    return null;
  }

  const nextMetadata = { ...metadata };

  delete nextMetadata.signerEmail;

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

function redactAuditEventForRecipients(
  event: AuditEventRecord,
): AuditEventRecord {
  return auditEventRecordSchema.parse({
    ...event,
    actorEmail:
      event.actorType === "signer" ? null : (event.actorEmail ?? null),
    ipAddress: null,
    metadata: redactAuditEventMetadataForRecipients(event.metadata ?? null),
    userAgent: null,
  });
}

type WrappedLine = {
  font: PDFFont;
  size: number;
  text: string;
};

function formatAuditTimestamp(timestamp: number | null | undefined): string {
  if (typeof timestamp !== "number") {
    return "—";
  }

  const value = new Date(timestamp * 1000);

  return value.toISOString().replace(".000Z", " UTC");
}

function chunkLongWord(
  font: PDFFont,
  size: number,
  maxWidth: number,
  word: string,
): string[] {
  if (font.widthOfTextAtSize(word, size) <= maxWidth) {
    return [word];
  }

  const chunks: string[] = [];
  let buffer = "";

  for (const character of word) {
    const candidate = `${buffer}${character}`;

    if (buffer && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      chunks.push(buffer);
      buffer = character;
      continue;
    }

    buffer = candidate;
  }

  if (buffer) {
    chunks.push(buffer);
  }

  return chunks;
}

function wrapText(
  font: PDFFont,
  size: number,
  maxWidth: number,
  text: string,
): WrappedLine[] {
  const normalized = text.trim();

  if (!normalized) {
    return [];
  }

  const rawWords = normalized
    .split(/\s+/)
    .flatMap((word) => chunkLongWord(font, size, maxWidth, word));
  const lines: string[] = [];
  let currentLine = "";

  for (const word of rawWords) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.map((line) => ({
    font,
    size,
    text: line,
  }));
}

function fitTextSize(
  font: PDFFont,
  text: string,
  maxWidth: number,
  maxHeight: number,
  preferredSize: number,
): number {
  let size = Math.min(preferredSize, maxHeight);

  while (size > 4 && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }

  return Math.max(4, size);
}

function getFieldPadding(widthPt: number, heightPt: number): number {
  return Math.max(2, Math.min(widthPt, heightPt) * 0.12);
}

function shouldStampField(field: FieldRecord): boolean {
  if (field.type === "checkbox") {
    return typeof field.checked === "boolean";
  }

  return typeof field.submittedAt === "number";
}

async function getTypedSignatureFontBytes(): Promise<Uint8Array> {
  typedSignatureFontBytesPromise ??= fs
    .readFile(TYPED_SIGNATURE_FONT_PATH)
    .then((buffer) => new Uint8Array(buffer));

  return typedSignatureFontBytesPromise;
}

function buildCompletedAuditEvent(
  envelopeId: string,
  generatedAt: number,
): AuditEventRecord {
  return {
    actorEmail: null,
    actorType: "system",
    createdAt: generatedAt,
    envelopeId,
    event: "completed",
    id: randomUUID(),
    ipAddress: null,
    metadata: null,
    userAgent: null,
  };
}

async function getEmbeddedPng(
  imageKey: string,
  imageCache: Map<string, PDFImage>,
  pdfDocument: PDFDocument,
  storageService: StorageService,
): Promise<PDFImage> {
  const cachedImage = imageCache.get(imageKey);

  if (cachedImage) {
    return cachedImage;
  }

  const imageObject = await storageService.getObject(imageKey);
  const embeddedImage = await pdfDocument.embedPng(imageObject.body);

  imageCache.set(imageKey, embeddedImage);

  return embeddedImage;
}

function stripCompletedAuditEvents(
  auditEvents: readonly AuditEventRecord[],
): AuditEventRecord[] {
  return auditEvents.filter((event) => event.event !== "completed");
}

function getEnvelopeStatusLabel(status: EnvelopeRecord["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "declined":
      return "Declined";
    case "voided":
      return "Voided";
    case "sent":
      return "Sent";
    case "draft":
      return "Draft";
    default:
      return status;
  }
}

function getCertificateTitle(envelope: EnvelopeRecord): string {
  return envelope.status === "completed"
    ? "SignuDoc Certificate of Completion"
    : "SignuDoc Audit Certificate";
}

function getTerminalTimestampLabel(envelope: EnvelopeRecord): string {
  switch (envelope.status) {
    case "completed":
      return "Completed at";
    case "declined":
      return "Declined at";
    case "voided":
      return "Voided at";
    default:
      return "Recorded at";
  }
}

function resolveTerminalTimestamp(
  envelope: EnvelopeRecord,
  fallbackTimestamp: number,
): number {
  switch (envelope.status) {
    case "completed":
      return envelope.completedAt ?? fallbackTimestamp;
    case "declined":
      return envelope.declinedAt ?? fallbackTimestamp;
    case "voided":
      return envelope.voidedAt ?? fallbackTimestamp;
    default:
      return fallbackTimestamp;
  }
}

function buildCertificateAuditEvents(input: {
  auditEvents: AuditEventRecord[];
  envelope: EnvelopeRecord;
  terminalTimestamp: number;
}): AuditEventRecord[] {
  const baseAuditEvents =
    input.envelope.status === "completed"
      ? stripCompletedAuditEvents(input.auditEvents)
      : input.auditEvents;
  const terminalAuditEvents =
    input.envelope.status === "completed"
      ? [buildCompletedAuditEvent(input.envelope.id, input.terminalTimestamp)]
      : [];

  return [...baseAuditEvents, ...terminalAuditEvents].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

async function stampFieldValue(
  field: FieldRecord,
  page: PDFPage,
  fonts: {
    auditBold: PDFFont;
    auditRegular: PDFFont;
    signature: PDFFont;
  },
  imageCache: Map<string, PDFImage>,
  pdfDocument: PDFDocument,
  storageService: StorageService,
): Promise<void> {
  if (!shouldStampField(field)) {
    return;
  }

  const rect = normalizedRectToPdfRect(field, {
    heightPt: page.getHeight(),
    widthPt: page.getWidth(),
  });
  const padding = getFieldPadding(rect.widthPt, rect.heightPt);

  switch (field.type) {
    case "signature":
    case "initials": {
      if (field.inputMethod === "drawn" && field.imageKey) {
        const image = await getEmbeddedPng(
          field.imageKey,
          imageCache,
          pdfDocument,
          storageService,
        );
        const maxWidth = Math.max(4, rect.widthPt - padding * 2);
        const maxHeight = Math.max(4, rect.heightPt - padding * 2);
        const scaled = image.scaleToFit(maxWidth, maxHeight);
        const x = rect.xPt + (rect.widthPt - scaled.width) / 2;
        const y = rect.yPt + (rect.heightPt - scaled.height) / 2;

        page.drawImage(image, {
          height: scaled.height,
          width: scaled.width,
          x,
          y,
        });

        return;
      }

      const signatureValue = field.value?.trim();

      if (!signatureValue) {
        return;
      }

      const maxWidth = Math.max(12, rect.widthPt - padding * 2);
      const maxHeight = Math.max(10, rect.heightPt - padding * 2);
      const fontSize = fitTextSize(
        fonts.signature,
        signatureValue,
        maxWidth,
        maxHeight,
        Math.min(maxHeight, rect.heightPt * 0.9),
      );

      page.drawText(signatureValue, {
        color: rgb(0.12, 0.12, 0.12),
        font: fonts.signature,
        size: fontSize,
        x: rect.xPt + padding,
        y: rect.yPt + (rect.heightPt - fontSize) / 2 + fontSize * 0.1,
      });

      return;
    }
    case "date":
    case "text": {
      const textValue = field.value?.trim();

      if (!textValue) {
        return;
      }

      const maxWidth = Math.max(12, rect.widthPt - padding * 2);
      const maxHeight = Math.max(10, rect.heightPt - padding * 2);
      const fontSize = fitTextSize(
        fonts.auditRegular,
        textValue,
        maxWidth,
        maxHeight,
        Math.min(maxHeight, rect.heightPt * 0.64),
      );

      page.drawText(textValue, {
        color: rgb(0.12, 0.12, 0.12),
        font: fonts.auditRegular,
        size: fontSize,
        x: rect.xPt + padding,
        y: rect.yPt + (rect.heightPt - fontSize) / 2 + fontSize * 0.2,
      });

      return;
    }
    case "checkbox": {
      const boxSize = Math.min(rect.widthPt, rect.heightPt, 14);
      const x = rect.xPt + padding / 2;
      const y = rect.yPt + (rect.heightPt - boxSize) / 2;

      page.drawRectangle({
        borderColor: rgb(0.18, 0.18, 0.18),
        borderWidth: 1.1,
        height: boxSize,
        width: boxSize,
        x,
        y,
      });

      if (field.checked) {
        page.drawLine({
          color: rgb(0.08, 0.08, 0.08),
          end: { x: x + boxSize * 0.42, y: y + boxSize * 0.2 },
          start: { x: x + boxSize * 0.16, y: y + boxSize * 0.5 },
          thickness: 1.4,
        });
        page.drawLine({
          color: rgb(0.08, 0.08, 0.08),
          end: { x: x + boxSize * 0.84, y: y + boxSize * 0.82 },
          start: { x: x + boxSize * 0.4, y: y + boxSize * 0.18 },
          thickness: 1.4,
        });
      }

      return;
    }
    default:
      return;
  }
}

function buildAuditLines(input: {
  auditEvents: AuditEventRecord[];
  completedAt: number;
  envelope: EnvelopeRecord;
  fonts: {
    bold: PDFFont;
    regular: PDFFont;
  };
  maxWidth: number;
  redactForRecipients?: boolean;
  signers: SignerRecord[];
}) {
  const titleFontSize = 18;
  const sectionFontSize = 11;
  const bodyFontSize = 9.25;
  const lines: Array<WrappedLine & { gapAfter?: number; gapBefore?: number }> =
    [];

  const pushParagraph = (
    text: string,
    font: PDFFont,
    size: number,
    options: { gapAfter?: number; gapBefore?: number } = {},
  ) => {
    const wrapped = wrapText(font, size, input.maxWidth, text);

    if (wrapped.length === 0) {
      return;
    }

    wrapped.forEach((line, index) => {
      lines.push({
        ...line,
        gapAfter: index === wrapped.length - 1 ? options.gapAfter : undefined,
        gapBefore: index === 0 ? options.gapBefore : undefined,
      });
    });
  };

  const terminalTimestamp = resolveTerminalTimestamp(
    input.envelope,
    input.completedAt,
  );
  const auditEvents = buildCertificateAuditEvents({
    auditEvents: input.auditEvents,
    envelope: input.envelope,
    terminalTimestamp,
  });

  pushParagraph(
    getCertificateTitle(input.envelope),
    input.fonts.bold,
    titleFontSize,
    {
      gapAfter: 8,
    },
  );
  pushParagraph(
    `Envelope ID: ${input.envelope.id}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `Document title: ${input.envelope.title}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `Source PDF: ${input.envelope.sourcePdfFilename}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `Source document hash: ${input.envelope.sourcePdfHash}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `Status: ${getEnvelopeStatusLabel(input.envelope.status)}`,
    input.fonts.regular,
    bodyFontSize,
  );
  pushParagraph(
    `${getTerminalTimestampLabel(input.envelope)}: ${formatAuditTimestamp(terminalTimestamp)}`,
    input.fonts.regular,
    bodyFontSize,
    {
      gapAfter: 10,
    },
  );

  pushParagraph("Signers", input.fonts.bold, sectionFontSize, {
    gapAfter: 4,
  });

  for (const signer of input.signers) {
    const actionLabel = getSignerCertificateActionLabel(
      input.envelope,
      signer,
    );
    const signerLabel = input.redactForRecipients
      ? `${signer.signOrder}. ${signer.name} | ${actionLabel}`
      : `${signer.signOrder}. ${signer.name} <${signer.email}> | ${actionLabel}`;

    pushParagraph(signerLabel, input.fonts.regular, bodyFontSize);
  }

  pushParagraph("Audit events", input.fonts.bold, sectionFontSize, {
    gapAfter: 4,
    gapBefore: 10,
  });

  for (const event of auditEvents) {
    const actor =
      event.actorEmail ??
      (typeof event.metadata?.signerEmail === "string"
        ? event.metadata.signerEmail
        : event.actorType);
    const signerName =
      typeof event.metadata?.signerName === "string"
        ? event.metadata.signerName
        : null;
    const actorLabel =
      signerName && actor !== signerName ? `${signerName} <${actor}>` : actor;

    pushParagraph(
      `${formatAuditTimestamp(event.createdAt)} | ${event.event} | ${actorLabel}`,
      input.fonts.regular,
      bodyFontSize,
    );
  }

  return lines;
}

function getSignerCertificateActionLabel(
  envelope: EnvelopeRecord,
  signer: SignerRecord,
): string {
  switch (signer.status) {
    case "signed":
      return `Signed at ${formatAuditTimestamp(signer.signedAt)}`;
    case "declined":
      return `Declined at ${formatAuditTimestamp(signer.declinedAt)}`;
    case "notified":
      if (envelope.status === "voided") {
        return "Awaiting signature when envelope was voided";
      }

      if (envelope.status === "declined") {
        return "Awaiting signature when envelope was declined";
      }

      return "Awaiting signature";
    case "pending":
      return "Not reached";
    default: {
      const exhaustiveStatus: never = signer.status;
      return exhaustiveStatus;
    }
  }
}

function appendAuditTrailPages(input: {
  auditEvents: AuditEventRecord[];
  completedAt: number;
  envelope: EnvelopeRecord;
  fonts: {
    bold: PDFFont;
    regular: PDFFont;
  };
  pdfDocument: PDFDocument;
  redactForRecipients?: boolean;
  signers: SignerRecord[];
}) {
  const templatePage = input.pdfDocument.getPageCount()
    ? input.pdfDocument.getPage(0)
    : null;
  const pageSize = templatePage
    ? {
        height: templatePage.getHeight(),
        width: templatePage.getWidth(),
      }
    : DEFAULT_AUDIT_PAGE_SIZE;
  const margin = 48;
  const maxWidth = pageSize.width - margin * 2;
  const lineHeightMultiplier = 1.24;
  const lines = buildAuditLines({
    auditEvents: input.auditEvents,
    completedAt: input.completedAt,
    envelope: input.envelope,
    fonts: input.fonts,
    maxWidth,
    redactForRecipients: input.redactForRecipients,
    signers: input.signers,
  });

  let page = input.pdfDocument.addPage([pageSize.width, pageSize.height]);
  let cursorY = pageSize.height - margin;

  for (const line of lines) {
    cursorY -= line.gapBefore ?? 0;

    const lineHeight = line.size * lineHeightMultiplier;

    if (cursorY - lineHeight < margin) {
      page = input.pdfDocument.addPage([pageSize.width, pageSize.height]);
      cursorY = pageSize.height - margin;
    }

    page.drawText(line.text, {
      color: rgb(0.14, 0.14, 0.14),
      font: line.font,
      size: line.size,
      x: margin,
      y: cursorY - line.size,
    });

    cursorY -= lineHeight;
    cursorY -= line.gapAfter ?? 0;
  }
}

export async function storeEnvelopeCertificatePdf(input: {
  auditEvents: AuditEventRecord[];
  envelope: EnvelopeRecord;
  certificate: StorageObjectRef;
  redactForRecipients?: boolean;
  signers: SignerRecord[];
  },
  {
    storageService = createStorageService(),
  }: {
    storageService?: StorageService;
  } = {},
): Promise<StorageObjectRef> {
  if (
    input.envelope.status !== "completed" &&
    input.envelope.status !== "declined" &&
    input.envelope.status !== "voided"
  ) {
    throw new PdfFinalizeError(
      "Certificates can only be generated for terminal envelopes.",
    );
  }

  const body = await renderEnvelopeCertificatePdf({
    auditEvents: input.auditEvents,
    envelope: input.envelope,
    redactForRecipients: input.redactForRecipients,
    signers: input.signers,
  });

  return storageService.putObject({
    body,
    contentType: "application/pdf",
    key: input.certificate.key,
  });
}

export async function storeRecipientEnvelopeCertificatePdf(
  input: {
    auditEvents: AuditEventRecord[];
    certificate: StorageObjectRef;
    envelope: EnvelopeRecord;
    signers: SignerRecord[];
  },
  {
    storageService = createStorageService(),
  }: {
    storageService?: StorageService;
  } = {},
): Promise<StorageObjectRef> {
  if (
    input.envelope.status !== "completed" &&
    input.envelope.status !== "declined" &&
    input.envelope.status !== "voided"
  ) {
    throw new PdfFinalizeError(
      "Evidence bundles can only be generated for terminal envelopes.",
    );
  }

  return storeEnvelopeCertificatePdf(
    {
      ...input,
      redactForRecipients: true,
    },
    {
      storageService,
    },
  );
}

export async function renderEnvelopeCertificatePdf(input: {
  auditEvents: AuditEventRecord[];
  envelope: EnvelopeRecord;
  redactForRecipients?: boolean;
  signers: SignerRecord[];
}): Promise<Uint8Array> {
  if (
    input.envelope.status !== "completed" &&
    input.envelope.status !== "declined" &&
    input.envelope.status !== "voided"
  ) {
    throw new PdfFinalizeError(
      "Certificates can only be generated for terminal envelopes.",
    );
  }

  const pdfDocument = await PDFDocument.create();
  const auditRegularFont = await pdfDocument.embedFont(StandardFonts.Helvetica);
  const auditBoldFont = await pdfDocument.embedFont(
    StandardFonts.HelveticaBold,
  );
  const terminalTimestamp = resolveTerminalTimestamp(
    input.envelope,
    Math.floor(Date.now() / 1000),
  );

  appendAuditTrailPages({
    auditEvents: input.redactForRecipients
      ? input.auditEvents.map(redactAuditEventForRecipients)
      : input.auditEvents,
    completedAt: terminalTimestamp,
    envelope: input.envelope,
    fonts: {
      bold: auditBoldFont,
      regular: auditRegularFont,
    },
    pdfDocument,
    redactForRecipients: input.redactForRecipients,
    signers: input.signers,
  });

  return pdfDocument.save({
    useObjectStreams: false,
  });
}

export async function renderFinalizedEnvelopePdf(
  input: {
    auditEvents: AuditEventRecord[];
    completedAt: number;
    envelope: EnvelopeRecord;
    fields: FieldRecord[];
    includeAuditTrail?: boolean;
    signers: SignerRecord[];
    sourcePdfKey: string;
  },
  {
    storageService = createStorageService(),
  }: {
    storageService?: StorageService;
  } = {},
): Promise<Uint8Array> {
  const sourcePdfObject = await storageService.getObject(input.sourcePdfKey);
  const pdfDocument = await PDFDocument.load(sourcePdfObject.body);

  pdfDocument.registerFontkit(fontkit);

  const signatureFont = await pdfDocument.embedFont(
    await getTypedSignatureFontBytes(),
  );
  const auditRegularFont = await pdfDocument.embedFont(StandardFonts.Helvetica);
  const auditBoldFont = await pdfDocument.embedFont(
    StandardFonts.HelveticaBold,
  );
  const imageCache = new Map<string, PDFImage>();

  for (const field of input.fields
    .filter(shouldStampField)
    .sort((left, right) => left.page - right.page || left.y - right.y)) {
    const page = pdfDocument.getPage(field.page - 1);

    if (!page) {
      throw new PdfFinalizeError(
        `Field ${field.id} references missing page ${field.page}.`,
      );
    }

    await stampFieldValue(
      field,
      page,
      {
        auditBold: auditBoldFont,
        auditRegular: auditRegularFont,
        signature: signatureFont,
      },
      imageCache,
      pdfDocument,
      storageService,
    );
  }

  try {
    pdfDocument.getForm().flatten();
  } catch {
    // Many source PDFs have no AcroForm. Stamping still produces the final locked view.
  }

  if (input.includeAuditTrail) {
    appendAuditTrailPages({
      auditEvents: stripCompletedAuditEvents(input.auditEvents),
      completedAt: input.completedAt,
      envelope: input.envelope,
      fonts: {
        bold: auditBoldFont,
        regular: auditRegularFont,
      },
      pdfDocument,
      signers: input.signers,
    });
  }

  return pdfDocument.save({
    useObjectStreams: false,
  });
}

export async function finalizeEnvelope(
  input: {
    auditEvents: AuditEventRecord[];
    envelope: EnvelopeRecord;
    fields: FieldRecord[];
    signers: SignerRecord[];
    sourcePdf: StorageObjectRef;
  },
  {
    storageService = createStorageService(),
  }: {
    storageService?: StorageService;
  } = {},
): Promise<FinalizedEnvelopeArtifacts> {
  const generatedAt = Math.floor(Date.now() / 1000);
  const storageIdentity = {
    envelopeId: input.envelope.id,
    userId: input.envelope.userId,
  };
  const signedPdfBytes = await renderFinalizedEnvelopePdf(
    {
      auditEvents: input.auditEvents,
      completedAt: generatedAt,
      envelope: input.envelope,
      fields: input.fields,
      signers: input.signers,
      sourcePdfKey: input.sourcePdf.key,
    },
    {
      storageService,
    },
  );
  const completedEnvelope = {
    ...input.envelope,
    completedAt: generatedAt,
    status: "completed" as const,
    updatedAt: generatedAt,
  };
  let signedPdf: StorageObjectRef | null = null;
  let certificate: StorageObjectRef | null = null;
  let recipientCertificate: StorageObjectRef | null = null;

  try {
    signedPdf = await storageService.putObject({
      body: signedPdfBytes,
      contentType: "application/pdf",
      key: buildEnvelopeSignedPdfKey(storageIdentity),
    });

    certificate = await storeEnvelopeCertificatePdf(
      {
        auditEvents: input.auditEvents,
        certificate: {
          bucketName: input.sourcePdf.bucketName,
          key: buildEnvelopeCertificateKey({
            ...storageIdentity,
            audience: "internal",
          }),
        },
        envelope: completedEnvelope,
        signers: input.signers,
      },
      {
        storageService,
      },
    );
    recipientCertificate = await storeRecipientEnvelopeCertificatePdf(
      {
        auditEvents: input.auditEvents,
        certificate: {
          bucketName: input.sourcePdf.bucketName,
          key: buildEnvelopeCertificateKey({
            ...storageIdentity,
            audience: "recipient",
          }),
        },
        envelope: completedEnvelope,
        signers: input.signers,
      },
      {
        storageService,
      },
    );

    return {
      certificate,
      generatedAt,
      signedPdf,
    };
  } catch (error) {
    await Promise.all([
      ...(signedPdf
        ? [storageService.deleteObject(signedPdf.key).catch(() => undefined)]
        : []),
      ...(certificate
        ? [storageService.deleteObject(certificate.key).catch(() => undefined)]
        : []),
      ...(recipientCertificate
        ? [
            storageService
              .deleteObject(recipientCertificate.key)
              .catch(() => undefined),
          ]
        : []),
    ]);
    throw error;
  }
}

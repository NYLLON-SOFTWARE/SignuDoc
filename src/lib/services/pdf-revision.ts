import { createHash } from "node:crypto";

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFImage,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";

import type { FieldRecord } from "../schemas/field.ts";
import { normalizedRectToPdfRect } from "../utils/pdf-coords.ts";
import { shouldStampField, stampFieldValue } from "./pdf-finalize.ts";
import { embedTextFaces } from "./pdf-fonts.ts";
import {
  appendIncrementalUpdate,
  prepareSignedUpdate,
  readTrailer,
  signaturePlaceholder,
  type UpdatedObject,
} from "./pdf-incremental.ts";
import type { StorageService } from "./storage.ts";

// Revisions for documents each signer signs with their own certificate.
//
// The document is prepared once (revision 0). Then each signer's turn adds
// one revision on top: their field values as locked annotations, and their
// signature field with a signature over the whole file so far. Nothing an
// earlier signer signed changes, so every signature stays valid, and a PDF
// reader can show the document as each signer saw it. The organization's
// seal and long-term validation go on last, the same way.
//
// Revisions are written with pdf-lib for drawing, then only the objects it
// added or changed are appended, by hand, as an incremental update.

/** Room for a signer's CMS: certificate chain, timestamp and some spare. */
export const SIGNER_SIGNATURE_BYTES = 32_768;

/** Print, read only, locked, contents locked. */
const LOCKED_ANNOTATION_FLAGS = 4 | 64 | 128 | 512;

/** Print, locked: a signature widget. */
const SIGNATURE_WIDGET_FLAGS = 4 | 128;

function serialize(object: PDFObject): Buffer {
  const buffer = new Uint8Array(object.sizeInBytes());

  object.copyBytesInto(buffer, 0);

  return Buffer.from(buffer);
}

type Snapshot = Map<string, { object: PDFObject; text: string | null }>;

/** How every object looks before an edit, to find what the edit changed. */
function snapshot(document: PDFDocument): Snapshot {
  const result: Snapshot = new Map();

  for (const [ref, object] of document.context.enumerateIndirectObjects()) {
    result.set(ref.tag, {
      object,
      // Streams are compared by identity: pdf-lib never edits one in place.
      text:
        object instanceof PDFStream
          ? object.dict.toString()
          : object.toString(),
    });
  }

  return result;
}

/** The object numbers reachable from the catalog. */
function reachable(document: PDFDocument, root: PDFRef): Set<string> {
  const seen = new Set<string>();
  const stack: PDFObject[] = [root];

  while (stack.length > 0) {
    const value = stack.pop()!;

    if (value instanceof PDFRef) {
      if (seen.has(value.tag)) {
        continue;
      }

      seen.add(value.tag);

      const target = document.context.lookup(value);

      if (target) {
        stack.push(target);
      }
    } else if (value instanceof PDFDict) {
      for (const [, entry] of value.entries()) {
        stack.push(entry);
      }
    } else if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index += 1) {
        stack.push(value.get(index));
      }
    } else if (value instanceof PDFStream) {
      stack.push(value.dict);
    }
  }

  return seen;
}

/** The objects an edit added or changed that the document still uses. */
function changedObjects(
  document: PDFDocument,
  before: Snapshot,
  root: PDFRef,
): UpdatedObject[] {
  const used = reachable(document, root);
  const objects: UpdatedObject[] = [];

  for (const [ref, object] of document.context.enumerateIndirectObjects()) {
    if (!used.has(ref.tag)) {
      continue;
    }

    const previous = before.get(ref.tag);
    const changed =
      !previous ||
      previous.object !== object ||
      previous.text !==
        (object instanceof PDFStream
          ? object.dict.toString()
          : object.toString());

    if (changed) {
      objects.push({
        body: serialize(object),
        ref: { generation: ref.generationNumber, number: ref.objectNumber },
      });
    }
  }

  return objects;
}

function pdfDate(date: Date): string {
  return `D:${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
}

function textString(value: string): string {
  return PDFHexString.fromText(value).toString();
}

export type RevisionSignature = {
  contactInfo?: string;
  /** Bytes kept for the CMS. */
  contentsBytes?: number;
  /** The signature field's name, unique in the document. */
  fieldName: string;
  location?: string;
  name?: string;
  reason?: string;
  signingTime: Date;
};

export type RevisionEditContext = {
  document: PDFDocument;
  /** Sets where the signature's widget shows, and what it shows. */
  placeSignature: (widget: {
    appearance?: PDFRef;
    page: PDFPage;
    rect: [number, number, number, number];
  }) => void;
};

/**
 * Appends one revision: what `edit` draws, and, with `signature`, a
 * signature field whose value is still to be signed. Returns the prepared
 * file and the bytes the signature must cover; `fillSignature` puts the
 * CMS in. Without `signature` the file comes back complete.
 */
export async function appendRevision(
  bytes: Uint8Array,
  {
    edit,
    signature,
  }: {
    edit?: (context: RevisionEditContext) => Promise<void>;
    signature?: RevisionSignature;
  },
): Promise<{ bytes: Uint8Array; signedContent: Buffer | null }> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const trailer = readTrailer(bytes);
  const root = PDFRef.of(trailer.root.number, trailer.root.generation);
  const before = snapshot(document);
  // Its number is taken now; the dictionary itself is written by hand.
  const signatureRef = signature ? document.context.nextRef() : null;
  let widget: {
    appearance?: PDFRef;
    page: PDFPage;
    rect: [number, number, number, number];
  } | null = null;

  await edit?.({
    document,
    placeSignature: (placed) => {
      widget = placed;
    },
  });

  if (signature && signatureRef) {
    const placed: {
      appearance?: PDFRef;
      page: PDFPage;
      rect: [number, number, number, number];
    } = widget ?? { page: document.getPage(0), rect: [0, 0, 0, 0] };
    const field = document.context.obj({
      F: SIGNATURE_WIDGET_FLAGS,
      FT: "Sig",
      P: placed.page.ref,
      Rect: placed.rect,
      Subtype: "Widget",
      T: PDFHexString.fromText(signature.fieldName),
      Type: "Annot",
      V: signatureRef,
    });

    if (placed.appearance) {
      field.set(
        PDFName.of("AP"),
        document.context.obj({ N: placed.appearance }),
      );
    }

    const fieldRef = document.context.register(field);
    const acroForm = document.catalog.getOrCreateAcroForm();
    const flags = acroForm.dict.lookupMaybe(PDFName.of("SigFlags"), PDFNumber);

    placed.page.node.addAnnot(fieldRef);
    acroForm.addField(fieldRef);
    acroForm.dict.set(
      PDFName.of("SigFlags"),
      PDFNumber.of((flags?.asNumber() ?? 0) | 3),
    );
  }

  await document.flush();

  const objects = changedObjects(document, before, root);

  if (!signature || !signatureRef) {
    return {
      bytes: appendIncrementalUpdate(bytes, objects),
      signedContent: null,
    };
  }

  const entries = [
    "/Type /Sig",
    "/Filter /Adobe.PPKLite",
    "/SubFilter /ETSI.CAdES.detached",
    `/M (${pdfDate(signature.signingTime)})`,
    ...(signature.name ? [`/Name ${textString(signature.name)}`] : []),
    ...(signature.reason ? [`/Reason ${textString(signature.reason)}`] : []),
    ...(signature.location
      ? [`/Location ${textString(signature.location)}`]
      : []),
    ...(signature.contactInfo
      ? [`/ContactInfo ${textString(signature.contactInfo)}`]
      : []),
    signaturePlaceholder(signature.contentsBytes ?? SIGNER_SIGNATURE_BYTES),
  ];

  objects.push({
    body: Buffer.from(`<<\n${entries.join("\n")}\n>>`, "latin1"),
    ref: {
      generation: signatureRef.generationNumber,
      number: signatureRef.objectNumber,
    },
  });

  const prepared = prepareSignedUpdate(bytes, objects);

  return { bytes: prepared.bytes, signedContent: prepared.signedContent };
}

/** SHA-256 of what a signature covers, as a CMS's messageDigest holds it. */
export function signedContentDigest(signedContent: Buffer): Buffer {
  return createHash("sha256").update(signedContent).digest();
}

/**
 * Revision 0: the source document, with any form it had flattened, saved
 * so that later revisions can be added to it (a classic cross-reference
 * table). Nothing is signed yet.
 */
export async function prepareRevisionZero(
  source: Uint8Array,
): Promise<Uint8Array> {
  const document = await PDFDocument.load(source, { updateMetadata: false });

  try {
    document.getForm().flatten();
  } catch {
    // Most source PDFs have no form.
  }

  return document.save({ useObjectStreams: false });
}

/**
 * One signer's revision: each of their field values drawn into its own
 * appearance, shown by a locked annotation over the field, and their first
 * signature field as the visible widget of their signature.
 *
 * `images` holds drawn signatures by key, since they are not stored yet.
 */
export async function prepareSignerRevision(
  base: Uint8Array,
  {
    fields,
    images,
    signature,
  }: {
    fields: readonly FieldRecord[];
    images: ReadonlyMap<string, Uint8Array>;
    signature: RevisionSignature;
  },
): Promise<{ bytes: Uint8Array; digest: Buffer }> {
  const imageStore = {
    getObject: async (key: string) => {
      const body = images.get(key);

      if (!body) {
        throw new Error(`The image ${key} is missing.`);
      }

      return { body };
    },
  } as unknown as StorageService;
  const prepared = await appendRevision(base, {
    edit: async ({ document, placeSignature }) => {
      const faces = await embedTextFaces(
        document,
        [fields.map((field) => field.value)],
        {
          signature: fields.some(
            (field) =>
              (field.type === "signature" || field.type === "initials") &&
              field.inputMethod !== "drawn",
          ),
        },
      );
      const imageCache = new Map<string, PDFImage>();
      let signaturePlaced = false;

      for (const field of fields.filter(shouldStampField)) {
        const page = document.getPage(field.page - 1);
        const size = { heightPt: page.getHeight(), widthPt: page.getWidth() };
        const rect = normalizedRectToPdfRect(field, size);
        // Drawn on a page of its own, then taken as a form XObject cut to
        // the field, so the original page's content is never touched.
        const scratch = document.addPage([size.widthPt, size.heightPt]);
        const box = {
          bottom: rect.yPt,
          left: rect.xPt,
          right: rect.xPt + rect.widthPt,
          top: rect.yPt + rect.heightPt,
        };

        await stampFieldValue(
          field,
          scratch,
          { auditRegular: faces.regular, signature: faces.signature },
          imageCache,
          document,
          imageStore,
        );

        const embedded = await document.embedPage(scratch, box);

        document.removePage(document.getPageCount() - 1);

        const annotationRect: [number, number, number, number] = [
          box.left,
          box.bottom,
          box.right,
          box.top,
        ];

        if (field.type === "signature" && !signaturePlaced) {
          signaturePlaced = true;
          placeSignature({
            appearance: embedded.ref,
            page,
            rect: annotationRect,
          });
          continue;
        }

        const annotation = document.context.register(
          document.context.obj({
            AP: { N: embedded.ref },
            F: LOCKED_ANNOTATION_FLAGS,
            NM: PDFHexString.fromText(`signudoc-field-${field.id ?? "field"}`),
            Rect: annotationRect,
            Subtype: "Stamp",
            Type: "Annot",
          }),
        );

        page.node.addAnnot(annotation);
      }
    },
    signature,
  });

  return {
    bytes: prepared.bytes,
    digest: signedContentDigest(prepared.signedContent!),
  };
}

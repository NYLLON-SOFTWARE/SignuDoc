import { createHash } from "node:crypto";

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from "pdf-lib";

// Incremental updates: new and changed objects appended after the end of a
// PDF, with their own cross-reference section, leaving every earlier byte
// as it was. That is the only way to add to a signed PDF without breaking
// its signatures, and it is how long-term validation data and archive
// timestamps go in after the seal.
//
// This handles the files SignuDoc itself writes: a classic cross-reference
// table (pdf-lib saved with object streams off), possibly followed by
// earlier updates of the same kind. A file whose last section is a
// cross-reference stream is refused.

export class PdfUpdateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfUpdateError";
  }
}

export type ObjectRef = { generation: number; number: number };

export type UpdatedObject = {
  /** The object's body: a dictionary, an array, or a stream. */
  body: Buffer;
  ref: ObjectRef;
};

export type Trailer = {
  id: string | null;
  info: string | null;
  root: ObjectRef;
  size: number;
  startxref: number;
};

const BYTE_RANGE_PLACEHOLDER =
  "/ByteRange [0 0000000000 0000000000 0000000000]";

function parseRef(text: string | undefined): ObjectRef | null {
  const match = text ? /^(\d+)\s+(\d+)\s+R$/.exec(text.trim()) : null;

  return match
    ? { generation: Number(match[2]), number: Number(match[1]) }
    : null;
}

function refText(ref: ObjectRef): string {
  return `${String(ref.number)} ${String(ref.generation)} R`;
}

/** The dictionary that starts at `start` ("<<"), nested ones included. */
function dictionaryAt(text: string, start: number): string {
  let depth = 0;

  for (let index = start; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);

    if (pair === "<<") {
      depth += 1;
      index += 1;
    } else if (pair === ">>") {
      depth -= 1;
      index += 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new PdfUpdateError("The PDF trailer is not closed.");
}

export function readTrailer(bytes: Uint8Array): Trailer {
  // Only the end of the file is needed, and a trailer is short.
  const tailStart = Math.max(0, bytes.length - 4096);
  const tail = Buffer.from(bytes.subarray(tailStart)).toString("latin1");
  const marker = tail.lastIndexOf("startxref");
  const startxref = Number(/startxref\s+(\d+)/.exec(tail.slice(marker))?.[1]);

  if (marker === -1 || !Number.isFinite(startxref)) {
    throw new PdfUpdateError("The PDF has no cross-reference offset.");
  }

  const text = Buffer.from(bytes).toString("latin1");

  if (!text.startsWith("xref", startxref)) {
    throw new PdfUpdateError(
      "The PDF uses a cross-reference stream, which cannot be updated here.",
    );
  }

  const trailerAt = text.indexOf("trailer", startxref);
  const dictionaryStart = text.indexOf("<<", trailerAt);

  if (trailerAt === -1 || dictionaryStart === -1) {
    throw new PdfUpdateError("The PDF has no trailer.");
  }

  const dictionary = dictionaryAt(text, dictionaryStart);

  if (/\/Encrypt\b/.test(dictionary)) {
    throw new PdfUpdateError("Encrypted PDFs cannot be updated here.");
  }

  const size = Number(/\/Size\s+(\d+)/.exec(dictionary)?.[1]);
  const root = parseRef(/\/Root\s+(\d+\s+\d+\s+R)/.exec(dictionary)?.[1]);

  if (!Number.isFinite(size) || !root) {
    throw new PdfUpdateError("The PDF trailer has no size or root.");
  }

  return {
    id: /\/ID\s*(\[[^\]]*\])/.exec(dictionary)?.[1] ?? null,
    info: /\/Info\s+(\d+\s+\d+\s+R)/.exec(dictionary)?.[1] ?? null,
    root,
    size,
    startxref,
  };
}

/**
 * Appends one update holding `objects`. An object with the number of an
 * existing one replaces it; any other number must be new, from
 * `nextObjectNumber` up.
 */
export function appendIncrementalUpdate(
  bytes: Uint8Array,
  objects: readonly UpdatedObject[],
): Uint8Array {
  if (objects.length === 0) {
    return bytes;
  }

  const trailer = readTrailer(bytes);
  const parts: Buffer[] = [Buffer.from(bytes)];
  let position = bytes.length;
  const offsets = new Map<number, { generation: number; offset: number }>();
  const push = (part: Buffer) => {
    parts.push(part);
    position += part.length;
  };

  if (bytes[bytes.length - 1] !== 0x0a) {
    push(Buffer.from("\n", "latin1"));
  }

  for (const object of objects) {
    offsets.set(object.ref.number, {
      generation: object.ref.generation,
      offset: position,
    });
    push(
      Buffer.concat([
        Buffer.from(
          `${String(object.ref.number)} ${String(object.ref.generation)} obj\n`,
          "latin1",
        ),
        object.body,
        Buffer.from("\nendobj\n", "latin1"),
      ]),
    );
  }

  const xrefOffset = position;
  const numbers = [...offsets.keys()].sort((a, b) => a - b);
  let xref = "xref\n";

  for (let index = 0; index < numbers.length;) {
    let end = index;

    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end]! + 1) {
      end += 1;
    }

    xref += `${String(numbers[index])} ${String(end - index + 1)}\n`;

    for (let entry = index; entry <= end; entry += 1) {
      const { generation, offset } = offsets.get(numbers[entry]!)!;

      xref += `${String(offset).padStart(10, "0")} ${String(generation).padStart(5, "0")} n\r\n`;
    }

    index = end + 1;
  }

  const size = Math.max(trailer.size, numbers[numbers.length - 1]! + 1);

  xref +=
    "trailer\n<<\n" +
    `/Size ${String(size)}\n` +
    `/Root ${refText(trailer.root)}\n` +
    (trailer.info ? `/Info ${trailer.info}\n` : "") +
    (trailer.id ? `/ID ${trailer.id}\n` : "") +
    `/Prev ${String(trailer.startxref)}\n` +
    ">>\n" +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;
  push(Buffer.from(xref, "latin1"));

  return new Uint8Array(Buffer.concat(parts));
}

/** A signature dictionary's /ByteRange and /Contents, to fill in later. */
export function signaturePlaceholder(contentsBytes: number): string {
  return `${BYTE_RANGE_PLACEHOLDER}\n/Contents <${"0".repeat(contentsBytes * 2)}>`;
}

export type PreparedSignedUpdate = {
  /** The file with the update appended, its byte range set, its slot empty. */
  bytes: Uint8Array;
  /** What the signature covers: the file without the signature slot. */
  signedContent: Buffer;
};

/**
 * Appends an update whose objects include one signature dictionary written
 * with `signaturePlaceholder`, and sets its byte range. The signature goes
 * in later, with `fillSignature`, so it can be made elsewhere (a trust
 * service provider) between the two.
 */
export function prepareSignedUpdate(
  bytes: Uint8Array,
  objects: readonly UpdatedObject[],
): PreparedSignedUpdate {
  const updated = Buffer.from(appendIncrementalUpdate(bytes, objects));
  const text = updated.toString("latin1");
  const rangeAt = text.indexOf(BYTE_RANGE_PLACEHOLDER, bytes.length);
  const contentsAt = text.indexOf("/Contents <", rangeAt);

  if (rangeAt === -1 || contentsAt === -1) {
    throw new PdfUpdateError("The update has no signature placeholder.");
  }

  const open = contentsAt + "/Contents ".length;
  const close = text.indexOf(">", open);
  const range = [0, open, close + 1, updated.length - close - 1];
  const rangeText = `/ByteRange [${range.join(" ")}]`;

  if (rangeText.length > BYTE_RANGE_PLACEHOLDER.length) {
    throw new PdfUpdateError("The PDF is too large to sign here.");
  }

  updated.write(
    rangeText.padEnd(BYTE_RANGE_PLACEHOLDER.length, " "),
    rangeAt,
    "latin1",
  );

  return {
    bytes: new Uint8Array(updated),
    signedContent: Buffer.concat([
      updated.subarray(0, open),
      updated.subarray(close + 1),
    ]),
  };
}

/** Puts a signature into the empty slot of the file's last signature. */
export function fillSignature(
  prepared: Uint8Array,
  signature: Buffer,
): Uint8Array {
  const updated = Buffer.from(prepared);
  const text = updated.toString("latin1");
  const rangeAt = text.lastIndexOf("/ByteRange [");
  const match = /^\/ByteRange \[0 (\d+) (\d+) (\d+)\s*\]/.exec(
    text.slice(rangeAt, rangeAt + BYTE_RANGE_PLACEHOLDER.length + 1),
  );

  if (rangeAt === -1 || !match) {
    throw new PdfUpdateError("The PDF has no signature slot to fill.");
  }

  const open = Number(match[1]);
  const close = Number(match[2]) - 1;
  const [, , resume, rest] = match.map(Number) as number[];

  if (
    text[open] !== "<" ||
    text[close] !== ">" ||
    resume! + rest! !== updated.length ||
    /[^0]/.test(text.slice(open + 1, close))
  ) {
    throw new PdfUpdateError("The signature slot is not empty, or has moved.");
  }

  const hex = signature.toString("hex");

  if (hex.length > close - open - 1) {
    throw new PdfUpdateError(
      `The signature (${String(signature.length)} bytes) does not fit its placeholder.`,
    );
  }

  updated.write(hex, open + 1, "latin1");

  return new Uint8Array(updated);
}

/**
 * Appends an update whose objects include one signature dictionary written
 * with `signaturePlaceholder`, then fills in its byte range and the value
 * `sign` makes over the bytes that range covers.
 */
export async function appendSignedUpdate(
  bytes: Uint8Array,
  objects: readonly UpdatedObject[],
  sign: (signedContent: Buffer) => Promise<Buffer>,
): Promise<Uint8Array> {
  const prepared = prepareSignedUpdate(bytes, objects);

  return fillSignature(prepared.bytes, await sign(prepared.signedContent));
}

// --- Reading what is already there ---------------------------------------

export type PdfSignature = {
  byteRange: [number, number, number, number];
  /** The CMS (or RFC 3161 token), without the zero padding. */
  contents: Buffer;
  subFilter: string | null;
};

/** The DER element at the start of a padded signature slot. */
function withoutPadding(slot: Buffer): Buffer {
  if (slot.length < 2) {
    return slot;
  }

  const first = slot[1]!;
  const lengthBytes = first < 0x80 ? 0 : first & 0x7f;
  const length = lengthBytes === 0 ? first : slot.readUIntBE(2, lengthBytes);

  return slot.subarray(0, 2 + lengthBytes + length);
}

/** Every signature and document timestamp in the file, oldest first. */
export function findSignatures(bytes: Uint8Array): PdfSignature[] {
  const text = Buffer.from(bytes).toString("latin1");
  const pattern = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const found: PdfSignature[] = [];
  const seen = new Set<number>();

  for (const match of text.matchAll(pattern)) {
    const range = match.slice(1, 5).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const [, length, resume] = range;

    if (seen.has(length) || text[length] !== "<" || text[resume - 1] !== ">") {
      continue;
    }

    seen.add(length);

    // The /SubFilter sits in the same dictionary, before or after.
    const dictionaryStart = text.lastIndexOf("<<", match.index);
    const around = text.slice(dictionaryStart, resume + 200);
    const subFilter = /\/SubFilter\s*\/([A-Za-z0-9.#]+)/.exec(around)?.[1];

    found.push({
      byteRange: range,
      contents: withoutPadding(
        Buffer.from(text.slice(length + 1, resume - 1), "hex"),
      ),
      subFilter: subFilter ?? null,
    });
  }

  return found.sort((a, b) => a.byteRange[1] - b.byteRange[1]);
}

/**
 * Loads the file's latest version with pdf-lib, to read the objects an
 * update changes. Nothing is saved from it: the update is written by hand.
 */
async function loadLatest(bytes: Uint8Array) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const trailer = readTrailer(bytes);
  let next = Math.max(trailer.size, document.context.largestObjectNumber + 1);

  return {
    allocate(): ObjectRef {
      const ref = { generation: 0, number: next };

      next += 1;
      return ref;
    },
    document,
    trailer,
  };
}

function objectBody(value: PDFObject): Buffer {
  return Buffer.from(value.toString(), "latin1");
}

function streamBody(data: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(`<<\n/Length ${String(data.length)}\n>>\nstream\n`, "latin1"),
    Buffer.from(data),
    Buffer.from("\nendstream", "latin1"),
  ]);
}

function toPdfRef(ref: ObjectRef): PDFRef {
  return PDFRef.of(ref.number, ref.generation);
}

function fromPdfRef(ref: PDFRef): ObjectRef {
  return { generation: ref.generationNumber, number: ref.objectNumber };
}

export type ValidationEntries = {
  certificates: readonly Uint8Array[];
  crls: readonly Uint8Array[];
  ocsps: readonly Uint8Array[];
};

function digestOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The streams an existing /DSS lists, by kind, with their digests. */
function existingDssEntries(
  document: PDFDocument,
  dss: PDFDict | undefined,
): Record<
  "CRLs" | "Certs" | "OCSPs",
  { digests: Set<string>; refs: PDFRef[] }
> {
  const result = {
    CRLs: { digests: new Set<string>(), refs: [] as PDFRef[] },
    Certs: { digests: new Set<string>(), refs: [] as PDFRef[] },
    OCSPs: { digests: new Set<string>(), refs: [] as PDFRef[] },
  };

  if (!dss) {
    return result;
  }

  for (const key of ["Certs", "OCSPs", "CRLs"] as const) {
    const list = dss.lookupMaybe(PDFName.of(key), PDFArray);

    for (let index = 0; index < (list?.size() ?? 0); index += 1) {
      const entry = list!.get(index);

      if (!(entry instanceof PDFRef)) {
        continue;
      }

      const stream = document.context.lookup(entry);

      if (stream instanceof PDFRawStream) {
        result[key].refs.push(entry);
        result[key].digests.add(digestOf(decodePDFRawStream(stream).decode()));
      }
    }
  }

  return result;
}

/**
 * Adds certificates, OCSP answers and revocation lists to the document
 * security store (/DSS, ISO 32000-2 12.8.4.3), keeping what it already
 * holds. Returns the file unchanged when everything is already there.
 */
export async function appendDocumentSecurityStore(
  bytes: Uint8Array,
  entries: ValidationEntries,
): Promise<Uint8Array> {
  const { allocate, document, trailer } = await loadLatest(bytes);
  const catalog = document.catalog;
  const existing = existingDssEntries(
    document,
    catalog.lookupMaybe(PDFName.of("DSS"), PDFDict),
  );
  const objects: UpdatedObject[] = [];
  const lists = {
    CRLs: entries.crls,
    Certs: entries.certificates,
    OCSPs: entries.ocsps,
  };
  let added = 0;

  for (const key of ["Certs", "OCSPs", "CRLs"] as const) {
    for (const data of lists[key]) {
      const digest = digestOf(data);

      if (existing[key].digests.has(digest)) {
        continue;
      }

      const ref = allocate();

      existing[key].digests.add(digest);
      existing[key].refs.push(toPdfRef(ref));
      objects.push({ body: streamBody(data), ref });
      added += 1;
    }
  }

  if (added === 0) {
    return bytes;
  }

  const dssRef = allocate();
  const dss = document.context.obj({ Type: "DSS" });

  for (const key of ["Certs", "OCSPs", "CRLs"] as const) {
    if (existing[key].refs.length > 0) {
      dss.set(PDFName.of(key), document.context.obj(existing[key].refs));
    }
  }

  objects.push({ body: objectBody(dss), ref: dssRef });
  catalog.set(PDFName.of("DSS"), toPdfRef(dssRef));
  declarePadesExtension(document, catalog);
  objects.push({ body: objectBody(catalog), ref: trailer.root });

  return appendIncrementalUpdate(bytes, objects);
}

/**
 * Names the extension that brought /DSS and document timestamps to PDF 1.7
 * (ESIC level 5), for readers that look for it.
 */
function declarePadesExtension(document: PDFDocument, catalog: PDFDict) {
  const esic = document.context.obj({
    BaseVersion: PDFName.of("1.7"),
    ExtensionLevel: 5,
  });
  const extensions = catalog.get(PDFName.of("Extensions"));

  if (extensions instanceof PDFDict) {
    if (!extensions.has(PDFName.of("ESIC"))) {
      extensions.set(PDFName.of("ESIC"), esic);
    }
  } else if (!extensions) {
    catalog.set(PDFName.of("Extensions"), document.context.obj({ ESIC: esic }));
  }
}

/**
 * Adds a document timestamp (/DocTimeStamp, ETSI.RFC3161) over the whole
 * file, as PAdES B-LTA puts after the validation data. `timestamp` gets the
 * SHA-256 of the covered bytes and returns the RFC 3161 token for it.
 */
export async function appendDocumentTimestamp(
  bytes: Uint8Array,
  timestamp: (digest: Buffer) => Promise<Buffer>,
  { contentsBytes = 16_384 }: { contentsBytes?: number } = {},
): Promise<Uint8Array> {
  const { allocate, document, trailer } = await loadLatest(bytes);
  const catalog = document.catalog;
  const page = document.getPage(0);
  const signatureRef = allocate();
  const fieldRef = allocate();
  const objects: UpdatedObject[] = [];
  // Field names must differ; the object number does.
  const fieldName = `SignuDoc archive timestamp ${String(fieldRef.number)}`;

  objects.push({
    body: Buffer.from(
      "<<\n/Type /DocTimeStamp\n/Filter /Adobe.PPKLite\n/SubFilter /ETSI.RFC3161\n" +
        `${signaturePlaceholder(contentsBytes)}\n>>`,
      "latin1",
    ),
    ref: signatureRef,
  });

  const field = document.context.obj({
    F: 132,
    FT: "Sig",
    P: page.ref,
    Rect: [0, 0, 0, 0],
    Subtype: "Widget",
    T: PDFString.of(fieldName),
    Type: "Annot",
    V: toPdfRef(signatureRef),
  });

  objects.push({ body: objectBody(field), ref: fieldRef });

  // The page lists the widget among its annotations.
  const annots = page.node.get(PDFName.of("Annots"));

  if (annots instanceof PDFRef) {
    const list = document.context.lookup(annots, PDFArray);

    list.push(toPdfRef(fieldRef));
    objects.push({ body: objectBody(list), ref: fromPdfRef(annots) });
  } else {
    if (annots instanceof PDFArray) {
      annots.push(toPdfRef(fieldRef));
    } else {
      page.node.set(
        PDFName.of("Annots"),
        document.context.obj([toPdfRef(fieldRef)]),
      );
    }

    objects.push({ body: objectBody(page.node), ref: fromPdfRef(page.ref) });
  }

  // The form lists the field, and says the file holds signatures.
  const acroFormValue = catalog.get(PDFName.of("AcroForm"));
  const acroForm =
    acroFormValue instanceof PDFRef
      ? document.context.lookup(acroFormValue, PDFDict)
      : acroFormValue instanceof PDFDict
        ? acroFormValue
        : document.context.obj({ Fields: [] });
  const fieldsValue = acroForm.get(PDFName.of("Fields"));

  if (fieldsValue instanceof PDFRef) {
    const list = document.context.lookup(fieldsValue, PDFArray);

    list.push(toPdfRef(fieldRef));
    objects.push({ body: objectBody(list), ref: fromPdfRef(fieldsValue) });
  } else if (fieldsValue instanceof PDFArray) {
    fieldsValue.push(toPdfRef(fieldRef));
  } else {
    acroForm.set(
      PDFName.of("Fields"),
      document.context.obj([toPdfRef(fieldRef)]),
    );
  }

  const flags = acroForm.lookupMaybe(PDFName.of("SigFlags"), PDFNumber);

  acroForm.set(
    PDFName.of("SigFlags"),
    PDFNumber.of((flags?.asNumber() ?? 0) | 3),
  );

  if (acroFormValue instanceof PDFRef) {
    objects.push({
      body: objectBody(acroForm),
      ref: fromPdfRef(acroFormValue),
    });
  } else {
    catalog.set(PDFName.of("AcroForm"), acroForm);
  }

  declarePadesExtension(document, catalog);
  objects.push({ body: objectBody(catalog), ref: trailer.root });

  return appendSignedUpdate(bytes, objects, async (content) =>
    timestamp(createHash("sha256").update(content).digest()),
  );
}

/** Whether the latest catalog has a document security store. */
export async function hasDocumentSecurityStore(
  bytes: Uint8Array,
): Promise<boolean> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });

  return Boolean(document.catalog.lookupMaybe(PDFName.of("DSS"), PDFDict));
}

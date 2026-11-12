import { NextResponse } from "next/server";
import { z } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import {
  buildCreateEnvelopeResponse,
  createDraftEnvelope,
} from "@/lib/envelopes";
import { getDb } from "@/lib/db/connection";
import { envelopeTitleSchema } from "@/lib/schemas/common";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { DocumentImportError } from "@/lib/services/document-import";
import {
  discardPendingUpload,
  PendingUploadError,
  readPendingUpload,
} from "@/lib/services/pending-uploads";
import {
  createStorageService,
  supportsDirectUploads,
  type StorageService,
} from "@/lib/services/storage";
import { isPendingUploadKey } from "@/lib/services/storage-keys";

export async function POST(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = applyRateLimit({
    category: "draft_envelope_create",
    key: buildRateLimitKey(["draft-create", session.user.id]),
    limit: 20,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const isDirectUpload = (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("application/json");
  const draftRequest = isDirectUpload
    ? await readDirectUploadRequest(request, session.user.id)
    : await readFormRequest(request);

  if (draftRequest instanceof Response) {
    return draftRequest;
  }

  try {
    const result = await createDraftEnvelope(
      session.user.id,
      {
        sourcePdf: await draftRequest.readSourcePdf(),
        title: draftRequest.title,
      },
      {
        database: getDb(),
      },
    );

    return NextResponse.json(buildCreateEnvelopeResponse(result), {
      status: 201,
    });
  } catch (error) {
    if (
      error instanceof DocumentImportError ||
      error instanceof PendingUploadError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logRouteError(error, {
      category: "draft_envelope_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating a draft envelope.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to create the draft envelope." },
      { status: 500 },
    );
  } finally {
    await draftRequest.cleanUp();
  }
}

type SourcePdf = {
  body: Uint8Array;
  contentType: string;
  filename: string;
};

type DraftRequest = {
  cleanUp: () => Promise<void>;
  readSourcePdf: () => Promise<SourcePdf>;
  title: string;
};

function invalidRequest(message = "Invalid envelope request.") {
  return NextResponse.json({ error: message }, { status: 400 });
}

// The PDF arrives in the request itself. Used with local storage; on Vercel
// a request this size would be refused before it reached the app.
async function readFormRequest(
  request: Request,
): Promise<DraftRequest | Response> {
  const formData = await request.formData().catch(() => null);
  const parsedTitle = envelopeTitleSchema.safeParse(formData?.get("title"));
  const uploadedFile = formData?.get("file");

  if (!parsedTitle.success) {
    return invalidRequest(parsedTitle.error.issues[0]?.message);
  }

  if (!(uploadedFile instanceof File)) {
    return invalidRequest("A PDF file is required.");
  }

  return {
    cleanUp: async () => undefined,
    readSourcePdf: async () => ({
      body: new Uint8Array(await uploadedFile.arrayBuffer()),
      contentType: uploadedFile.type,
      filename: uploadedFile.name,
    }),
    title: parsedTitle.data,
  };
}

const directUploadRequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  title: envelopeTitleSchema,
  uploadKey: z.string().min(1).max(512),
});

// The browser has already sent the PDF straight to storage and names where
// it put it. The file is read back and validated like any other upload, and
// the pending copy is deleted whether or not a draft comes out of it.
async function readDirectUploadRequest(
  request: Request,
  userId: string,
): Promise<DraftRequest | Response> {
  if (!supportsDirectUploads()) {
    return invalidRequest("Direct uploads are not available on this install.");
  }

  const parsedRequest = directUploadRequestSchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!parsedRequest.success) {
    const issue = parsedRequest.error.issues[0];

    return invalidRequest(
      issue?.path[0] === "title" ? issue.message : undefined,
    );
  }

  const { filename, title, uploadKey } = parsedRequest.data;

  // Checked here as well as on read, so that nothing outside the user's
  // own pending folder can ever be handed to cleanUp.
  if (!isPendingUploadKey(uploadKey, userId)) {
    return invalidRequest("Invalid upload reference.");
  }

  // Created on first use, inside the caller's error handling.
  let storageService: StorageService | undefined;

  return {
    cleanUp: async () => {
      if (storageService) {
        await discardPendingUpload({ key: uploadKey, storageService });
      }
    },
    readSourcePdf: async () => {
      storageService = createStorageService();

      return {
        body: await readPendingUpload({
          key: uploadKey,
          storageService,
          userId,
        }),
        contentType: "application/pdf",
        filename,
      };
    },
    title,
  };
}

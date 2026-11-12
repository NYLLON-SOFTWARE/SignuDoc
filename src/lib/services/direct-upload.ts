import { issueSignedToken, type IssuedSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";

import { MAX_UPLOAD_SIZE_BYTES } from "../types/domain.ts";
import { isPendingUploadKey } from "./storage-keys.ts";

// Direct uploads: the browser sends a PDF straight to Vercel Blob instead of
// through the app, because a request to a Vercel Function is capped at
// 4.5 MB. The app hands out a signed upload URL that is good for one
// pathname, PDFs only, up to the upload limit, for a few minutes.
//
// This uses signed URLs rather than Blob client tokens because signed URLs
// work with either kind of Blob credential (the project's OIDC token or a
// read-write token); client tokens need a read-write token.
// https://vercel.com/docs/vercel-blob/vercel-signed-urls#presigned-uploads

const UPLOAD_URL_LIFETIME_MS = 10 * 60 * 1000;
const PDF_CONTENT_TYPES = ["application/pdf"];
// An upload the app never picks up (a closed tab, a failed request) is
// deleted by Blob itself after a day. One day is the shortest it offers.
const PENDING_UPLOAD_TTL_DAYS = 1;
const GENERATE_URL_EVENT = "blob.generate-presigned-url";

export class DirectUploadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectUploadRequestError";
  }
}

type IssueUploadToken = (options: {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  operations: ["put"];
  pathname: string;
  validUntil: number;
}) => Promise<IssuedSignedToken>;

type AuthorizeDirectUploadInput = {
  body: unknown;
  /** Replaced in tests, where there is no Blob store to ask. */
  issueToken?: IssueUploadToken;
  request: Request;
  userId: string;
};

type GenerateUrlEvent = {
  payload: {
    clientPayload: string | null;
    multipart: boolean;
    pathname: string;
  };
  type: typeof GENERATE_URL_EVENT;
};

function parseGenerateUrlEvent(body: unknown): GenerateUrlEvent {
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { type?: unknown }).type !== GENERATE_URL_EVENT
  ) {
    throw new DirectUploadRequestError("Invalid upload request.");
  }

  const payload = (body as { payload?: unknown }).payload;

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { pathname?: unknown }).pathname !== "string"
  ) {
    throw new DirectUploadRequestError("Invalid upload request.");
  }

  return {
    payload: {
      clientPayload: null,
      multipart: (payload as { multipart?: unknown }).multipart === true,
      pathname: (payload as { pathname: string }).pathname,
    },
    type: GENERATE_URL_EVENT,
  };
}

/**
 * Answers the Blob SDK's request for somewhere to upload one PDF. Returns
 * the JSON the SDK in the browser expects. The caller must already have
 * checked that the request comes from a signed-in, verified user.
 */
export async function authorizeDirectUpload({
  body,
  issueToken = issueSignedToken,
  request,
  userId,
}: AuthorizeDirectUploadInput) {
  const event = parseGenerateUrlEvent(body);

  return handleUploadPresigned({
    body: event,
    getSignedToken: async (pathname, _clientPayload, multipart) => {
      if (multipart) {
        throw new DirectUploadRequestError(
          "Multipart uploads are not supported.",
        );
      }

      if (!isPendingUploadKey(pathname, userId)) {
        throw new DirectUploadRequestError("Invalid upload destination.");
      }

      const token = await issueToken({
        allowedContentTypes: PDF_CONTENT_TYPES,
        maximumSizeInBytes: MAX_UPLOAD_SIZE_BYTES,
        operations: ["put"],
        pathname,
        validUntil: Date.now() + UPLOAD_URL_LIFETIME_MS,
      });

      return {
        token,
        urlOptions: {
          addRandomSuffix: false,
          allowedContentTypes: PDF_CONTENT_TYPES,
          allowOverwrite: false,
          maximumSizeInBytes: MAX_UPLOAD_SIZE_BYTES,
          ttlDays: PENDING_UPLOAD_TTL_DAYS,
        },
      };
    },
    request,
    // The SDK insists on a key for checking "upload completed" callbacks
    // even when none are used. This app asks for no callback (the browser
    // reports back itself, and the file is validated when it does), and
    // parseGenerateUrlEvent has already turned away anything that is not a
    // request for an upload URL, so the key is never used to verify anything.
    webhookPublicKey:
      process.env.BLOB_WEBHOOK_PUBLIC_KEY?.trim() || "no-callbacks-used",
  });
}

import { createHash } from "node:crypto";

const API_ORIGIN = "https://www.googleapis.com";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const PDF_MIME_TYPE = "application/pdf";
const FILE_FIELDS =
  "id,parents,mimeType,trashed,appProperties,sha256Checksum,md5Checksum,size";
const DRIVE_ID = /^[A-Za-z0-9_-]+$/;
const REQUEST_TIMEOUT_MS = 15_000;

type RefreshCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type DriveOptions = {
  folderId: string;
  fetch?: typeof fetch;
} & (
  | (RefreshCredentials & { getAccessToken?: never })
  | {
      getAccessToken: (signal?: AbortSignal) => Promise<string>;
      clientId?: never;
      clientSecret?: never;
      refreshToken?: never;
    }
);

type DrivePdf = {
  artifact: "signed" | "certificate";
  bytes: Uint8Array;
  envelopeId: string;
  fileId: string;
  name: string;
};

export interface GoogleDriveClient {
  generateFileIds(count: number, signal?: AbortSignal): Promise<string[]>;
  uploadPdf(pdf: DrivePdf, signal?: AbortSignal): Promise<void>;
  verifyFolder(signal?: AbortSignal): Promise<void>;
}

export class GoogleDriveClientError extends Error {
  readonly operation: string;
  readonly status?: number;

  constructor(operation: string, status?: number) {
    super(
      `Google Drive ${operation}${status === undefined ? "" : ` (HTTP ${status})`}.`,
    );
    this.name = "GoogleDriveClientError";
    this.operation = operation;
    this.status = status;
  }
}

function apiUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(path, API_ORIGIN);
  url.search = new URLSearchParams(params).toString();
  return url;
}

function readUploadSession(response: Response): URL {
  try {
    const location = new URL(response.headers.get("location") ?? "");
    if (
      location.origin === API_ORIGIN &&
      location.pathname === "/upload/drive/v3/files" &&
      location.searchParams.has("upload_id") &&
      !location.username &&
      !location.password
    )
      return location;
  } catch {
    // Invalid or absent location. Never include the session URI in errors.
  }
  throw new GoogleDriveClientError("returned an invalid upload session");
}

function verifyPdf(
  metadata: {
    appProperties?: Record<string, string>;
    id?: string;
    md5Checksum?: string;
    mimeType?: string;
    parents?: string[];
    sha256Checksum?: string;
    size?: string;
    trashed?: boolean;
  } | null,
  folderId: string,
  pdf: DrivePdf,
) {
  const hash = metadata?.sha256Checksum ? "sha256" : "md5";
  const checksum = createHash(hash).update(pdf.bytes).digest("hex");
  if (
    metadata?.id !== pdf.fileId ||
    metadata.mimeType !== PDF_MIME_TYPE ||
    metadata.trashed !== false ||
    !Array.isArray(metadata.parents) ||
    metadata.parents.length !== 1 ||
    metadata.parents[0] !== folderId ||
    metadata.appProperties?.signudocEnvelope !== pdf.envelopeId ||
    metadata.appProperties?.signudocArtifact !== pdf.artifact ||
    metadata.size !== String(pdf.bytes.byteLength) ||
    (metadata.sha256Checksum ?? metadata.md5Checksum) !== checksum
  ) {
    throw new GoogleDriveClientError("could not verify the uploaded PDF");
  }
}

export function createGoogleDriveClient({
  folderId,
  fetch: send = fetch,
  ...credentials
}: DriveOptions): GoogleDriveClient {
  if (!DRIVE_ID.test(folderId)) {
    throw new GoogleDriveClientError("folder ID is invalid");
  }

  let cachedToken: { value: string; expiresAt: number } | undefined;

  async function request(
    url: string | URL,
    operation: string,
    init: RequestInit,
    signal?: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await send(url, {
        ...init,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new GoogleDriveClientError(operation);
    }
  }

  async function json<T>(response: Response, operation: string): Promise<T> {
    if (!response.ok) {
      if (response.status === 401) cachedToken = undefined;
      await response.body?.cancel().catch(() => undefined);
      throw new GoogleDriveClientError(operation, response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new GoogleDriveClientError(operation, response.status);
    }
  }

  async function authorization(signal?: AbortSignal): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return `Bearer ${cachedToken.value}`;
    }

    let token: unknown;
    if (credentials.getAccessToken) {
      try {
        token = await credentials.getAccessToken(signal);
      } catch {
        throw new GoogleDriveClientError("could not obtain an access token");
      }
    } else {
      const operation = "could not refresh the access token";
      const response = await request(
        TOKEN_ENDPOINT,
        operation,
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            grant_type: "refresh_token",
            refresh_token: credentials.refreshToken,
          }),
        },
        signal,
      );
      const data = await json<{
        access_token?: unknown;
        expires_in?: number;
      } | null>(response, operation);
      token = data?.access_token;
      if (
        typeof token === "string" &&
        /^[\x21-\x7E]+$/.test(token) &&
        typeof data?.expires_in === "number" &&
        Number.isFinite(data.expires_in)
      ) {
        cachedToken = {
          value: token,
          expiresAt: Date.now() + (data.expires_in - 30) * 1000,
        };
      }
    }
    if (typeof token !== "string" || !/^[\x21-\x7E]+$/.test(token)) {
      throw new GoogleDriveClientError("returned an invalid access token");
    }
    return `Bearer ${token}`;
  }

  return {
    async generateFileIds(count, signal) {
      const operation = "could not reserve file IDs";
      if (!Number.isInteger(count) || count < 1 || count > 1000) {
        throw new GoogleDriveClientError(operation);
      }
      const response = await request(
        apiUrl("/drive/v3/files/generateIds", {
          count: String(count),
          space: "drive",
          type: "files",
        }),
        operation,
        { headers: { authorization: await authorization(signal) } },
        signal,
      );
      const data = await json<{ ids?: unknown } | null>(response, operation);
      if (
        !Array.isArray(data?.ids) ||
        data.ids.length !== count ||
        data.ids.some(
          (id: unknown) => typeof id !== "string" || !DRIVE_ID.test(id),
        ) ||
        new Set(data.ids).size !== count
      ) {
        throw new GoogleDriveClientError("returned invalid reserved file IDs");
      }
      return data.ids as string[];
    },

    async uploadPdf(pdf, signal) {
      if (!DRIVE_ID.test(pdf.fileId) || !pdf.bytes.byteLength) {
        throw new GoogleDriveClientError("PDF upload inputs are invalid");
      }
      const authorizationHeader = await authorization(signal);
      const headers = { authorization: authorizationHeader };
      const operation = "could not open the PDF upload session";
      const appProperties = {
        signudocEnvelope: pdf.envelopeId,
        signudocArtifact: pdf.artifact,
      };
      // A complete request per attempt works for both small and large PDFs.
      // A failed attempt can start again safely with the same stored file ID.
      let response = await request(
        apiUrl("/upload/drive/v3/files", {
          fields: FILE_FIELDS,
          supportsAllDrives: "true",
          uploadType: "resumable",
        }),
        operation,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-type": PDF_MIME_TYPE,
            "x-upload-content-length": String(pdf.bytes.byteLength),
          },
          body: JSON.stringify({
            appProperties,
            id: pdf.fileId,
            mimeType: PDF_MIME_TYPE,
            name: pdf.name,
            parents: [folderId],
          }),
        },
        signal,
      );
      if (response.status !== 409) {
        if (!response.ok) await json(response, operation);
        const uploadSession = readUploadSession(response);
        await response.body?.cancel().catch(() => undefined);
        response = await request(
          uploadSession,
          "could not upload the PDF",
          {
            method: "PUT",
            headers: { ...headers, "content-type": PDF_MIME_TYPE },
            body: new Uint8Array(pdf.bytes),
          },
          signal,
        );
      }
      if (response.status === 409) {
        await response.body?.cancel().catch(() => undefined);
        response = await request(
          apiUrl(`/drive/v3/files/${pdf.fileId}`, {
            fields: FILE_FIELDS,
            supportsAllDrives: "true",
          }),
          "could not look up the previously uploaded PDF",
          { headers },
          signal,
        );
      }
      verifyPdf(
        await json(response, "could not confirm the PDF upload"),
        folderId,
        pdf,
      );
    },

    async verifyFolder(signal) {
      const operation = "could not read the filing folder";
      const response = await request(
        apiUrl(`/drive/v3/files/${folderId}`, {
          fields: "id,mimeType,trashed,capabilities(canAddChildren)",
          supportsAllDrives: "true",
        }),
        operation,
        { headers: { authorization: await authorization(signal) } },
        signal,
      );
      const folder = await json<{
        id?: string;
        mimeType?: string;
        trashed?: boolean;
        capabilities?: { canAddChildren?: boolean };
      } | null>(response, operation);
      if (
        folder?.id !== folderId ||
        folder.mimeType !== FOLDER_MIME_TYPE ||
        folder.trashed !== false ||
        folder.capabilities?.canAddChildren !== true
      ) {
        throw new GoogleDriveClientError(
          "filing folder is unavailable for uploads",
        );
      }
    },
  };
}

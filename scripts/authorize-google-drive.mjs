import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const driveFileScope = "https://www.googleapis.com/auth/drive.file";
const folderMimeType = "application/vnd.google-apps.folder";
const callbackPath = "/oauth/callback";

function uniqueValue(params, name) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

export function matchesState(params, state) {
  const actual = uniqueValue(params, "state");
  return (
    typeof actual === "string" &&
    Buffer.byteLength(actual) === Buffer.byteLength(state) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(state))
  );
}

export function readGooglePickerCode(params, folderId) {
  if (params.has("error"))
    throw new Error("Google authorization was declined.");
  if (uniqueValue(params, "picked_file_ids") !== folderId) {
    throw new Error("Select only the configured Google Drive folder.");
  }

  const code = uniqueValue(params, "code");
  if (!code || uniqueValue(params, "scope") !== driveFileScope) {
    throw new Error("Google returned an incomplete authorization response.");
  }

  return code;
}

async function requestGoogleJson(url, options, operation) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new Error(`Google ${operation} could not be reached.`);
  });
  if (!response.ok) {
    throw new Error(`Google ${operation} failed (HTTP ${response.status}).`);
  }
  return response.json().catch(() => {
    throw new Error(`Google ${operation} returned invalid JSON.`);
  });
}

async function saveGoogleDriveGrant({
  clientId,
  clientSecret,
  code,
  folderId,
  redirectUri,
  verifier,
}) {
  const tokens = await requestGoogleJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    },
    "token exchange",
  );
  if (
    tokens?.scope !== driveFileScope ||
    typeof tokens.access_token !== "string" ||
    !/^[!-~]+$/.test(tokens.access_token) ||
    typeof tokens.refresh_token !== "string" ||
    !/^[!-~]+$/.test(tokens.refresh_token)
  ) {
    throw new Error("Google did not return the expected offline Drive grant.");
  }

  const url = new URL(`https://www.googleapis.com/drive/v3/files/${folderId}`);
  url.search = new URLSearchParams({
    fields: "id,mimeType,trashed,capabilities(canAddChildren)",
    supportsAllDrives: "true",
  }).toString();
  const folder = await requestGoogleJson(
    url,
    {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
    "folder verification",
  );
  if (
    folder?.id !== folderId ||
    folder.mimeType !== folderMimeType ||
    folder.trashed !== false ||
    folder.capabilities?.canAddChildren !== true
  ) {
    throw new Error(
      "Google did not confirm that the selected folder accepts new files.",
    );
  }

  const path = join(
    await mkdtemp(join(tmpdir(), "signudoc-drive-")),
    "refresh-token",
  );
  await writeFile(path, tokens.refresh_token, { mode: 0o600, flag: "wx" });
  return path;
}

async function authorize() {
  const clientId = process.env.SIGNUDOC_DRIVE_CLIENT_ID;
  const clientSecret = process.env.SIGNUDOC_DRIVE_CLIENT_SECRET;
  const folderId = process.env.SIGNUDOC_DRIVE_FOLDER_ID;
  if (!clientId || !clientSecret || !folderId || !/^[\w-]+$/.test(folderId)) {
    throw new Error(
      "Set the Desktop OAuth client ID, client secret, and destination folder ID.",
    );
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const startPath = `/start/${randomBytes(24).toString("base64url")}`;
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const redirectUri = `${origin}${callbackPath}`;
  const authorizationUrl = new URL(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  authorizationUrl.search = new URLSearchParams({
    access_type: "offline",
    allow_folder_selection: "true",
    client_id: clientId,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    file_ids: folderId,
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: driveFileScope,
    state,
    trigger_onepick: "true",
  }).toString();

  let timer;
  let callbackStarted = false;
  try {
    const tokenPath = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Google Drive authorization timed out.")),
        300_000,
      );
      server.on("request", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        const url = URL.parse(request.url ?? "", origin);
        if (
          request.method !== "GET" ||
          url?.origin !== origin ||
          request.headers.host !== new URL(origin).host
        ) {
          return response.writeHead(400).end("Invalid setup request.");
        }
        if (url.pathname === startPath) {
          return response
            .writeHead(303, { Location: authorizationUrl.href })
            .end();
        }
        if (
          url.pathname !== callbackPath ||
          callbackStarted ||
          !matchesState(url.searchParams, state)
        ) {
          return response
            .writeHead(400)
            .end("Invalid or expired Google authorization response.");
        }

        callbackStarted = true;
        clearTimeout(timer);
        try {
          const code = readGooglePickerCode(url.searchParams, folderId);
          const path = await saveGoogleDriveGrant({
            clientId,
            clientSecret,
            code,
            folderId,
            redirectUri,
            verifier,
          });
          response.end("Google Drive access verified. You can close this tab.");
          resolve(path);
        } catch (error) {
          response
            .writeHead(400)
            .end(
              "Could not verify Google Drive access. Check the setup terminal.",
            );
          reject(error);
        }
      });
      console.error(
        `Open ${origin}${startPath} in your browser and select the configured folder.`,
      );
    });
    console.log(tokenPath);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

if (import.meta.main) {
  authorize().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

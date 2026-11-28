import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  matchesState,
  readGooglePickerCode,
} from "../../../scripts/authorize-google-drive.mjs";

const expectedFolder = "expected-folder";
const scope = "https://www.googleapis.com/auth/drive.file";
const state = "state-for-this-request";
const code = "fixture-auth-code";
const token = "fixture-refresh-token";

function callbackParams() {
  return new URLSearchParams({
    state,
    code,
    picked_file_ids: expectedFolder,
    scope,
  });
}

test("Google Picker callback accepts the selected folder and the requested scope", () => {
  const params = callbackParams();

  assert.equal(matchesState(params, state), true);
  assert.equal(readGooglePickerCode(params, expectedFolder), code);
});

test("OAuth state must match exactly and appear once", () => {
  for (const actual of [null, "", "bad-state", "state-for-this-requesX"]) {
    const params = callbackParams();
    if (actual === null) {
      params.delete("state");
    } else {
      params.set("state", actual);
    }
    assert.equal(matchesState(params, state), false);
  }

  const duplicate = callbackParams();
  duplicate.append("state", state);
  assert.equal(matchesState(duplicate, state), false);
});

test("Google Picker rejects missing or repeated code, scope, and folder fields", () => {
  const expectedErrors = {
    code: /incomplete authorization response/,
    scope: /incomplete authorization response/,
    picked_file_ids: /Select only the configured Google Drive folder/,
  } as const;

  for (const field of Object.keys(
    expectedErrors,
  ) as (keyof typeof expectedErrors)[]) {
    const missing = callbackParams();
    missing.delete(field);
    assert.throws(
      () => readGooglePickerCode(missing, expectedFolder),
      expectedErrors[field],
    );

    const duplicate = callbackParams();
    duplicate.append(field, duplicate.get(field)!);
    assert.throws(
      () => readGooglePickerCode(duplicate, expectedFolder),
      expectedErrors[field],
    );
  }
});

test("Google Picker rejects a different folder, multiple folders, and expanded scopes", () => {
  for (const selected of ["other-folder", `${expectedFolder},other-folder`]) {
    const params = callbackParams();
    params.set("picked_file_ids", selected);
    assert.throws(
      () => readGooglePickerCode(params, expectedFolder),
      /Select only the configured Google Drive folder/,
    );
  }

  const params = callbackParams();
  params.set("scope", `${scope} https://www.googleapis.com/auth/drive`);
  assert.throws(
    () => readGooglePickerCode(params, expectedFolder),
    /incomplete authorization response/,
  );
});

test("Google Picker does not exchange a code after declined consent", () => {
  const params = callbackParams();
  params.set("error", "access_denied");
  assert.throws(
    () => readGooglePickerCode(params, expectedFolder),
    /authorization was declined/,
  );
});

test(
  "Drive authorization verifies the folder and saves the grant privately",
  { timeout: 15_000 },
  async ({ signal }) => {
    const temp = await mkdtemp(join(tmpdir(), "drive-authorization-test-"));
    const provider = `
    import assert from "node:assert/strict";
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      assert.equal(options.redirect, "error");
      if (url.href === "https://oauth2.googleapis.com/token") {
        assert.equal(options.method, "POST");
        assert.equal(options.body.get("grant_type"), "authorization_code");
        assert.equal(options.body.get("code"), ${JSON.stringify(code)});
        assert.match(options.body.get("code_verifier"), /^[\\w-]{64}$/);
        assert.match(options.body.get("redirect_uri"), /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/oauth\\/callback$/);
        return Response.json({
          scope: ${JSON.stringify(scope)},
          access_token: "fixture-access-token",
          refresh_token: ${JSON.stringify(token)},
        });
      }
      assert.equal(url.origin, "https://www.googleapis.com");
      assert.equal(url.pathname, "/drive/v3/files/" + ${JSON.stringify(expectedFolder)});
      assert.equal(options.headers.Authorization, "Bearer fixture-access-token");
      return Response.json({
        id: ${JSON.stringify(expectedFolder)},
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
        capabilities: { canAddChildren: true },
      });
    };
  `;
    const script = fileURLToPath(
      new URL("../../../scripts/authorize-google-drive.mjs", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(provider)}`,
        script,
      ],
      {
        env: {
          NODE_ENV: "test",
          TMPDIR: temp,
          TEMP: temp,
          SIGNUDOC_DRIVE_CLIENT_ID: "fixture-client-id",
          SIGNUDOC_DRIVE_CLIENT_SECRET: "fixture-client-secret",
          SIGNUDOC_DRIVE_FOLDER_ID: expectedFolder,
        },
        signal,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const closed = once(child, "close");
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });

    try {
      const started = new Promise<string>((resolve) => {
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
          const url = /Open (http:\/\/127\.0\.0\.1:\d+\/start\/[\w-]+) /.exec(
            stderr,
          )?.[1];
          if (url) resolve(url);
        });
      });
      const startUrl = await Promise.race([
        started,
        closed.then(() => {
          throw new Error(
            `Authorization helper exited before startup: ${stderr}`,
          );
        }),
      ]);

      const startResponse = await fetch(startUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(4_000),
      });
      assert.equal(startResponse.status, 303);
      const googleUrl = new URL(startResponse.headers.get("location")!);
      assert.equal(googleUrl.origin, "https://accounts.google.com");
      assert.equal(googleUrl.searchParams.get("scope"), scope);
      assert.equal(googleUrl.searchParams.get("access_type"), "offline");
      assert.equal(googleUrl.searchParams.get("code_challenge_method"), "S256");
      assert.equal(googleUrl.searchParams.get("file_ids"), expectedFolder);
      assert.equal(googleUrl.searchParams.get("trigger_onepick"), "true");
      assert.equal(googleUrl.searchParams.has("client_secret"), false);

      const callback = new URL(googleUrl.searchParams.get("redirect_uri")!);
      callback.search = callbackParams().toString();
      let response = await fetch(callback, {
        signal: AbortSignal.timeout(4_000),
      });
      assert.equal(response.status, 400);
      await response.text();

      callback.searchParams.set("state", googleUrl.searchParams.get("state")!);
      callback.searchParams.append(
        "state",
        googleUrl.searchParams.get("state")!,
      );
      response = await fetch(callback, { signal: AbortSignal.timeout(4_000) });
      assert.equal(response.status, 400);
      await response.text();

      callback.searchParams.set("state", googleUrl.searchParams.get("state")!);
      response = await fetch(callback, { signal: AbortSignal.timeout(4_000) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Google Drive access verified/);
      const [exitCode] = await closed;
      assert.equal(exitCode, 0, stderr);
      assert.doesNotMatch(
        stdout + stderr,
        /fixture-refresh-token|fixture-client-secret/,
      );

      const tokenFile = stdout.trim();
      assert.equal(await readFile(tokenFile, "utf8"), token);
      if (process.platform !== "win32") {
        assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
      }
    } finally {
      child.kill();
      await closed.catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

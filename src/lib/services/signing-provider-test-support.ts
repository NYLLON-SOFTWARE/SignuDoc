import {
  createHash,
  createSign,
  privateEncrypt,
  randomBytes,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { algorithm } from "./der.ts";
import {
  assembleSignedData,
  buildSignedAttributes,
  CMS_OIDS,
} from "./signer-cms.ts";

// Stand-ins for eID Easy and a Cloud Signature Consortium API v2 provider,
// for tests. Each signs with the key of a certificate from the test CA, the
// way the real services sign with the signer's key, and keeps to the parts
// of the protocols the clients use: client credentials, the redirect back
// with the state, PKCE, and a signature only for the hash the signer
// authorized.

export const STAND_IN_CLIENT = { id: "test-client", secret: "test-secret" };

export type StandInSigner = {
  /** The signer's certificate first, then the CA's. */
  chain: Buffer[];
  privateKeyPem: string;
};

export type ProviderStandIns = {
  close: () => Promise<void>;
  cscUrl: string;
  eidEasyUrl: string;
  state: {
    /** The query of the last CSC authorize request. */
    lastAuthorize: URLSearchParams | null;
    /** Signing requests refused for a hash nobody authorized. */
    refusedHashes: number;
    /** When true, the signer cancels at the provider. */
    signerCancels: boolean;
  };
};

const SHA256_DIGEST_INFO = Buffer.from(
  "3031300d060960864801650304020105000420",
  "hex",
);

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown) {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(302, { location }).end();
}

/** A CAdES signature of `digest`, as eID Easy returns one. */
function cmsForDigest(signer: StandInSigner, digest: Buffer): Buffer {
  const signedAttributes = buildSignedAttributes({
    certificate: signer.chain[0]!,
    contentDigest: digest,
  });

  return assembleSignedData({
    certificates: signer.chain,
    signature: createSign("sha256")
      .update(signedAttributes)
      .sign(signer.privateKeyPem),
    signatureAlgorithm: algorithm(CMS_OIDS.sha256WithRsa),
    signedAttributes,
  });
}

export async function startProviderStandIns(
  signer: StandInSigner,
  { port = 0 }: { port?: number } = {},
): Promise<ProviderStandIns> {
  const state: ProviderStandIns["state"] = {
    lastAuthorize: null,
    refusedHashes: 0,
    signerCancels: false,
  };
  const documents = new Map<
    string,
    { digest: Buffer; redirect: string; signed: boolean }
  >();
  const codes = new Map<
    string,
    {
      challenge: string;
      hashes: string | null;
      redirectUri: string;
      scope: string;
    }
  >();
  const tokens = new Map<string, { hashes: string | null; scope: string }>();
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500).end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://stand-in");
    const body = request.method === "POST" ? await readBody(request) : "";

    if (url.pathname === "/health") {
      json(response, 200, { status: "OK" });
      return;
    }

    // --- eID Easy ---
    if (url.pathname === "/eideasy/api/signatures/prepare-files-for-signing") {
      const input = JSON.parse(body) as {
        client_id: string;
        container_type: string;
        files: { fileContent: string }[];
        secret: string;
        signature_redirect: string;
      };

      if (
        input.client_id !== STAND_IN_CLIENT.id ||
        input.secret !== STAND_IN_CLIENT.secret
      ) {
        json(response, 401, { message: "Unknown client", status: "error" });
        return;
      }

      if (input.container_type !== "cades" || input.files.length !== 1) {
        json(response, 422, { message: "Unsupported", status: "error" });
        return;
      }

      const docId = randomBytes(8).toString("hex");

      documents.set(docId, {
        digest: Buffer.from(input.files[0]!.fileContent, "base64"),
        redirect: input.signature_redirect,
        signed: false,
      });
      json(response, 200, { doc_id: docId, status: "OK" });
      return;
    }

    if (url.pathname === "/eideasy/sign_contract_external") {
      const document = documents.get(url.searchParams.get("doc_id") ?? "");

      if (
        !document ||
        url.searchParams.get("client_id") !== STAND_IN_CLIENT.id
      ) {
        response.writeHead(404).end();
        return;
      }

      // The signer identifies themselves and approves.
      document.signed = !state.signerCancels;
      redirect(response, document.redirect);
      return;
    }

    if (url.pathname === "/eideasy/api/signatures/download-signed-file") {
      const input = JSON.parse(body) as {
        client_id: string;
        doc_id: string;
        secret: string;
      };
      const document = documents.get(input.doc_id);

      if (
        input.client_id !== STAND_IN_CLIENT.id ||
        input.secret !== STAND_IN_CLIENT.secret
      ) {
        json(response, 401, { message: "Unknown client", status: "error" });
        return;
      }

      if (!document?.signed) {
        json(response, 200, { message: "Not signed", status: "error" });
        return;
      }

      json(response, 200, {
        signed_file_contents: cmsForDigest(signer, document.digest).toString(
          "base64",
        ),
        signing_method: "smart-id-signature",
        status: "OK",
      });
      return;
    }

    // --- CSC API v2 ---
    if (url.pathname === "/csc/oauth2/authorize") {
      const query = url.searchParams;

      state.lastAuthorize = query;

      if (
        query.get("client_id") !== STAND_IN_CLIENT.id ||
        query.get("code_challenge_method") !== "S256" ||
        query.get("response_type") !== "code"
      ) {
        response.writeHead(400).end();
        return;
      }

      const back = new URL(query.get("redirect_uri")!);

      back.searchParams.set("state", query.get("state") ?? "");

      if (state.signerCancels) {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "The user cancelled");
        redirect(response, back.toString());
        return;
      }

      const code = randomBytes(8).toString("hex");

      codes.set(code, {
        challenge: query.get("code_challenge")!,
        hashes: query.get("hashes"),
        redirectUri: query.get("redirect_uri")!,
        scope: query.get("scope")!,
      });
      back.searchParams.set("code", code);
      redirect(response, back.toString());
      return;
    }

    if (url.pathname === "/csc/oauth2/token") {
      const form = new URLSearchParams(body);
      const grant = codes.get(form.get("code") ?? "");

      codes.delete(form.get("code") ?? "");

      if (
        !grant ||
        form.get("client_id") !== STAND_IN_CLIENT.id ||
        form.get("client_secret") !== STAND_IN_CLIENT.secret ||
        form.get("redirect_uri") !== grant.redirectUri ||
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") !== grant.challenge
      ) {
        json(response, 400, { error: "invalid_grant" });
        return;
      }

      const token = randomBytes(16).toString("hex");

      tokens.set(token, { hashes: grant.hashes, scope: grant.scope });
      json(response, 200, { access_token: token, token_type: "Bearer" });
      return;
    }

    const token = tokens.get(
      (request.headers.authorization ?? "").replace(/^Bearer /, ""),
    );

    if (url.pathname === "/csc/credentials/list") {
      if (token?.scope !== "service") {
        json(response, 401, { error: "invalid_token" });
        return;
      }

      json(response, 200, { credentialIDs: ["credential-1"] });
      return;
    }

    if (url.pathname === "/csc/credentials/info") {
      if (token?.scope !== "service") {
        json(response, 401, { error: "invalid_token" });
        return;
      }

      json(response, 200, {
        cert: {
          certificates: signer.chain.map((item) => item.toString("base64")),
          status: "valid",
        },
        key: { algo: [CMS_OIDS.rsaEncryption], status: "enabled" },
      });
      return;
    }

    if (url.pathname === "/csc/signatures/signHash") {
      const input = JSON.parse(body) as {
        credentialID: string;
        hashAlgorithmOID: string;
        hashes: string[];
        signAlgo: string;
      };
      const hash = Buffer.from(input.hashes[0] ?? "", "base64");

      // Only the hash the signer authorized, with this token, once.
      if (
        token?.scope !== "credential" ||
        token.hashes !== hash.toString("base64url") ||
        input.hashes.length !== 1 ||
        input.hashAlgorithmOID !== CMS_OIDS.sha256
      ) {
        state.refusedHashes += 1;
        json(response, 403, { error: "invalid_request" });
        return;
      }

      tokens.delete((request.headers.authorization ?? "").slice(7));
      json(response, 200, {
        signatures: [
          privateEncrypt(
            signer.privateKeyPem,
            Buffer.concat([SHA256_DIGEST_INFO, hash]),
          ).toString("base64"),
        ],
      });
      return;
    }

    response.writeHead(404).end();
  }

  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );

  const address = server.address();
  const base = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    cscUrl: `${base}/csc`,
    eidEasyUrl: `${base}/eideasy`,
    state,
  };
}

/**
 * Follows a provider's redirect the way the signer's browser would, and
 * returns the query the signer comes back to the install with.
 */
export async function followSigner(
  redirectUrl: string,
): Promise<URLSearchParams> {
  const response = await fetch(redirectUrl, { redirect: "manual" });
  const location = response.headers.get("location");

  if (!location) {
    throw new Error(
      `The provider answered ${String(response.status)} without a redirect.`,
    );
  }

  return new URL(location).searchParams;
}

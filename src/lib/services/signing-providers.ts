import { createHash, randomBytes } from "node:crypto";

import { readEnv, type EnvSource } from "../utils/env.ts";
import { parseCertificate } from "./pdf-ltv.ts";
import {
  assembleSignedData,
  buildSignedAttributes,
  CMS_OIDS,
  ecdsaSignatureAsDer,
  hasEcKey,
  isQualifiedSignatureCertificate,
  signatureAlgorithmFor,
  type SignatureLevel,
} from "./signer-cms.ts";

// Signing providers: the trust service that signs for a signer with a
// certificate in the signer's own name, for advanced (AdES) and qualified
// (QES) electronic signatures.
//
// SignuDoc prepares the signer's revision of the PDF and its hash; the
// provider identifies the signer, has them approve, and signs the hash.
// Two kinds are supported, configured by environment variables:
//
// - eID Easy (EIDEASY_CLIENT_ID, EIDEASY_SECRET): one redirect. eID Easy
//   offers the signer the methods of their country (Smart-ID, Mobile-ID,
//   national ID cards, and others), and returns a CAdES signature.
// - Any trust service provider with the Cloud Signature Consortium API v2
//   (CSC_API_URL, CSC_CLIENT_ID, CSC_CLIENT_SECRET): the signer signs in at
//   the provider twice, once to choose their certificate and once to
//   authorize the signature of this hash. SignuDoc builds the CMS.
//
// Both are outside Vercel, and the organization pays the provider. Nothing
// here is used unless one is configured.

export type SigningProviderId = "csc" | "eideasy";

export class SigningProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SigningProviderError";
  }
}

/** What a provider keeps between steps. Stored encrypted with the session. */
export type ProviderData = Record<string, unknown>;

export type ProviderStep =
  | { data: ProviderData; kind: "redirect"; redirectUrl: string }
  | { cms: Buffer; kind: "signed"; method?: string | null };

export type ProviderStartInput = {
  /** SHA-256 of the revision bytes the signature covers. */
  contentDigest: Buffer;
  documentName: string;
  language?: string | null;
  level: SignatureLevel;
  /** Where the provider sends the signer back to, without a query. */
  returnUrl: string;
  signer: { email: string; name: string };
  /** Identifies this signing session when the signer comes back. */
  state: string;
};

export type ProviderResumeInput = {
  contentDigest: Buffer;
  data: ProviderData;
  /** The query the signer came back with. */
  query: URLSearchParams;
  returnUrl: string;
  state: string;
};

export interface SigningProvider {
  readonly id: SigningProviderId;
  /** The provider's name, as the signer sees it. */
  readonly name: string;
  resume(input: ProviderResumeInput): Promise<ProviderStep>;
  start(
    input: ProviderStartInput,
  ): Promise<ProviderStep & { kind: "redirect" }>;
}

const REQUEST_TIMEOUT_MS = 15_000;

async function callJson<T>(
  url: string,
  {
    body,
    form,
    headers = {},
    what,
  }: {
    body?: unknown;
    form?: Record<string, string>;
    headers?: Record<string, string>;
    what: string;
  },
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      body: form
        ? new URLSearchParams(form).toString()
        : JSON.stringify(body ?? {}),
      headers: {
        accept: "application/json",
        "content-type": form
          ? "application/x-www-form-urlencoded"
          : "application/json",
        ...headers,
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SigningProviderError(`${what} could not be reached.`, {
      cause: error,
    });
  }

  const text = await response.text();
  let parsed: unknown = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Reported below.
  }

  if (!response.ok || parsed === null || typeof parsed !== "object") {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : parsed && typeof parsed === "object" && "error_description" in parsed
          ? String((parsed as { error_description: unknown }).error_description)
          : `answered ${String(response.status)}`;

    throw new SigningProviderError(`${what} failed: ${message.slice(0, 200)}`);
  }

  return parsed as T;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function stoppedAt(name: string, query: URLSearchParams): never {
  const description =
    query.get("error_description") ?? query.get("error") ?? "cancelled";

  throw new SigningProviderError(
    `Signing at ${name} did not finish (${description.slice(0, 200)}).`,
  );
}

// --- eID Easy --------------------------------------------------------------

export function createEidEasyProvider({
  apiUrl = "https://id.eideasy.com",
  clientId,
  secret,
}: {
  apiUrl?: string;
  clientId: string;
  secret: string;
}): SigningProvider {
  const base = trimSlash(apiUrl);

  return {
    id: "eideasy",
    name: "eID Easy",
    async resume({ data, query }) {
      if (query.get("error")) {
        stoppedAt("eID Easy", query);
      }

      const docId = typeof data.docId === "string" ? data.docId : null;

      if (!docId) {
        throw new SigningProviderError("The eID Easy document is missing.");
      }

      const result = await callJson<{
        signed_file_contents?: string;
        signing_method?: string;
        status?: string;
      }>(`${base}/api/signatures/download-signed-file`, {
        body: {
          client_id: clientId,
          doc_id: docId,
          secret,
          verify_baseline: true,
        },
        what: "eID Easy",
      });

      // Anything but OK means there is no signature to use: eID Easy's own
      // guidance is not to treat the signature as verified then.
      if (result.status !== "OK" || !result.signed_file_contents) {
        throw new SigningProviderError(
          "eID Easy has no signature for this document. The signer may have cancelled.",
        );
      }

      return {
        cms: Buffer.from(result.signed_file_contents, "base64"),
        kind: "signed",
        method: result.signing_method ?? null,
      };
    },
    async start({ contentDigest, documentName, language, returnUrl, state }) {
      const redirect = new URL(returnUrl);

      redirect.searchParams.set("state", state);

      // The "cades" container signs the hash given as the file's content
      // and returns a detached CAdES signature (a CMS), for the PDF to hold.
      const prepared = await callJson<{ doc_id?: string; status?: string }>(
        `${base}/api/signatures/prepare-files-for-signing`,
        {
          body: {
            baseline: "T",
            client_id: clientId,
            container_type: "cades",
            files: [
              {
                fileContent: contentDigest.toString("base64"),
                fileName: `${documentName.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 80) || "document"}.pdf`,
                mimeType: "application/pdf",
              },
            ],
            noemails: true,
            secret,
            signature_redirect: redirect.toString(),
          },
          what: "eID Easy",
        },
      );

      if (!prepared.doc_id) {
        throw new SigningProviderError("eID Easy did not accept the document.");
      }

      const page = new URL(`${base}/sign_contract_external`);

      page.searchParams.set("client_id", clientId);
      page.searchParams.set("doc_id", prepared.doc_id);

      if (language) {
        page.searchParams.set("lang", language.slice(0, 2));
      }

      return {
        data: { docId: prepared.doc_id },
        kind: "redirect",
        redirectUrl: page.toString(),
      };
    },
  };
}

// --- Cloud Signature Consortium API v2 -------------------------------------

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function pkce(): { challenge: string; verifier: string } {
  const verifier = base64Url(randomBytes(32));

  return {
    challenge: base64Url(createHash("sha256").update(verifier).digest()),
    verifier,
  };
}

type CscCredentialInfo = {
  cert?: { certificates?: string[]; status?: string };
  key?: { status?: string };
};

/**
 * Whether a certificate can make a signature of this level. For a qualified
 * signature it has to say it is qualified, on a qualified device; the CMS is
 * checked again after signing. A certificate that cannot be read is skipped.
 */
function meetsLevel(certificate: Buffer, level: SignatureLevel): boolean {
  try {
    const parsed = parseCertificate(certificate);

    return level !== "qualified" || isQualifiedSignatureCertificate(parsed);
  } catch {
    return false;
  }
}

export function createCscProvider({
  apiUrl,
  clientId,
  clientSecret,
  name = "your trust service provider",
  oauthUrl,
}: {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
  name?: string;
  oauthUrl?: string;
}): SigningProvider {
  const api = trimSlash(apiUrl);
  const oauth = trimSlash(oauthUrl ?? `${api}/oauth2`);
  const authorizeUrl = (
    params: Record<string, string>,
    state: string,
    returnUrl: string,
    challenge: string,
  ) => {
    const url = new URL(`${oauth}/authorize`);

    for (const [key, value] of Object.entries({
      client_id: clientId,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: returnUrl,
      response_type: "code",
      state,
      ...params,
    })) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  };
  const exchange = async (
    code: string,
    verifier: string,
    returnUrl: string,
  ): Promise<string> => {
    const token = await callJson<{ access_token?: string }>(`${oauth}/token`, {
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: returnUrl,
      },
      what: name,
    });

    if (!token.access_token) {
      throw new SigningProviderError(`${name} gave no access token.`);
    }

    return token.access_token;
  };

  return {
    id: "csc",
    name,
    async resume({ contentDigest, data, query, returnUrl, state }) {
      if (query.get("error")) {
        stoppedAt(name, query);
      }

      const code = query.get("code");
      const verifier = typeof data.verifier === "string" ? data.verifier : "";

      if (!code || !verifier) {
        throw new SigningProviderError(
          `${name} sent the signer back without a code.`,
        );
      }

      // The level the envelope asks for, kept from the start.
      const level: SignatureLevel =
        data.level === "qualified" ? "qualified" : "advanced";

      if (data.step === "service") {
        // The signer signed in: find their certificate, and ask them to
        // authorize the signature of exactly this hash.
        const bearer = {
          authorization: `Bearer ${await exchange(code, verifier, returnUrl)}`,
        };
        const list = await callJson<{ credentialIDs?: string[] }>(
          `${api}/credentials/list`,
          { body: {}, headers: bearer, what: name },
        );
        let chosen: { certificates: Buffer[]; id: string } | null = null;

        for (const credentialID of (list.credentialIDs ?? []).slice(0, 10)) {
          const info = await callJson<CscCredentialInfo>(
            `${api}/credentials/info`,
            {
              body: { certInfo: true, certificates: "chain", credentialID },
              headers: bearer,
              what: name,
            },
          );
          const certificates = (info.cert?.certificates ?? []).map((value) =>
            Buffer.from(value, "base64"),
          );

          if (
            certificates.length > 0 &&
            (info.cert?.status ?? "valid") === "valid" &&
            (info.key?.status ?? "enabled") === "enabled" &&
            meetsLevel(certificates[0]!, level)
          ) {
            chosen = { certificates, id: credentialID };
            break;
          }
        }

        if (!chosen) {
          throw new SigningProviderError(
            level === "qualified"
              ? `${name} has no qualified signing certificate for this signer.`
              : `${name} has no usable signing certificate for this signer.`,
          );
        }

        const signedAttributes = buildSignedAttributes({
          certificate: chosen.certificates[0]!,
          contentDigest,
        });
        const hash = createHash("sha256").update(signedAttributes).digest();
        const next = pkce();

        return {
          data: {
            certificates: chosen.certificates.map((value) =>
              value.toString("base64"),
            ),
            credentialID: chosen.id,
            signedAttributes: signedAttributes.toString("base64"),
            step: "credential",
            verifier: next.verifier,
          },
          kind: "redirect",
          redirectUrl: authorizeUrl(
            {
              credentialID: chosen.id,
              hashAlgorithmOID: CMS_OIDS.sha256,
              hashes: base64Url(hash),
              numSignatures: "1",
              scope: "credential",
            },
            state,
            returnUrl,
            next.challenge,
          ),
        };
      }

      if (data.step !== "credential") {
        throw new SigningProviderError(
          `The ${name} session is not one this install made.`,
        );
      }

      const signedAttributes = Buffer.from(
        String(data.signedAttributes),
        "base64",
      );
      const certificates = (data.certificates as string[]).map((value) =>
        Buffer.from(value, "base64"),
      );
      // The algorithm follows the certificate's key: ECDSA or RSA.
      const signer = parseCertificate(certificates[0]!);
      const ec = hasEcKey(signer);
      const signatureAlgorithm = signatureAlgorithmFor(signer);
      const hash = createHash("sha256").update(signedAttributes).digest();
      const credentialToken = await exchange(code, verifier, returnUrl);
      const signed = await callJson<{ signatures?: string[] }>(
        `${api}/signatures/signHash`,
        {
          body: {
            credentialID: data.credentialID,
            hashAlgorithmOID: CMS_OIDS.sha256,
            hashes: [hash.toString("base64")],
            operationMode: "S",
            signAlgo: ec ? CMS_OIDS.ecdsaSha256 : CMS_OIDS.rsaEncryption,
          },
          headers: { authorization: `Bearer ${credentialToken}` },
          what: name,
        },
      );
      const value = signed.signatures?.[0];

      if (!value) {
        throw new SigningProviderError(`${name} returned no signature.`);
      }

      const raw = Buffer.from(value, "base64");

      return {
        cms: assembleSignedData({
          certificates,
          signature: ec ? ecdsaSignatureAsDer(raw) : raw,
          signatureAlgorithm,
          signedAttributes,
        }),
        kind: "signed",
        method: "csc",
      };
    },
    async start({ level, returnUrl, state }) {
      const first = pkce();

      return {
        data: { level, step: "service", verifier: first.verifier },
        kind: "redirect",
        redirectUrl: authorizeUrl(
          { scope: "service" },
          state,
          returnUrl,
          first.challenge,
        ),
      };
    },
  };
}

// --- Configuration ---------------------------------------------------------

function configuredProviders(env: EnvSource): SigningProvider[] {
  const providers: SigningProvider[] = [];
  const eidEasyClient = readEnv(env, "EIDEASY_CLIENT_ID");
  const eidEasySecret = readEnv(env, "EIDEASY_SECRET");
  const cscApi = readEnv(env, "CSC_API_URL");
  const cscClient = readEnv(env, "CSC_CLIENT_ID");
  const cscSecret = readEnv(env, "CSC_CLIENT_SECRET");

  if (eidEasyClient && eidEasySecret) {
    providers.push(
      createEidEasyProvider({
        apiUrl: readEnv(env, "EIDEASY_API_URL"),
        clientId: eidEasyClient,
        secret: eidEasySecret,
      }),
    );
  }

  if (cscApi && cscClient && cscSecret) {
    providers.push(
      createCscProvider({
        apiUrl: cscApi,
        clientId: cscClient,
        clientSecret: cscSecret,
        name: readEnv(env, "CSC_PROVIDER_NAME"),
        oauthUrl: readEnv(env, "CSC_OAUTH_URL"),
      }),
    );
  }

  return providers;
}

/**
 * The provider new envelopes use, or null when none is configured. With
 * both configured, SIGNING_PROVIDER picks one; eID Easy otherwise.
 */
export function configuredSigningProvider(
  env: EnvSource = process.env,
): SigningProvider | null {
  const providers = configuredProviders(env);
  const choice = readEnv(env, "SIGNING_PROVIDER")?.toLowerCase();

  return (
    providers.find((provider) => provider.id === choice) ?? providers[0] ?? null
  );
}

/** The provider an envelope was sent with, if it is still configured. */
export function signingProviderById(
  id: string,
  env: EnvSource = process.env,
): SigningProvider | null {
  return (
    configuredProviders(env).find((provider) => provider.id === id) ?? null
  );
}

import { ZodError } from "zod";

import type { ApiKeyScope } from "../api-keys.ts";
import {
  requireApiKey,
  withRateLimitHeaders,
  type RateLimitState,
} from "../auth/api-key.ts";
import { DownloadAccessError } from "../downloads.ts";
import { EmbeddingError } from "../embedding.ts";
import { resolveEnvelopeViewerAccess } from "../envelope-access.ts";
import {
  EnvelopeDocumentAccessError,
  EnvelopeMutationError,
} from "../envelopes.ts";
import { ReminderMutationError } from "../reminders.ts";
import { logRouteError } from "../security/logging.ts";
import { consumeRateLimit, peekRateLimit } from "../security/rate-limit.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "../security/request.ts";
import { DocumentImportError } from "../services/document-import.ts";
import { PendingUploadError } from "../services/pending-uploads.ts";
import { TemplateError } from "../templates.ts";
import { scheduleWebhookDrainIfDue } from "../webhooks/deliver.ts";
import { describeZodError, type ApiActor } from "./envelopes.ts";
import { apiError, apiJson, codeForStatus } from "./http.ts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
  readIdempotencyKey,
  releaseIdempotencyKey,
  rememberIdempotentResource,
} from "./idempotency.ts";

// The frame every /api/v1 route runs in: the key is checked, errors the
// app's own functions throw become API errors, and rate limit headers go
// on whatever comes back.

export type ApiContext = {
  actor: ApiActor;
  rateLimit: RateLimitState;
  request: Request;
};

/** Turns an error from the app's functions into an API error, or null. */
export function apiErrorFor(error: unknown): Response | null {
  if (error instanceof ZodError) {
    return apiError(400, "invalid_request", describeZodError(error));
  }

  if (error instanceof DocumentImportError) {
    return error.code === "too_large"
      ? apiError(413, "payload_too_large", error.message)
      : apiError(400, "invalid_request", error.message);
  }

  if (error instanceof EmbeddingError) {
    return apiError(
      error.statusCode,
      codeForStatus(error.statusCode),
      error.message,
    );
  }

  if (error instanceof PendingUploadError) {
    return apiError(400, "invalid_request", error.message);
  }

  if (
    error instanceof ReminderMutationError &&
    error.statusCode === 429 &&
    error.nextAvailableAt !== null
  ) {
    // Too soon after the last reminder: Retry-After says when the next one
    // can go, as for every other 429 of the API.
    const waitSeconds = Math.max(
      1,
      error.nextAvailableAt - Math.floor(Date.now() / 1000),
    );

    return apiError(429, codeForStatus(429), error.message, {
      "retry-after": String(waitSeconds),
    });
  }

  if (
    error instanceof EnvelopeMutationError ||
    error instanceof EnvelopeDocumentAccessError ||
    error instanceof DownloadAccessError ||
    error instanceof TemplateError ||
    error instanceof ReminderMutationError
  ) {
    return apiError(
      error.statusCode,
      codeForStatus(error.statusCode),
      error.message,
    );
  }

  return null;
}

function internalError(): Response {
  return apiError(
    500,
    "internal_error",
    "Something went wrong on the install. Try again later.",
  );
}

export async function handleApi(
  request: Request,
  scope: ApiKeyScope,
  category: string,
  handler: (context: ApiContext) => Promise<Response>,
): Promise<Response> {
  let principal: Awaited<ReturnType<typeof requireApiKey>>;

  // Checking the key can fail too (the database is down). That gets the
  // same JSON answer and the same log line as a failure further on.
  try {
    principal = await requireApiKey(request, scope);
  } catch (error) {
    logRouteError(error, {
      category,
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while checking an API key.",
      path: getRequestPathname(request),
    });

    return internalError();
  }

  if (principal instanceof Response) {
    return principal;
  }

  const context: ApiContext = {
    actor: {
      apiKeyId: principal.apiKey.id,
      email: principal.user.email,
      ipAddress: getClientIpAddress(request.headers),
      name: principal.user.name,
      userAgent: getRequestUserAgent(request.headers),
      userId: principal.user.id,
    },
    rateLimit: principal.rateLimit,
    request,
  };

  // A request from an app is a good moment to send webhook retries that
  // are due, so they need not wait for the daily cron.
  scheduleWebhookDrainIfDue();

  try {
    return withRateLimitHeaders(await handler(context), principal.rateLimit);
  } catch (error) {
    const known = apiErrorFor(error);

    if (known) {
      return withRateLimitHeaders(known, principal.rateLimit);
    }

    logRouteError(error, {
      category,
      ipAddress: context.actor.ipAddress,
      message: "Unexpected failure in an API request.",
      metadata: { apiKeyId: principal.apiKey.id },
      path: getRequestPathname(request),
      userId: principal.user.id,
    });

    return withRateLimitHeaders(internalError(), principal.rateLimit);
  }
}

export function handleApiEnvelope(
  request: Request,
  scope: ApiKeyScope,
  category: string,
  envelopeId: string,
  handler: (context: ApiContext) => Promise<Response>,
): Promise<Response> {
  return handleApi(request, scope, category, async (context) => {
    const access = await resolveEnvelopeViewerAccess(
      context.actor.userId,
      envelopeId,
    );

    return access?.viewerIsOwner
      ? handler(context)
      : apiError(404, "not_found", "Envelope not found.");
  });
}

type ApiResult = { body: unknown; status: number };

type AccountLimit = {
  key: string;
  limit: number;
  /** What the 429 says. Left out, it speaks of envelopes made or sent. */
  refusal?: string;
  windowMs: number;
};

/**
 * Whether a response is kept for retries: not a 5xx, and not a 429. A
 * route that cleans up after a refusal does so only for these, since after
 * any other failure the retry runs again and needs what it was given.
 */
export function isKept(status: number) {
  return status < 500 && status !== 429;
}

/**
 * Runs `run` once per Idempotency-Key. Without the header it simply runs.
 * Only a response the caller can act on is kept: a 5xx or a 429 lets the
 * key go, so a retry runs again.
 *
 * Except once `run` has done what cannot be undone: it calls `remember`
 * with the envelope's id as soon as the envelope is made (and sent, if
 * asked). From then on a failure keeps the key, and a retry gets
 * `recover(id)`, the envelope as it is, instead of a second envelope. If
 * even noting the id fails (the database went away just then), the key is
 * still kept: a retry is told to wait (409) until the key's 24 hours run
 * out, and never makes a second envelope.
 *
 * `limits` count only a request that does the work now. A replay or a
 * recovery costs nothing, so a retry of a request that worked is never
 * refused for being over a limit.
 */
export async function runIdempotently(
  context: ApiContext,
  route: string,
  body: Uint8Array | string,
  run: (remember: (resourceId: string) => Promise<void>) => Promise<ApiResult>,
  recover?: (resourceId: string) => Promise<ApiResult>,
  limits: AccountLimit[] = [],
): Promise<Response> {
  const key = readIdempotencyKey(context.request.headers);

  if (key === undefined) {
    return apiError(
      400,
      "invalid_request",
      "Idempotency-Key must be 1 to 255 characters.",
    );
  }

  if (key === null) {
    const refused = await applyAccountLimits(context, limits);

    if (refused) {
      return refused;
    }

    const result = await runCatching(() => run(async () => {}));

    return apiJson(result.body, { status: result.status });
  }

  const claim = {
    apiKeyId: context.actor.apiKeyId,
    key,
    requestHash: hashRequest(route, body),
  };
  const previous = await claimIdempotencyKey(claim);

  switch (previous.kind) {
    case "mismatch":
      return apiError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was used with a different request.",
      );
    case "in_progress":
      return apiError(
        409,
        "wrong_state",
        "A request with this Idempotency-Key is still being worked on. Try again shortly.",
        { "retry-after": "2" },
      );
    case "replay":
      return apiJson(previous.response, {
        headers: { "idempotent-replayed": "true" },
        status: previous.statusCode,
      });
    case "recover": {
      if (!recover) {
        return apiError(
          409,
          "wrong_state",
          "A request with this Idempotency-Key is still being worked on. Try again shortly.",
          { "retry-after": "2" },
        );
      }

      const recovered = await runCatching(() => recover(previous.resourceId));
      // Only an answer that shows the envelope is kept. One that finds it
      // gone (deleted meanwhile) is not: the first request may still be
      // finishing, and its own answer must not be replaced. And the first
      // request may have finished meanwhile: its response is then the one
      // kept, and the answer here too.
      const kept =
        recovered.status >= 200 && recovered.status < 300
          ? await completeIdempotencyKey({
              apiKeyId: claim.apiKeyId,
              key,
              reservedAt: previous.reservedAt,
              response: recovered.body,
              statusCode: recovered.status,
            })
          : null;

      return apiJson(kept ? kept.response : recovered.body, {
        headers: { "idempotent-replayed": "true" },
        status: kept ? kept.statusCode : recovered.status,
      });
    }
    case "new":
      break;
  }

  const reservation = {
    apiKeyId: claim.apiKeyId,
    key,
    reservedAt: previous.reservedAt,
  };
  // Set as soon as `remember` is called, before its write: by then the
  // envelope is made (and sent, if asked), so even if noting it fails the
  // key is kept. A retry is told the request is still being worked on
  // rather than being let make and send a second envelope.
  let made = false;
  const remember = async (resourceId: string) => {
    made = true;
    await rememberIdempotentResource({ ...reservation, resourceId });
  };
  let result: ApiResult;

  try {
    const refused = await applyAccountLimits(context, limits);

    if (refused) {
      await releaseIdempotencyKey(reservation).catch(() => undefined);
      return refused;
    }

    result = await runCatching(() => run(remember));
  } catch (error) {
    // Once the envelope exists, the key stays with it (see above).
    if (!made) {
      await releaseIdempotencyKey(reservation).catch(() => undefined);
    }

    throw error;
  }

  if (isKept(result.status)) {
    // A retry may have answered from the envelope first. Its response is
    // then the one kept, and the answer here too.
    const kept = await completeIdempotencyKey({
      ...reservation,
      response: result.body,
      statusCode: result.status,
    });

    if (kept) {
      return apiJson(kept.response, { status: kept.statusCode });
    }
  } else if (!made) {
    await releaseIdempotencyKey(reservation).catch(() => undefined);
  }

  return apiJson(result.body, { status: result.status });
}

/**
 * The first of `limits` this request is over, as a 429, or null. With more
 * than one, all are checked before any is counted, so a request that one
 * limit refuses does not use up the others (a create that would also send,
 * refused for sending, still leaves the key its creates).
 */
async function applyAccountLimits(
  context: ApiContext,
  limits: AccountLimit[],
): Promise<Response | null> {
  if (limits.length > 1) {
    for (const limit of limits) {
      const state = await peekRateLimit({
        key: accountLimitKey(context, limit),
        limit: limit.limit,
      });

      if (!state.allowed) {
        return accountLimitRefusal(state.retryAfterSeconds, limit.refusal);
      }
    }
  }

  for (const limit of limits) {
    const refused = await applyAccountLimit(context, limit);

    if (refused) {
      return refused;
    }
  }

  return null;
}

/** Known errors become a kept response; anything else is thrown on. */
async function runCatching(run: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await run();
  } catch (error) {
    const known = apiErrorFor(error);

    if (!known) {
      throw error;
    }

    return { body: await known.json(), status: known.status };
  }
}

/** Creating envelopes: per key, every 10 minutes. */
export const API_CREATE_LIMIT = {
  key: "api-envelope-create",
  limit: 60,
  windowMs: 10 * 60 * 1000,
};

/**
 * Sending envelopes, whichever route sends them: per key, every hour. A
 * create or template call that also sends counts here too.
 */
export const API_SEND_LIMIT = {
  key: "api-envelope-send",
  limit: 100,
  windowMs: 60 * 60 * 1000,
};

/** Signing links for embedded envelopes: per key, every 10 minutes. */
export const API_EMBED_LINK_LIMIT = {
  key: "api-embed-link",
  limit: 300,
  refusal:
    "This key has asked for too many signing links for now. Wait and try again.",
  windowMs: 10 * 60 * 1000,
};

/**
 * Counts this request against a per-key limit on creating or sending. These
 * are looser than the web app's per-person limits, since an app sends in
 * bulk, but still stop a leaked key from flooding inboxes.
 */
export async function applyAccountLimit(
  context: ApiContext,
  input: AccountLimit,
): Promise<Response | null> {
  const decision = await consumeRateLimit({
    key: accountLimitKey(context, input),
    limit: input.limit,
    windowMs: input.windowMs,
  });

  return decision.allowed
    ? null
    : accountLimitRefusal(decision.retryAfterSeconds, input.refusal);
}

function accountLimitKey(context: ApiContext, input: AccountLimit) {
  return `${input.key}:${context.actor.apiKeyId}`;
}

function accountLimitRefusal(
  retryAfterSeconds: number,
  message = "This key has created or sent too many envelopes for now. Wait and try again.",
): Response {
  return apiError(429, "rate_limited", message, {
    "retry-after": String(retryAfterSeconds),
  });
}

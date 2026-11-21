import { safeErrorCode, type ChannelFailure } from "../channel.ts";

// The few Slack Web API methods notifications use, with a bot token
// (xoxb-...). Every call is a POST to https://slack.com/api/<method>.
//
// Slack answers most errors with HTTP 200 and { ok: false, error: "code" };
// a rate limit is HTTP 429 with a Retry-After header in seconds. Only the
// status and that code are kept from a failed call. Nothing else Slack
// sends back is logged, stored or shown, so a token or a message can never
// leak through an error.
//
// https://api.slack.com/web
// https://api.slack.com/apis/rate-limits

export const SLACK_API_URL = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 3600;

export type SlackFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type SlackApiError = {
  error: string;
  ok: false;
  retryAfterSeconds: number | null;
  status: number;
};

export type SlackResult<T> = ({ ok: true } & T) | SlackApiError;

export type SlackAuthInfo = {
  botUserId: string | null;
  team: string | null;
  teamId: string | null;
  url: string | null;
};

export type SlackChannelSummary = {
  id: string;
  isMember: boolean;
  isPrivate: boolean;
  name: string;
};

export type SlackBlock = Record<string, unknown>;

export type SlackClient = {
  authTest(): Promise<SlackResult<SlackAuthInfo>>;
  listChannels(cursor?: string | null): Promise<
    SlackResult<{
      channels: SlackChannelSummary[];
      nextCursor: string | null;
    }>
  >;
  lookupUserByEmail(email: string): Promise<SlackResult<{ userId: string }>>;
  postMessage(
    input: SlackMessageContent & {
      channel: string;
      /** Replies in the thread of this message. */
      threadTs?: string;
    },
  ): Promise<SlackResult<{ channel: string; ts: string }>>;
  /** Edits a message the app posted (chat.update). */
  updateMessage(
    input: SlackMessageContent & { channel: string; ts: string },
  ): Promise<SlackResult<{ channel: string; ts: string }>>;
};

/** What a message shows: blocks, coloured attachments, and the text fallback. */
export type SlackMessageContent = {
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
  text: string;
};

export type SlackAttachment = {
  blocks: SlackBlock[];
  /** The bar down the left side, "#rrggbb". */
  color: string;
  fallback?: string;
};

/**
 * Errors that mean the remembered message is gone (deleted, or the app can
 * no longer edit it), so a new one is posted in its place.
 */
export const SLACK_MESSAGE_GONE_ERRORS: ReadonlySet<string> = new Set([
  "cant_update_message",
  "edit_window_closed",
  "message_not_found",
  "thread_not_found",
]);

const AUTH_ERRORS = new Set([
  "account_inactive",
  "ekm_access_denied",
  "invalid_auth",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
]);

const TRANSIENT_ERRORS = new Set([
  "fatal_error",
  "internal_error",
  "network_error",
  "request_timeout",
  "service_unavailable",
  "timeout",
]);

/** What a failed Slack call means for the message it was for. */
export function classifySlackError(error: SlackApiError): ChannelFailure {
  if (
    error.status === 429 ||
    error.error === "ratelimited" ||
    error.error === "rate_limited"
  ) {
    return {
      error: "ratelimited",
      outcome: "rate_limited",
      retryAfterSeconds: error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
    };
  }

  if (AUTH_ERRORS.has(error.error) || error.status === 401) {
    return { error: error.error, outcome: "auth" };
  }

  if (error.status >= 500 || TRANSIENT_ERRORS.has(error.error)) {
    return {
      error: error.error,
      outcome: "retry",
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }

  return { error: error.error, outcome: "failed" };
}

function parseRetryAfter(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) {
    return null;
  }

  return Math.min(
    Math.max(Number.parseInt(value.trim(), 10), 1),
    MAX_RETRY_AFTER_SECONDS,
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createSlackClient({
  baseUrl = SLACK_API_URL,
  fetch: fetchImpl = globalThis.fetch,
  token,
}: {
  baseUrl?: string;
  fetch?: SlackFetch;
  token: string;
}): SlackClient {
  async function call(
    method: string,
    body: Record<string, unknown>,
    encoding: "form" | "json",
  ): Promise<SlackResult<{ body: Record<string, unknown> }>> {
    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl}/${method}`, {
        body:
          encoding === "json"
            ? JSON.stringify(body)
            : new URLSearchParams(
                Object.entries(body)
                  .filter(([, value]) => value !== undefined && value !== null)
                  .map(([key, value]) => [key, String(value)]),
              ).toString(),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type":
            encoding === "json"
              ? "application/json; charset=utf-8"
              : "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "network_error",
        ok: false,
        retryAfterSeconds: null,
        status: 0,
      };
    }

    const retryAfterSeconds = parseRetryAfter(
      response.headers.get("retry-after"),
    );

    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);

      return {
        error: "ratelimited",
        ok: false,
        retryAfterSeconds: retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
        status: 429,
      };
    }

    const parsed: unknown = await response.json().catch(() => null);

    if (!response.ok || typeof parsed !== "object" || parsed === null) {
      return {
        error: response.ok ? "invalid_response" : `http_${response.status}`,
        ok: false,
        retryAfterSeconds,
        status: response.ok ? 502 : response.status,
      };
    }

    const result = parsed as Record<string, unknown>;

    if (result.ok !== true) {
      return {
        error: safeErrorCode(result.error),
        ok: false,
        retryAfterSeconds,
        status: response.status,
      };
    }

    return { body: result, ok: true };
  }

  return {
    async authTest() {
      const result = await call("auth.test", {}, "form");

      if (!result.ok) {
        return result;
      }

      return {
        botUserId: readString(result.body.user_id),
        ok: true,
        team: readString(result.body.team),
        teamId: readString(result.body.team_id),
        url: readString(result.body.url),
      };
    },

    async listChannels(cursor) {
      const result = await call(
        "conversations.list",
        {
          cursor: cursor ?? undefined,
          exclude_archived: true,
          limit: 200,
          types: "public_channel",
        },
        "form",
      );

      if (!result.ok) {
        return result;
      }

      const channels = Array.isArray(result.body.channels)
        ? result.body.channels
        : [];
      const metadata = result.body.response_metadata as
        Record<string, unknown> | undefined;

      return {
        channels: channels.flatMap((entry): SlackChannelSummary[] => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }

          const channel = entry as Record<string, unknown>;
          const id = readString(channel.id);
          const name = readString(channel.name);

          return id && name
            ? [
                {
                  id,
                  isMember: channel.is_member === true,
                  isPrivate: channel.is_private === true,
                  name,
                },
              ]
            : [];
        }),
        nextCursor: readString(metadata?.next_cursor),
        ok: true,
      };
    },

    async lookupUserByEmail(email) {
      const result = await call("users.lookupByEmail", { email }, "form");

      if (!result.ok) {
        return result;
      }

      const user = result.body.user as Record<string, unknown> | undefined;
      const userId = readString(user?.id);

      if (!userId || user?.deleted === true) {
        return {
          error: "users_not_found",
          ok: false,
          retryAfterSeconds: null,
          status: 200,
        };
      }

      return { ok: true, userId };
    },

    async postMessage({ attachments, blocks, channel, text, threadTs }) {
      const result = await call(
        "chat.postMessage",
        {
          attachments,
          blocks,
          channel,
          // Names in a title or a signer's name are text, never mentions.
          link_names: false,
          text,
          thread_ts: threadTs,
          unfurl_links: false,
          unfurl_media: false,
        },
        "json",
      );

      return messageResult(result, channel);
    },

    async updateMessage({ attachments, blocks, channel, text, ts }) {
      const result = await call(
        "chat.update",
        {
          // An empty list clears what an earlier version had.
          attachments: attachments ?? [],
          blocks: blocks ?? [],
          channel,
          link_names: false,
          text,
          ts,
        },
        "json",
      );

      return messageResult(result, channel, ts);
    },
  };
}

function messageResult(
  result: SlackResult<{ body: Record<string, unknown> }>,
  channel: string,
  ts = "",
): SlackResult<{ channel: string; ts: string }> {
  if (!result.ok) {
    return result;
  }

  return {
    channel: readString(result.body.channel) ?? channel,
    ok: true,
    ts: readString(result.body.ts) ?? ts,
  };
}

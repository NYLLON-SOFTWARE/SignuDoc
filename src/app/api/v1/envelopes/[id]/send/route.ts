import { MAX_JSON_BODY_BYTES, readBodyWithin } from "@/lib/api/body";
import { apiError, bodyTooLarge } from "@/lib/api/http";
import {
  apiSendOptionsSchema,
  describeZodError,
  getApiEnvelope,
  sendEnvelopeForApi,
} from "@/lib/api/envelopes";
import {
  API_SEND_LIMIT,
  handleApiEnvelope,
  runIdempotently,
} from "@/lib/api/route";

type Context = { params: Promise<{ id: string }> };

// Sends a draft to its first signer.
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApiEnvelope(
    request,
    "write",
    "api_envelope_send_failure",
    id,
    async (api) => {
      const raw = await readBodyWithin(request, MAX_JSON_BODY_BYTES);

      if (!raw) {
        return bodyTooLarge();
      }

      const text = new TextDecoder().decode(raw);
      let body: unknown;

      try {
        body = text.trim() ? (JSON.parse(text) as unknown) : {};
      } catch {
        return apiError(400, "invalid_request", "The body is not valid JSON.");
      }

      const options = apiSendOptionsSchema.safeParse(body);

      if (!options.success) {
        return apiError(
          400,
          "invalid_request",
          describeZodError(options.error),
        );
      }

      const readBack = async () => {
        const envelope = await getApiEnvelope(api.actor.userId, id);

        return envelope
          ? { body: envelope, status: 200 }
          : {
              body: {
                error: { code: "not_found", message: "Envelope not found." },
              },
              status: 404,
            };
      };

      return runIdempotently(
        api,
        `POST /api/v1/envelopes/${id}/send`,
        text,
        async (remember) => {
          await sendEnvelopeForApi(api.actor, id, options.data);
          await remember(id);
          return readBack();
        },
        readBack,
        [API_SEND_LIMIT],
      );
    },
  );
}

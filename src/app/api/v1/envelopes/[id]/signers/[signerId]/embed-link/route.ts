import { MAX_JSON_BODY_BYTES, readBodyWithin } from "@/lib/api/body";
import { apiError, apiJson, bodyTooLarge } from "@/lib/api/http";
import {
  API_EMBED_LINK_LIMIT,
  applyAccountLimit,
  handleApiEnvelope,
} from "@/lib/api/route";
import { issueEmbedLink } from "@/lib/embedding";

type RouteContext = { params: Promise<{ id: string; signerId: string }> };

// A signing link for an embedded envelope, for a signer whose turn it is,
// to show in a frame on an allowed site. Each call replaces the signer's
// last link. See docs/api.md, "Embedded signing".

export async function POST(request: Request, context: RouteContext) {
  const { id, signerId } = await context.params;

  return handleApiEnvelope(
    request,
    "write",
    "api_embed_link_failure",
    id,
    async (api) => {
      const limited = await applyAccountLimit(api, API_EMBED_LINK_LIMIT);

      if (limited) {
        return limited;
      }

      const raw = await readBodyWithin(request, MAX_JSON_BODY_BYTES);

      if (!raw) {
        return bodyTooLarge();
      }

      // No body gets the same answer as a body without an origin, which
      // says what to send.
      const text = new TextDecoder().decode(raw);
      let body: { origin?: unknown } | null = null;

      if (text.trim()) {
        try {
          body = JSON.parse(text) as { origin?: unknown } | null;
        } catch {
          return apiError(
            400,
            "invalid_request",
            "The body is not valid JSON.",
          );
        }
      }

      const link = await issueEmbedLink({
        apiKeyId: api.actor.apiKeyId,
        envelopeId: id,
        origin: body?.origin,
        signerId,
        userId: api.actor.userId,
      });

      return apiJson({ ...link, object: "embed_link" }, { status: 201 });
    },
  );
}

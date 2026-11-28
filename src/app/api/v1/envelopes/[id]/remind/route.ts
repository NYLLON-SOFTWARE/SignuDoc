import { apiError, apiJson } from "@/lib/api/http";
import { getApiEnvelope } from "@/lib/api/envelopes";
import { handleApiEnvelope } from "@/lib/api/route";
import { sendManualEnvelopeNudge } from "@/lib/reminders";

type Context = { params: Promise<{ id: string }> };

// Emails a reminder to each signer whose turn it is, under the same limit as
// the reminder button in the web app.
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApiEnvelope(
    request,
    "write",
    "api_envelope_remind_failure",
    id,
    async ({ actor }) => {
      await sendManualEnvelopeNudge(actor.userId, id, {
        ipAddress: actor.ipAddress,
        senderEmail: actor.email,
        senderName: actor.name.trim() ? actor.name : actor.email,
        userAgent: actor.userAgent,
      });

      const envelope = await getApiEnvelope(actor.userId, id);

      return envelope
        ? apiJson(envelope)
        : apiError(404, "not_found", "Envelope not found.");
    },
  );
}

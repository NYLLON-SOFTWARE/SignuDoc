import { queryOne, type DbExecutor } from "./db/connection.ts";
import type { InvitationCopy } from "./schemas/invitation.ts";

export async function readInvitationCopy(
  envelopeId: string,
  database: DbExecutor,
): Promise<InvitationCopy> {
  return (
    (await queryOne<InvitationCopy>(
      database,
      `SELECT invitation_subject AS subject, invitation_message AS message
       FROM envelopes WHERE id = $1`,
      [envelopeId],
    )) ?? { subject: null, message: null }
  );
}

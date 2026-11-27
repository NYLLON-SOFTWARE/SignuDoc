import {
  EnvelopeDetailShell,
  type EnvelopeDeletionNotice,
} from "@/components/envelopes/envelope-detail-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import {
  formatEnvelopeOwner,
  resolveEnvelopeViewerAccess,
} from "@/lib/envelope-access";
import { getScheduledEnvelopeDeletion } from "@/lib/envelope-deletion";
import { getEnvelopeDetailDataForUser } from "@/lib/envelopes";

type EnvelopeDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function EnvelopeDetailPage({
  params,
}: EnvelopeDetailPageProps) {
  const { id } = await params;

  let detailRecord: Awaited<ReturnType<typeof getEnvelopeDetailDataForUser>> =
    null;
  let initialState: "error" | "not-found" | undefined;
  let canDeleteFinished = false;
  let ownerLabel: string | undefined;
  let ownerListView: "all" | "team" = "all";
  let scheduledDeletion: EnvelopeDeletionNotice | undefined;

  try {
    const session = await getAuthSession();
    // Its sender's, or, once sent, a teammate's or any administrator's.
    const access = session
      ? await resolveEnvelopeViewerAccess(session.user.id, id, getDb())
      : null;

    detailRecord = access
      ? await getEnvelopeDetailDataForUser(access.ownerUserId, id, getDb())
      : null;
    initialState = detailRecord ? undefined : "not-found";
    ownerLabel =
      access && !access.viewerIsOwner ? formatEnvelopeOwner(access) : undefined;
    // Only an administrator may delete a finished envelope.
    canDeleteFinished =
      detailRecord !== null &&
      session !== null &&
      (await isAdminUser(session.user.id, getDb()));
    // Back to everyone's envelopes for an administrator, to the team's
    // for a teammate.
    ownerListView = canDeleteFinished ? "all" : "team";

    const scheduled = detailRecord
      ? await getScheduledEnvelopeDeletion(id, getDb())
      : null;

    scheduledDeletion = scheduled
      ? {
          deleteAfter: scheduled.deleteAfter,
          // Why is for administrators; the sender is told who asked.
          reason: canDeleteFinished ? scheduled.reason : null,
          requestedByEmail: scheduled.requestedByEmail,
        }
      : undefined;
  } catch {
    initialState = "error";
  }

  return (
    <EnvelopeDetailShell
      canDeleteFinished={canDeleteFinished}
      envelopeId={id}
      initialState={initialState}
      key={id}
      ownerLabel={ownerLabel}
      ownerListView={ownerListView}
      record={detailRecord ?? undefined}
      scheduledDeletion={scheduledDeletion}
    />
  );
}

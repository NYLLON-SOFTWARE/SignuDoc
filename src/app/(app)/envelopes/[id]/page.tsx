import {
  EnvelopeDetailShell,
  type EnvelopeDeletionNotice,
} from "@/components/envelopes/envelope-detail-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import {
  formatEnvelopeOwner,
  resolveEnvelopeViewerAccess,
} from "@/lib/envelope-access";
import { getScheduledEnvelopeDeletion } from "@/lib/envelope-deletion";
import { getEnvelopeDetailDataForUser } from "@/lib/envelopes";
import { listFoldersForUser } from "@/lib/teams";

const deletionDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

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
  let folder: { id: string; name: string } | undefined;
  let destinationFolders: { id: string; name: string }[] = [];
  let scheduledDeletion: EnvelopeDeletionNotice | undefined;

  try {
    const session = await getAuthSession();
    // A sent agreement can also be read by folder members or administrators.
    const access = session
      ? await resolveEnvelopeViewerAccess(session.user.id, id, getDb())
      : null;

    detailRecord = access
      ? await getEnvelopeDetailDataForUser(access.ownerUserId, id, getDb())
      : null;
    initialState = detailRecord ? undefined : "not-found";
    ownerLabel =
      access && !access.viewerIsOwner ? formatEnvelopeOwner(access) : undefined;
    canDeleteFinished = detailRecord !== null && access?.viewerIsAdmin === true;

    if (session && access && (access.folderId || access.viewerIsAdmin)) {
      const folders = await listFoldersForUser(session.user.id, getDb());
      folder = folders.find(({ id: folderId }) => folderId === access.folderId);
      if (access.viewerIsAdmin) {
        destinationFolders = folders.filter(
          ({ id: folderId }) => folderId !== access.folderId,
        );
      }
    }

    const scheduled = detailRecord
      ? await getScheduledEnvelopeDeletion(id, getDb())
      : null;

    scheduledDeletion = scheduled
      ? {
          deleteOnLabel: deletionDateFormatter.format(
            new Date(scheduled.deleteAfter * 1000),
          ),
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
      destinationFolders={destinationFolders}
      envelopeId={id}
      folder={folder}
      initialState={initialState}
      key={id}
      ownerLabel={ownerLabel}
      ownerListView={canDeleteFinished ? "all" : "team"}
      record={detailRecord ?? undefined}
      scheduledDeletion={scheduledDeletion}
    />
  );
}

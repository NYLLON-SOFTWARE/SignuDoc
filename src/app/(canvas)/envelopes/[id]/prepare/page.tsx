import { notFound, redirect } from "next/navigation";

import { PrepareLiveShell } from "@/components/envelopes/prepare-live-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { resolveEnvelopeViewerAccess } from "@/lib/envelope-access";
import { getPrepareEnvelopeDataForUser } from "@/lib/envelopes";

type PrepareEnvelopePageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function PrepareEnvelopePage({
  params,
}: PrepareEnvelopePageProps) {
  const { id } = await params;
  let record: Awaited<ReturnType<typeof getPrepareEnvelopeDataForUser>> = null;
  let initialState: "error" | undefined;
  const session = await getAuthSession();

  try {
    const database = getDb();
    record =
      session &&
      (await resolveEnvelopeViewerAccess(session.user.id, id, database))
        ?.viewerIsOwner
        ? await getPrepareEnvelopeDataForUser(session.user.id, id, {
            database,
          })
        : null;
  } catch {
    initialState = "error";
  }

  if (!initialState) {
    if (!record) {
      notFound();
    }

    if (record.status !== "draft") {
      redirect(`/envelopes/${id}`);
    }

    if (record.signers.length === 0) {
      redirect(`/envelopes/${id}/signers`);
    }
  }

  return (
    <PrepareLiveShell
      envelopeId={id}
      initialState={initialState}
      key={id}
      record={record ?? undefined}
    />
  );
}

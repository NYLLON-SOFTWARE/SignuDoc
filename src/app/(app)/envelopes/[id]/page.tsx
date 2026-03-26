import { EnvelopeDetailShell } from "@/components/envelopes/envelope-detail-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
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

  try {
    const session = await getAuthSession();
    detailRecord = session
      ? await getEnvelopeDetailDataForUser(session.user.id, id, getDb())
      : null;
    initialState = detailRecord ? undefined : "not-found";
  } catch {
    initialState = "error";
  }

  return (
    <EnvelopeDetailShell
      envelopeId={id}
      initialState={initialState}
      key={id}
      record={detailRecord ?? undefined}
    />
  );
}

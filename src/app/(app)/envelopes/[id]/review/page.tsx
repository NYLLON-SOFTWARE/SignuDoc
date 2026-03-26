import { notFound, redirect } from "next/navigation";

import { ReviewShell } from "@/components/envelopes/review-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { getReviewEnvelopeDataForUser } from "@/lib/envelopes";

type ReviewPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function ReviewPage({ params }: ReviewPageProps) {
  const { id } = await params;
  let reviewRecord: Awaited<ReturnType<typeof getReviewEnvelopeDataForUser>> =
    null;
  let initialState: "error" | undefined;

  try {
    const session = await getAuthSession();
    const database = getDb();

    reviewRecord = session
      ? await getReviewEnvelopeDataForUser(session.user.id, id, database)
      : null;
  } catch {
    initialState = "error";
  }

  if (!initialState) {
    if (!reviewRecord) {
      notFound();
    }

    if (reviewRecord.status !== "draft") {
      redirect(`/envelopes/${id}`);
    }
  }

  return (
    <ReviewShell
      envelopeId={id}
      initialState={initialState}
      key={id}
      record={reviewRecord ?? undefined}
    />
  );
}

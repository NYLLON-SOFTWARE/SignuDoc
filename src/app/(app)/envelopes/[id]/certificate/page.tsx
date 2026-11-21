import { redirect } from "next/navigation";

import { getAuthSession } from "@/lib/auth/server";

type CertificatePageProps = {
  params: Promise<{
    id: string;
  }>;
};

// Links from outside the app, such as a Slack message's "View certificate",
// come here rather than to the download route, so that someone whose session
// has run out is asked to sign in instead of being shown an API error.
export default async function CertificatePage({
  params,
}: CertificatePageProps) {
  const { id } = await params;
  const session = await getAuthSession();

  if (!session) {
    redirect("/login");
  }

  redirect(`/api/envelopes/${encodeURIComponent(id)}/download?type=evidence`);
}

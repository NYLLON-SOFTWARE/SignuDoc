import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { listEnvelopesForUser } from "@/lib/envelopes";

export default async function DashboardPage() {
  const session = await getAuthSession();
  const database = getDb();
  let envelopes: Awaited<ReturnType<typeof listEnvelopesForUser>> | undefined;
  let initialState: "default" | "empty" | "error" = "error";

  try {
    envelopes = session
      ? await listEnvelopesForUser(session.user.id, {}, database)
      : [];
    initialState = envelopes.length === 0 ? "empty" : "default";
  } catch {
    initialState = "error";
  }

  return <DashboardShell envelopes={envelopes} initialState={initialState} />;
}

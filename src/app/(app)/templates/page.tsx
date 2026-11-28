import { notFound } from "next/navigation";

import { TemplatesShell } from "@/components/templates/templates-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { listFoldersForUser } from "@/lib/teams";
import { listTemplatesForUser } from "@/lib/templates";

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string | string[] }>;
}) {
  const { folder } = await searchParams;
  const folderId = Array.isArray(folder) ? folder[0] : folder;
  let selectedFolder: { id: string; name: string } | undefined;
  let templates: Awaited<ReturnType<typeof listTemplatesForUser>> = [];
  let initialState: "error" | undefined;

  try {
    const session = await getAuthSession();

    if (session) {
      const database = getDb();
      const [availableTemplates, folders] = await Promise.all([
        listTemplatesForUser(session.user.id, database),
        folderId ? listFoldersForUser(session.user.id, database) : [],
      ]);
      templates = availableTemplates;
      selectedFolder = folders.find(({ id }) => id === folderId);
    }
  } catch {
    initialState = "error";
  }

  if (!initialState && folderId && !selectedFolder) notFound();

  return (
    <TemplatesShell
      folder={selectedFolder}
      initialState={initialState}
      templates={templates}
    />
  );
}

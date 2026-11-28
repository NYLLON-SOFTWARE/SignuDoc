import { notFound } from "next/navigation";

import { UseTemplateShell } from "@/components/templates/use-template-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { listFoldersForUser } from "@/lib/teams";
import { getUseTemplateDataForUser, TemplateError } from "@/lib/templates";

type UseTemplatePageProps = {
  searchParams: Promise<{ folder?: string | string[] }>;
  params: Promise<{
    id: string;
  }>;
};

export default async function UseTemplatePage({
  params,
  searchParams,
}: UseTemplatePageProps) {
  const [{ id }, { folder }] = await Promise.all([params, searchParams]);
  const folderId = Array.isArray(folder) ? folder[0] : folder;
  let folders: Awaited<ReturnType<typeof listFoldersForUser>> = [];
  let template: Awaited<ReturnType<typeof getUseTemplateDataForUser>> = null;
  let errorMessage: string | undefined;
  let failed = false;

  try {
    const session = await getAuthSession();

    if (session) {
      const database = getDb();
      [template, folders] = await Promise.all([
        getUseTemplateDataForUser(session.user.id, id, database),
        listFoldersForUser(session.user.id, database),
      ]);
    }
  } catch (error) {
    failed = true;
    errorMessage = error instanceof TemplateError ? error.message : undefined;
  }

  if (
    !failed &&
    (!template || (folderId && !folders.some(({ id }) => id === folderId)))
  ) {
    notFound();
  }

  return (
    <UseTemplateShell
      errorMessage={errorMessage}
      folders={folders}
      initialFolderId={folderId}
      key={`${id}:${folderId ?? ""}`}
      template={template ?? undefined}
    />
  );
}

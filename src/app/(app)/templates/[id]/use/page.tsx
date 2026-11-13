import { notFound } from "next/navigation";

import { UseTemplateShell } from "@/components/templates/use-template-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import { getUseTemplateDataForUser, TemplateError } from "@/lib/templates";

type UseTemplatePageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function UseTemplatePage({
  params,
}: UseTemplatePageProps) {
  const { id } = await params;
  let template: Awaited<ReturnType<typeof getUseTemplateDataForUser>> = null;
  let errorMessage: string | undefined;
  let failed = false;

  try {
    const session = await getAuthSession();

    template = session
      ? await getUseTemplateDataForUser(session.user.id, id, getDb())
      : null;
  } catch (error) {
    failed = true;
    errorMessage = error instanceof TemplateError ? error.message : undefined;
  }

  if (!failed && !template) {
    notFound();
  }

  return (
    <UseTemplateShell
      errorMessage={errorMessage}
      key={id}
      template={template ?? undefined}
    />
  );
}

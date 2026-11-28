import { notFound } from "next/navigation";

import { UploadShell } from "@/components/envelopes/upload-shell";
import { getAuthSession } from "@/lib/auth/server";
import { supportsDirectUploads } from "@/lib/services/storage";
import { buildPendingUploadPrefix } from "@/lib/services/storage-keys";
import { listFoldersForUser } from "@/lib/teams";

type NewEnvelopePageProps = {
  searchParams: Promise<{ folder?: string | string[] }>;
};

export default async function NewEnvelopePage({
  searchParams,
}: NewEnvelopePageProps) {
  const [session, { folder }] = await Promise.all([
    getAuthSession(),
    searchParams,
  ]);
  const folders = session ? await listFoldersForUser(session.user.id) : [];
  const folderId = Array.isArray(folder) ? folder[0] : folder;

  if (folderId && !folders.some(({ id }) => id === folderId)) notFound();

  return (
    <UploadShell
      directUploadPrefix={
        session && supportsDirectUploads()
          ? buildPendingUploadPrefix(session.user.id)
          : null
      }
      folders={folders}
      initialFolderId={folderId}
      key={folderId ?? "unfiled"}
    />
  );
}

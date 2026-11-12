import { UploadShell } from "@/components/envelopes/upload-shell";
import { getAuthSession } from "@/lib/auth/server";
import { supportsDirectUploads } from "@/lib/services/storage";
import { buildPendingUploadPrefix } from "@/lib/services/storage-keys";

export default async function NewEnvelopePage() {
  // On Vercel Blob the browser sends the PDF straight to storage, into this
  // user's pending folder. With local storage it goes through the app.
  const session = supportsDirectUploads() ? await getAuthSession() : null;

  return (
    <UploadShell
      directUploadPrefix={
        session ? buildPendingUploadPrefix(session.user.id) : null
      }
    />
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocumentThumbnail } from "@/components/shared/document-thumbnail";
import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TemplateListItem } from "@/lib/templates";

type TemplatesShellProps = {
  initialState?: "error";
  templates?: readonly TemplateListItem[];
};

const pageDescription =
  "Documents you send often, with their fields and signing order already in place.";

export function TemplatesShell({
  initialState,
  templates = [],
}: TemplatesShellProps) {
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState<TemplateListItem | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleConfirmDelete() {
    if (!pendingDelete || isDeleting) {
      return;
    }

    setDeleteError(null);
    setIsDeleting(true);

    try {
      const response = await fetch(`/api/templates/${pendingDelete.id}`, {
        method: "DELETE",
      });

      // Already gone is as good as deleted.
      if (!response.ok && response.status !== 404) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;

        setDeleteError(payload?.error ?? "Unable to delete this template.");
        return;
      }

      setPendingDelete(null);
      router.refresh();
    } catch {
      setDeleteError("Unable to delete this template.");
    } finally {
      setIsDeleting(false);
    }
  }

  if (initialState === "error") {
    return (
      <div className="space-y-5">
        <PageHeader description={pageDescription} title="Templates" />
        <StatusPanel
          action={{ href: "/templates", label: "Retry" }}
          description="We couldn't load your templates. Try again in a moment."
          title="Couldn't load templates"
          tone="error"
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader description={pageDescription} title="Templates" />

      {templates.length === 0 ? (
        <section
          className="panel px-6 py-14 sm:py-16"
          data-animate="enter"
          data-animate-delay="1"
        >
          <div className="mx-auto flex max-w-lg flex-col items-center gap-5 text-center">
            <span className="flex h-28 items-center justify-center">
              <DocumentThumbnail title="" />
            </span>
            <div className="space-y-2">
              <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
                No templates yet
              </h2>
              <p className="text-[0.9375rem] leading-6 text-(--secondary)">
                Open any document you have prepared or sent and choose Save as
                template. Next time, you only name the people who sign.
              </p>
            </div>
            <ShellButton href="/dashboard">Go to documents</ShellButton>
          </div>
        </section>
      ) : (
        <section
          className="panel p-5 sm:p-7"
          data-animate="enter"
          data-animate-delay="1"
        >
          <ul className="space-y-3">
            {templates.map((template) => (
              <li
                className="well flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
                key={template.id}
              >
                <div className="min-w-0 space-y-2">
                  <h2 className="truncate text-[1.0625rem] font-extrabold text-(--fg)">
                    {template.name}
                  </h2>
                  <p className="text-sm leading-6 text-(--secondary)">
                    {template.pageCountLabel} · {template.fieldCountLabel} ·
                    Saved {template.createdAtLabel}
                  </p>
                  <ul
                    aria-label={`Signers in ${template.name}`}
                    className="flex flex-wrap gap-2"
                  >
                    {template.roleNames.map((roleName, index) => (
                      <li
                        className="pill pill-neutral"
                        key={`${String(index)}-${roleName}`}
                      >
                        {index + 1}. {roleName}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button
                    aria-label={`Delete the template ${template.name}`}
                    className="btn-quiet btn-quiet-danger min-h-11 px-4"
                    onClick={() => {
                      setDeleteError(null);
                      setPendingDelete(template);
                    }}
                    type="button"
                  >
                    Delete
                  </button>
                  <ShellButton
                    className="min-h-11"
                    href={`/templates/${template.id}/use`}
                  >
                    Use template
                  </ShellButton>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pendingDelete ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !isDeleting) {
              setPendingDelete(null);
            }
          }}
        >
          <DialogContent className="max-w-md sm:p-8" showCloseButton={false}>
            <div className="space-y-4">
              <DialogHeader className="space-y-3">
                <DialogTitle>Delete this template?</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-2 text-sm leading-6 text-(--secondary)">
                    <p>
                      &ldquo;{pendingDelete.name}&rdquo; will be removed for
                      good.
                    </p>
                    <p>Documents you already made from it are not affected.</p>
                  </div>
                </DialogDescription>
              </DialogHeader>

              {deleteError ? (
                <div className="notice notice-danger" role="alert">
                  <p>{deleteError}</p>
                </div>
              ) : null}

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                <ShellButton
                  disabled={isDeleting}
                  onClick={() => setPendingDelete(null)}
                  variant="secondary"
                >
                  Cancel
                </ShellButton>
                <ShellButton
                  loading={isDeleting}
                  onClick={handleConfirmDelete}
                  variant="danger"
                >
                  {isDeleting ? "Deleting..." : "Delete template"}
                </ShellButton>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
